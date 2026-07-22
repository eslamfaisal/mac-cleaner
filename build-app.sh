#!/bin/bash
# Build "Mac Cleaner.app" and a distributable DMG.
#
# Uses only tools that ship with macOS + Xcode: swiftc, sips, iconutil,
# codesign, hdiutil. End users need nothing installed — the app bundles the
# Node runtime it was built with.
#
# Env overrides:
#   NODE_BIN=/path/to/node   node binary to bundle (default: command -v node)
#   SIGN_ID="Developer ID Application: …"   codesign identity (default: ad-hoc "-")
#   NOTARY_PROFILE=profile   notarytool keychain profile; when set together with
#                            SIGN_ID, the DMG is notarized and stapled.
set -euo pipefail
cd "$(dirname "$0")"

VERSION="$(tr -d '[:space:]' < VERSION)"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
SIGN_ID="${SIGN_ID:--}"
APP="dist/Mac Cleaner.app"
DMG="dist/Mac.Cleaner.dmg"

[ -x "$NODE_BIN" ] || { echo "error: node binary not found (set NODE_BIN)"; exit 1; }

# The bundled node must be self-contained. Homebrew's node links dylibs from
# the Cellar (@rpath/libnode…), which do not exist on end-user machines — in
# that case fetch the official standalone build from nodejs.org (cached).
NODE_DIST_VERSION="${NODE_DIST_VERSION:-v22.12.0}"
resolved_node="$(readlink -f "$NODE_BIN")"
if otool -L "$resolved_node" | tail -n +2 | grep -qE '@rpath|/opt/homebrew|/usr/local/(Cellar|opt)'; then
  case "$(uname -m)" in
    arm64) dist_arch=darwin-arm64 ;;
    *)     dist_arch=darwin-x64 ;;
  esac
  cache=".node-cache/node-$NODE_DIST_VERSION-$dist_arch"
  if [ ! -x "$cache/bin/node" ]; then
    echo "==> local node is not portable; fetching official Node $NODE_DIST_VERSION ($dist_arch) from nodejs.org"
    mkdir -p .node-cache
    curl -fL --proto '=https' "https://nodejs.org/dist/$NODE_DIST_VERSION/node-$NODE_DIST_VERSION-$dist_arch.tar.xz" \
      | tar -xJ -C .node-cache
  fi
  NODE_BIN="$cache/bin/node"
fi
echo "==> Mac Cleaner v$VERSION (node: $NODE_BIN, sign: $SIGN_ID)"

rm -rf dist
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/server"

echo "==> compiling Swift wrapper"
swiftc -O -o "$APP/Contents/MacOS/Mac Cleaner" app/main.swift

echo "==> Info.plist"
sed "s/@VERSION@/$VERSION/g" app/Info.plist.in > "$APP/Contents/Info.plist"

echo "==> icon"
ICONSET="dist/AppIcon.iconset"
mkdir -p "$ICONSET"
for s in 16 32 64 128 256 512 1024; do
  sips -z "$s" "$s" app/icon.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
done
mv "$ICONSET/icon_1024x1024.png" "$ICONSET/icon_512x512@2x.png"
cp "$ICONSET/icon_64x64.png"  "$ICONSET/icon_32x32@2x.png"
cp "$ICONSET/icon_256x256.png" "$ICONSET/icon_128x128@2x.png"
cp "$ICONSET/icon_512x512.png" "$ICONSET/icon_256x256@2x.png"
cp "$ICONSET/icon_32x32.png"  "$ICONSET/icon_16x16@2x.png"
rm "$ICONSET/icon_64x64.png"
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
rm -rf "$ICONSET"

echo "==> server files"
cp server.js package.json VERSION "$APP/Contents/Resources/server/"
cp -R lib public "$APP/Contents/Resources/server/"

echo "==> bundling node runtime ($(du -h "$NODE_BIN" | cut -f1 | tr -d ' '))"
cp "$NODE_BIN" "$APP/Contents/Resources/node"
chmod 755 "$APP/Contents/Resources/node"

echo "==> codesign"
codesign --force --deep --options runtime -s "$SIGN_ID" "$APP" 2>/dev/null \
  || codesign --force --deep -s "$SIGN_ID" "$APP"
codesign --verify --deep "$APP" && echo "    signature ok"

echo "==> DMG"
STAGE="dist/dmg-stage"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Mac Cleaner" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE"

if [ "$SIGN_ID" != "-" ] && [ -n "${NOTARY_PROFILE:-}" ]; then
  echo "==> notarizing"
  xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$DMG"
fi

echo "==> done"
du -sh "$APP" "$DMG"
if [ "$SIGN_ID" = "-" ]; then
  echo "note: ad-hoc signed — downloaders must right-click → Open the first launch."
fi
