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

# Load local upload creds (ASC_KEY_ID / ASC_ISSUER_ID) from a gitignored .env so
# `--upload` works without exporting them each time. See .env.example.
if [ -f "$REPO_ROOT/.env" ]; then
  set -a
  . "$REPO_ROOT/.env"
  set +a
fi

WEB_DIR="$REPO_ROOT/packages/web"
IOS_APP_DIR="$WEB_DIR/ios/App"
SCHEME="App"
# Capacitor with SPM has no .xcworkspace (just App.xcodeproj); CocoaPods setups do.
if [ -d "$IOS_APP_DIR/App.xcworkspace" ]; then
  XCODE_CONTAINER=(-workspace "$IOS_APP_DIR/App.xcworkspace")
else
  XCODE_CONTAINER=(-project "$IOS_APP_DIR/App.xcodeproj")
fi
TEAM_ID="9DQ459HAZB"
OUT_DIR="${REMI_ARCHIVE_DIR:-$REPO_ROOT/build/ios}"

# When the ASC API key is available, hand it to xcodebuild so automatic signing
# can register the App ID and create the App Store distribution profile headlessly
# (without it, -exportArchive fails "No Accounts / No profiles found"). Same key
# altool uses for the upload.
AUTH_ARGS=()
if [ -n "${ASC_KEY_ID:-}" ] && [ -n "${ASC_ISSUER_ID:-}" ]; then
  AUTH_KEY_PATH="$HOME/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8"
  if [ -f "$AUTH_KEY_PATH" ]; then
    AUTH_ARGS=(
      -authenticationKeyPath "$AUTH_KEY_PATH"
      -authenticationKeyID "$ASC_KEY_ID"
      -authenticationKeyIssuerID "$ASC_ISSUER_ID"
    )
  fi
fi

DO_UPLOAD=false
for arg in "$@"; do
  case "$arg" in
    --upload) DO_UPLOAD=true ;;
    *) echo "ERROR: unknown argument: $arg (usage: testflight-ios.sh [--upload])" >&2; exit 1 ;;
  esac
done

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
  "${XCODE_CONTAINER[@]}"
  -scheme "$SCHEME"
  -configuration Release
  -destination "generic/platform=iOS"
  -archivePath "$ARCHIVE_PATH"
  -allowProvisioningUpdates
  "${AUTH_ARGS[@]}"
  -skipPackagePluginValidation
  CODE_SIGN_STYLE=Automatic
  DEVELOPMENT_TEAM="$TEAM_ID")
if command -v xcpretty >/dev/null 2>&1; then
  # Isolate xcodebuild's exit from xcpretty's: a flaky xcpretty must not abort a
  # good archive, and a failed xcodebuild must still abort.
  set +e
  "${ARCHIVE_CMD[@]}" | xcpretty
  XCODE_EXIT=${PIPESTATUS[0]}
  set -e
  [ "$XCODE_EXIT" -eq 0 ] || { echo "ERROR: xcodebuild archive failed (exit $XCODE_EXIT)" >&2; exit "$XCODE_EXIT"; }
else
  "${ARCHIVE_CMD[@]}"
fi
[ -d "$ARCHIVE_PATH" ] || { echo "ERROR: archive not created at $ARCHIVE_PATH" >&2; exit 1; }

echo "[4/5] Exporting App Store .ipa"
EXPORT_OPTIONS=$(mktemp /tmp/remi-ExportOptions.XXXXXX.plist)
trap 'rm -f "$EXPORT_OPTIONS"' EXIT
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
  -allowProvisioningUpdates \
  "${AUTH_ARGS[@]}"

IPA_COUNT=$(find "$EXPORT_PATH" -maxdepth 1 -name '*.ipa' | wc -l | tr -d ' ')
if [ "$IPA_COUNT" -eq 0 ]; then
  echo "ERROR: no .ipa produced in $EXPORT_PATH" >&2
  exit 1
elif [ "$IPA_COUNT" -gt 1 ]; then
  echo "ERROR: multiple .ipa files in $EXPORT_PATH — refusing to guess which to upload:" >&2
  find "$EXPORT_PATH" -maxdepth 1 -name '*.ipa' >&2
  exit 1
fi
IPA=$(find "$EXPORT_PATH" -maxdepth 1 -name '*.ipa')
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
