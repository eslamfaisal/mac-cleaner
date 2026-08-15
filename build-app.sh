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
# The runtime bundled here is re-signed with the maintainer's Developer ID,
# notarized, stapled, and then runs with Full Disk Access and deletes files.
# An unverified download would make a poisoned mirror or a MITM on the build
# host into a binary Gatekeeper fully trusts. nodejs.org already ships bin/node
# signed by Node.js Foundation (Team ID HX7739G8FX) and notarized — but lipo
# strips that signature before codesign --force replaces it, so it has to be
# checked HERE, on the exact bytes about to be re-signed.
NODE_TEAM_ID=HX7739G8FX

verify_node() { # $1 = path to a node binary; aborts the build if not authentic
  local bin="$1"
  echo "==> verifying $bin against Apple's notarization records" >&2
  codesign --verify --strict "$bin" 2>/dev/null \
    || { echo "FATAL: $bin has no valid signature — refusing to bundle it" >&2; exit 1; }
  # --strict above proves the bytes are intact; this proves WHOSE they are.
  # Deliberately not `spctl -a -t exec`: that assesses app bundles and rejects
  # a bare executable with "the code is valid but does not seem to be an app",
  # which would abort every build. The anchor + Team ID requirement is the
  # check that actually distinguishes the official binary from a swapped one.
  codesign -v -R "=anchor apple generic and certificate leaf[subject.OU] = $NODE_TEAM_ID" "$bin" 2>/dev/null \
    || { echo "FATAL: $bin is not signed by Node.js Foundation ($NODE_TEAM_ID) — refusing to bundle it" >&2; exit 1; }
  echo "    node signature ok (Node.js Foundation, Apple-anchored)" >&2
}

fetch_node() { # $1 = darwin-arm64 | darwin-x64  → prints path to node binary
  local dist_arch="$1"
  local cache=".node-cache/node-$NODE_DIST_VERSION-$dist_arch"
  if [ ! -x "$cache/bin/node" ]; then
    echo "==> fetching official Node $NODE_DIST_VERSION ($dist_arch) from nodejs.org" >&2
    mkdir -p .node-cache
    # to a file, not a pipe: a truncated stream must fail here rather than
    # leave a half-extracted tree behind. --proto-redir because --proto
    # constrains only the first request, not what a redirect points at.
    local tmp; tmp="$(mktemp -t node-dist)"
    curl -fL --proto '=https' --proto-redir '=https' \
      "https://nodejs.org/dist/$NODE_DIST_VERSION/node-$NODE_DIST_VERSION-$dist_arch.tar.xz" -o "$tmp" \
      || { rm -f "$tmp"; echo "FATAL: could not download Node $NODE_DIST_VERSION ($dist_arch)" >&2; exit 1; }
    tar -xJf "$tmp" -C .node-cache || { rm -f "$tmp"; echo "FATAL: could not extract the Node tarball" >&2; exit 1; }
    rm -f "$tmp"
  fi
  # OUTSIDE the cache check on purpose: a binary cached by an earlier build
  # (or a partial extract) is re-verified on every build, not trusted forever.
  verify_node "$cache/bin/node"
  echo "$cache/bin/node"
}

