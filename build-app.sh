#!/bin/bash
# Build "Mac Cleaner.app" and a distributable DMG.
#
# Uses only tools that ship with macOS + Xcode: swiftc, lipo, sips, iconutil,
# codesign, hdiutil. End users need nothing installed — the app bundles the
# Node runtime it was built with.
#
# By default this produces a UNIVERSAL app (arm64 + x86_64 in one binary):
# the Swift wrapper is compiled for both architectures and merged with lipo,
# and the bundled Node runtime is a fat binary fused from the official
# nodejs.org darwin-arm64 and darwin-x64 builds. One DMG runs natively on
# Apple Silicon and Intel Macs.
#
# Usage:
#   ./build-app.sh                 # universal (recommended for releases)
#   ./build-app.sh --arch arm64    # Apple Silicon-only (smaller download)
#   ./build-app.sh --arch x64      # Intel-only (smaller download)
#   ./build-app.sh --arch all      # universal + both single-arch DMGs
#
# Env overrides:
#   NODE_DIST_VERSION=v22.12.0     official Node version to bundle
#   NODE_BIN=/path/to/node         (single-arch builds only) node binary to
#                                  bundle instead of fetching from nodejs.org
#   SIGN_ID="Developer ID Application: …"   codesign identity (default: ad-hoc "-")
#   NOTARY_PROFILE=profile         notarytool keychain profile; when set together
#                                  with SIGN_ID, DMGs are notarized and stapled.
set -euo pipefail
cd "$(dirname "$0")"

VERSION="$(tr -d '[:space:]' < VERSION)"
SIGN_ID="${SIGN_ID:--}"
NODE_DIST_VERSION="${NODE_DIST_VERSION:-v22.12.0}"
MACOS_MIN=12

ARCH=universal
while [ $# -gt 0 ]; do
  case "$1" in
    --arch) ARCH="$2"; shift 2 ;;
    *) echo "unknown arg: $1"; exit 1 ;;
  esac
done
case "$ARCH" in universal|arm64|x64|all) ;; *) echo "error: --arch must be universal, arm64, x64 or all"; exit 1 ;; esac

# ---------------------------------------------------------------- node fetch
# Official standalone builds from nodejs.org are fully portable (no Homebrew
# dylibs). Cached in .node-cache/.
fetch_node() { # $1 = darwin-arm64 | darwin-x64  → prints path to node binary
  local dist_arch="$1"
  local cache=".node-cache/node-$NODE_DIST_VERSION-$dist_arch"
  if [ ! -x "$cache/bin/node" ]; then
    echo "==> fetching official Node $NODE_DIST_VERSION ($dist_arch) from nodejs.org" >&2
    mkdir -p .node-cache
    curl -fL --proto '=https' "https://nodejs.org/dist/$NODE_DIST_VERSION/node-$NODE_DIST_VERSION-$dist_arch.tar.xz" \
      | tar -xJ -C .node-cache
  fi
  echo "$cache/bin/node"
}

# A user-supplied NODE_BIN is only usable if self-contained (Homebrew's node
# links dylibs from the Cellar that don't exist on end-user machines).
portable_node_or_empty() {
  local bin="${NODE_BIN:-}"
  [ -n "$bin" ] && [ -x "$bin" ] || { echo ""; return; }
  local resolved; resolved="$(readlink -f "$bin")"
  if otool -L "$resolved" | tail -n +2 | grep -qE '@rpath|/opt/homebrew|/usr/local/(Cellar|opt)'; then
    echo ""
  else
    echo "$bin"
  fi
}

