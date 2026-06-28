#!/bin/bash
# Local iOS TestFlight build + upload for Remi (#659).
#
# The LOCAL path (mirrors yooz-whisper/scripts/testflight-release.sh) — no Xcode
# Cloud. Builds the web app, syncs Capacitor, archives the iOS workspace, exports
# an App Store .ipa, and (with --upload) sends it to TestFlight via altool.
#
# Usage:
#   ./scripts/testflight-ios.sh            # build + archive + export the .ipa
#   ./scripts/testflight-ios.sh --upload   # also upload to TestFlight
#
# Version comes from config/app-release.json. Bump the build before each upload
# (App Store Connect rejects duplicate build numbers):
#   bun run app:version --bump-build      # commit the result
# or for a one-off unique build: REMI_BUILD_NUMBER=$(date +%y%m%d%H%M) ...
#
# --upload prerequisites:
#   - App Store Connect API key at ~/.appstoreconnect/private_keys/AuthKey_<KEYID>.p8
#   - export ASC_KEY_ID=<KEYID>  ASC_ISSUER_ID=<issuer-uuid>
#   - an Apple Distribution certificate in your login keychain (automatic signing)
set -eo pipefail

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
WEB_DIR="$REPO_ROOT/packages/web"
WORKSPACE="$WEB_DIR/ios/App/App.xcworkspace"
SCHEME="App"
TEAM_ID="9DQ459HAZB"
OUT_DIR="${REMI_ARCHIVE_DIR:-$REPO_ROOT/build/ios}"

DO_UPLOAD=false
[ "${1:-}" = "--upload" ] && DO_UPLOAD=true

command -v bun >/dev/null 2>&1 || { echo "ERROR: bun not found" >&2; exit 1; }
command -v xcodebuild >/dev/null 2>&1 || { echo "ERROR: xcodebuild not found (install Xcode)" >&2; exit 1; }

# --- Version ---------------------------------------------------------------
CONFIG="$REPO_ROOT/config/app-release.json"
MARKETING=$(sed -nE 's/.*"marketingVersion"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$CONFIG")
BUILD="${REMI_BUILD_NUMBER:-$(sed -nE 's/.*"buildNumber"[[:space:]]*:[[:space:]]*([0-9]+).*/\1/p' "$CONFIG")}"
[ -n "$MARKETING" ] && [ -n "$BUILD" ] || { echo "ERROR: could not read version from $CONFIG" >&2; exit 1; }

echo "=========================================="
echo "Remi iOS TestFlight: v${MARKETING} (build ${BUILD})"
echo "=========================================="

echo "[1/5] Stamping app version into the Xcode project"
bun "$REPO_ROOT/scripts/sync-app-version.mjs" --build "$BUILD"

echo "[2/5] Building web app + Capacitor sync"
cd "$WEB_DIR"
bun run build
bunx cap sync ios

ARCHIVE_PATH="$OUT_DIR/Remi-${MARKETING}-build${BUILD}.xcarchive"
EXPORT_PATH="$OUT_DIR/Remi-${MARKETING}-build${BUILD}-AppStore"
mkdir -p "$OUT_DIR"

echo "[3/5] Archiving (Release, generic/platform=iOS)"
ARCHIVE_CMD=(xcodebuild clean archive
  -workspace "$WORKSPACE"
  -scheme "$SCHEME"
  -configuration Release
  -destination "generic/platform=iOS"
  -archivePath "$ARCHIVE_PATH"
  -allowProvisioningUpdates
  -skipPackagePluginValidation
  CODE_SIGN_STYLE=Automatic
  DEVELOPMENT_TEAM="$TEAM_ID")
if command -v xcpretty >/dev/null 2>&1; then
  "${ARCHIVE_CMD[@]}" | xcpretty
else
  "${ARCHIVE_CMD[@]}"
fi
[ -d "$ARCHIVE_PATH" ] || { echo "ERROR: archive not created at $ARCHIVE_PATH" >&2; exit 1; }

echo "[4/5] Exporting App Store .ipa"
EXPORT_OPTIONS=$(mktemp /tmp/remi-ExportOptions.XXXXXX.plist)
cat > "$EXPORT_OPTIONS" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key>
    <string>app-store-connect</string>
    <key>destination</key>
    <string>export</string>
    <key>signingStyle</key>
    <string>automatic</string>
    <key>teamID</key>
    <string>${TEAM_ID}</string>
</dict>
</plist>
EOF
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE_PATH" \
  -exportOptionsPlist "$EXPORT_OPTIONS" \
  -exportPath "$EXPORT_PATH" \
  -allowProvisioningUpdates
rm -f "$EXPORT_OPTIONS"

IPA=$(ls "$EXPORT_PATH"/*.ipa 2>/dev/null | head -1 || true)
[ -n "$IPA" ] && [ -f "$IPA" ] || { echo "ERROR: no .ipa produced in $EXPORT_PATH" >&2; exit 1; }
echo "Exported: $IPA"

echo "[5/5] Upload"
if [ "$DO_UPLOAD" = true ]; then
  [ -n "${ASC_KEY_ID:-}" ] && [ -n "${ASC_ISSUER_ID:-}" ] || {
    echo "ERROR: set ASC_KEY_ID and ASC_ISSUER_ID (and place AuthKey_<KEYID>.p8 in ~/.appstoreconnect/private_keys/)" >&2
    exit 1
  }
  xcrun altool --upload-app -f "$IPA" -t ios --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"
  echo "Uploaded to TestFlight. Bump the build before the next upload: bun run app:version --bump-build"
else
  echo "Skipped (no --upload). The .ipa is ready at:"
  echo "  $IPA"
  echo "Upload it via: ./scripts/testflight-ios.sh --upload   (or Transporter / Xcode Organizer)"
fi