# A user-supplied NODE_BIN is only usable if self-contained (Homebrew's node
# links dylibs from the Cellar that don't exist on end-user machines).
portable_node_or_empty() { # $1 = required arch (arm64 | x86_64)
  local want="$1"
  local bin="${NODE_BIN:-}"
  [ -n "$bin" ] && [ -x "$bin" ] || { echo ""; return; }
  local resolved; resolved="$(readlink -f "$bin")"
  if otool -L "$resolved" | tail -n +2 | grep -qE '@rpath|/opt/homebrew|/usr/local/(Cellar|opt)'; then
    echo ""
    return
  fi
  # An explicit NODE_BIN of the wrong architecture is a mistake, not a reason
  # to quietly download a different runtime: --arch all with an arm64 NODE_BIN
  # used to ship an arm64 binary inside the Intel DMG. The wrapper is the right
  # arch so the app launches, node dies with "Bad CPU type", and the user gets
  # the 15-second timeout alert.
  if ! lipo -archs "$resolved" | tr ' ' '\n' | grep -qx "$want"; then
    echo "FATAL: NODE_BIN ($bin) has no $want slice (has: $(lipo -archs "$resolved"))" >&2
    exit 1
  fi
  echo "$bin"
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
      local want; [ "$arch" = arm64 ] && want=arm64 || want=x86_64
      local node_bin; node_bin="$(portable_node_or_empty "$want")"
      if [ -z "$node_bin" ]; then
        [ "$arch" = arm64 ] && node_bin="$(fetch_node darwin-arm64)" || node_bin="$(fetch_node darwin-x64)"
      fi
      cp "$node_bin" "$app/Contents/Resources/node"
      ;;
  esac
  chmod 755 "$app/Contents/Resources/node"
  # Assert rather than report. Arch-source-agnostic, so it also covers the
  # universal branch and anything added later: every slice the wrapper has must
  # exist in the runtime, or the DMG launches and then dies on "Bad CPU type".
  local node_slices app_slices
  node_slices="$(lipo -archs "$app/Contents/Resources/node")"
  app_slices="$(lipo -archs "$app/Contents/MacOS/Mac Cleaner")"
  echo "    node slices: $node_slices"
  echo "    app  slices: $app_slices"
  for a in $app_slices; do
    echo "$node_slices" | tr ' ' '\n' | grep -qx "$a" \
      || { echo "FATAL: wrapper has a $a slice but the bundled node does not ($node_slices)" >&2; exit 1; }
  done

  echo "==> codesign"
  # Sign inside-out: nested code first, bundle last. --deep is deprecated and
  # cannot apply per-binary entitlements, which the bundled node needs.
  local sign_flags=(--force --options runtime)
  # Secure timestamps need a real identity (and the network); ad-hoc can't have one.
  [ "$SIGN_ID" != "-" ] && sign_flags+=(--timestamp)
  codesign "${sign_flags[@]}" --entitlements app/entitlements-node.plist \
    -s "$SIGN_ID" "$app/Contents/Resources/node"
  codesign "${sign_flags[@]}" -s "$SIGN_ID" "$app"
  codesign --verify --strict --deep "$app" && echo "    signature ok"

  # Notarize the .app and staple the ticket into the bundle *before* it goes in
  # the DMG, so the app still validates when copied out of the DMG or launched
  # offline. The DMG itself is notarized separately below.
  if [ "$SIGN_ID" != "-" ] && [ -n "${NOTARY_PROFILE:-}" ]; then
    echo "==> notarizing app"
    local zip="dist/.notarize-$arch.zip"
    ditto -c -k --keepParent "$app" "$zip"
    xcrun notarytool submit "$zip" --keychain-profile "$NOTARY_PROFILE" --wait
    xcrun stapler staple "$app"
    rm -f "$zip"
  fi

  echo "==> DMG ($dmg)"
  local stage="dist/dmg-stage"
  mkdir -p "$stage"
  cp -R "$app" "$stage/"
  ln -s /Applications "$stage/Applications"
  hdiutil create -volname "Mac Cleaner" -srcfolder "$stage" -ov -format UDZO "$dmg" >/dev/null
  rm -rf "$stage"

  # Sign the disk image itself. Stapling a ticket onto an unsigned DMG is not
  # enough — Gatekeeper assesses the .dmg as "no usable signature" when the user
  # opens it. Signing must happen before notarization.
  if [ "$SIGN_ID" != "-" ]; then
    codesign --force --timestamp -s "$SIGN_ID" "$dmg"
    codesign --verify --strict "$dmg" && echo "    DMG signature ok"
  fi

  if [ "$SIGN_ID" != "-" ] && [ -n "${NOTARY_PROFILE:-}" ]; then
    echo "==> notarizing DMG"
    xcrun notarytool submit "$dmg" --keychain-profile "$NOTARY_PROFILE" --wait
    xcrun stapler staple "$dmg"
    xcrun stapler validate "$dmg" && echo "    ticket stapled"
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
  echo "note: ad-hoc signed. macOS 15+ no longer honours right-click → Open; the"
  echo "      first launch needs System Settings → Privacy & Security → Open Anyway."
  echo "      For anything you share, set SIGN_ID and NOTARY_PROFILE instead."
fi