# ---------------------------------------------------------------- build one app
build_app() { # $1 = universal | arm64 | x64
  local arch="$1"
  local app="dist/Mac Cleaner.app"
  local dmg
  case "$arch" in
    universal) dmg="dist/Mac.Cleaner.dmg" ;;
    arm64)     dmg="dist/Mac.Cleaner-AppleSilicon.dmg" ;;
    x64)       dmg="dist/Mac.Cleaner-Intel.dmg" ;;
  esac

  echo "==> Mac Cleaner v$VERSION [$arch] (sign: $SIGN_ID)"
  rm -rf "$app"
  mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources/server"

  echo "==> compiling Swift wrapper ($arch)"
  case "$arch" in
    universal)
      swiftc -O -target "arm64-apple-macos$MACOS_MIN"  -o dist/.wrapper-arm64 app/main.swift
      swiftc -O -target "x86_64-apple-macos$MACOS_MIN" -o dist/.wrapper-x64   app/main.swift
      lipo -create dist/.wrapper-arm64 dist/.wrapper-x64 -output "$app/Contents/MacOS/Mac Cleaner"
      rm -f dist/.wrapper-arm64 dist/.wrapper-x64
      ;;
    arm64) swiftc -O -target "arm64-apple-macos$MACOS_MIN"  -o "$app/Contents/MacOS/Mac Cleaner" app/main.swift ;;
    x64)   swiftc -O -target "x86_64-apple-macos$MACOS_MIN" -o "$app/Contents/MacOS/Mac Cleaner" app/main.swift ;;
  esac

  echo "==> Info.plist"
  sed "s/@VERSION@/$VERSION/g" app/Info.plist.in > "$app/Contents/Info.plist"

  echo "==> icon"
  local iconset="dist/AppIcon.iconset"
  mkdir -p "$iconset"
  for s in 16 32 64 128 256 512 1024; do
    sips -z "$s" "$s" app/icon.png --out "$iconset/icon_${s}x${s}.png" >/dev/null
  done
  mv "$iconset/icon_1024x1024.png" "$iconset/icon_512x512@2x.png"
  cp "$iconset/icon_64x64.png"  "$iconset/icon_32x32@2x.png"
  cp "$iconset/icon_256x256.png" "$iconset/icon_128x128@2x.png"
  cp "$iconset/icon_512x512.png" "$iconset/icon_256x256@2x.png"
  cp "$iconset/icon_32x32.png"  "$iconset/icon_16x16@2x.png"
  rm "$iconset/icon_64x64.png"
  iconutil -c icns "$iconset" -o "$app/Contents/Resources/AppIcon.icns"
  rm -rf "$iconset"

  echo "==> server files"
  cp server.js package.json VERSION "$app/Contents/Resources/server/"
  cp -R lib public "$app/Contents/Resources/server/"

  echo "==> bundling node runtime ($arch)"
  case "$arch" in
    universal)
      local n_arm n_x64
      n_arm="$(fetch_node darwin-arm64)"
      n_x64="$(fetch_node darwin-x64)"
      lipo -create "$n_arm" "$n_x64" -output "$app/Contents/Resources/node"
      ;;
    arm64|x64)
      local node_bin; node_bin="$(portable_node_or_empty)"
      if [ -z "$node_bin" ]; then
        [ "$arch" = arm64 ] && node_bin="$(fetch_node darwin-arm64)" || node_bin="$(fetch_node darwin-x64)"
      fi
      cp "$node_bin" "$app/Contents/Resources/node"
      ;;
  esac
  chmod 755 "$app/Contents/Resources/node"
  echo "    node slices: $(lipo -archs "$app/Contents/Resources/node")"
  echo "    app  slices: $(lipo -archs "$app/Contents/MacOS/Mac Cleaner")"

  echo "==> codesign"
  codesign --force --deep --options runtime -s "$SIGN_ID" "$app" 2>/dev/null \
    || codesign --force --deep -s "$SIGN_ID" "$app"
  codesign --verify --deep "$app" && echo "    signature ok"

  echo "==> DMG ($dmg)"
  local stage="dist/dmg-stage"
  mkdir -p "$stage"
  cp -R "$app" "$stage/"
  ln -s /Applications "$stage/Applications"
  hdiutil create -volname "Mac Cleaner" -srcfolder "$stage" -ov -format UDZO "$dmg" >/dev/null
  rm -rf "$stage"

  if [ "$SIGN_ID" != "-" ] && [ -n "${NOTARY_PROFILE:-}" ]; then
    echo "==> notarizing"
    xcrun notarytool submit "$dmg" --keychain-profile "$NOTARY_PROFILE" --wait
    xcrun stapler staple "$dmg"
  fi

  du -sh "$app" "$dmg"
}

rm -rf dist
mkdir -p dist

case "$ARCH" in
  all)
    build_app x64
    build_app arm64
    build_app universal   # last, so dist/Mac Cleaner.app ends up universal
    ;;
  *) build_app "$ARCH" ;;
esac

echo "==> done"
ls -lh dist/*.dmg
if [ "$SIGN_ID" = "-" ]; then
  echo "note: ad-hoc signed — downloaders must right-click → Open the first launch."
fi
