#!/bin/bash
# Local macOS TestFlight build + upload for Remi (#658 phase 2, epic #648).
#
# Mirrors scripts/testflight-ios.sh (the LOCAL path, no Xcode Cloud): stages
# the web UI into the menu-bar app, archives the macOS project, exports a Mac
# App Store .pkg, and (with --upload) sends it to TestFlight via altool.
#
# Usage:
#   ./scripts/testflight-macos.sh            # build + archive + export the .pkg
#   ./scripts/testflight-macos.sh --upload   # also upload to TestFlight
#
# Version comes from config/app-release.json (SHARED with iOS; ASC build
# trains are per-platform so one counter is safe). Bump before each upload:
#   bun run app:version --bump-build      # commit the result
#
# --upload prerequisites:
#   - App Store Connect API key at ~/.appstoreconnect/private_keys/AuthKey_<KEYID>.p8
#   - export ASC_KEY_ID=<KEYID>  ASC_ISSUER_ID=<issuer-uuid>  (or .env)
#   - macOS platform added to the live.yooz.remi app record in App Store Connect
#   - "Apple Distribution" AND "Mac Installer Distribution" certificates in the
#     login keychain — the second one signs the .pkg and is the one credential
#     iOS never needed (create in Xcode Settings > Accounts or developer.apple.com)
set -eo pipefail

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

# Load local upload creds (ASC_KEY_ID / ASC_ISSUER_ID) from a gitignored .env so
# `--upload` works without exporting them each time. See .env.example.
if [ -f "$REPO_ROOT/.env" ]; then
  set -a
  . "$REPO_ROOT/.env"
  set +a
fi

MACOS_DIR="$REPO_ROOT/packages/macos"
SCHEME="Remi"
TEAM_ID="9DQ459HAZB"
OUT_DIR="${REMI_ARCHIVE_DIR:-$REPO_ROOT/build/macos}"

# When the ASC API key is available, hand it to xcodebuild so automatic signing
# can register the App ID and create the Mac App Store distribution profile
# headlessly. Same key altool uses for the upload.
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
    *) echo "ERROR: unknown argument: $arg (usage: testflight-macos.sh [--upload])" >&2; exit 1 ;;
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
echo "Remi macOS TestFlight: v${MARKETING} (build ${BUILD})"
echo "=========================================="

echo "[1/5] Stamping app version into the Xcode projects"
bun "$REPO_ROOT/scripts/sync-app-version.mjs" --build "$BUILD"

echo "[2/5] Building + staging the web UI into the app"
(cd "$REPO_ROOT" && bun run build:macos-web)

ARCHIVE_PATH="$OUT_DIR/Remi-macOS-${MARKETING}-build${BUILD}.xcarchive"
EXPORT_PATH="$OUT_DIR/Remi-macOS-${MARKETING}-build${BUILD}-AppStore"
mkdir -p "$OUT_DIR"

echo "[3/5] Archiving (Release, generic/platform=macOS)"
ARCHIVE_CMD=(xcodebuild clean archive
  -project "$MACOS_DIR/Remi.xcodeproj"
  -scheme "$SCHEME"
  -configuration Release
  -destination "generic/platform=macOS"
  -archivePath "$ARCHIVE_PATH"
  -allowProvisioningUpdates
  "${AUTH_ARGS[@]}"
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

echo "[4/5] Exporting Mac App Store .pkg"
EXPORT_OPTIONS=$(mktemp /tmp/remi-macos-ExportOptions.XXXXXX.plist)
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

# Mac App Store export produces a signed .pkg (not an .ipa).
PKG_COUNT=$(find "$EXPORT_PATH" -maxdepth 1 -name '*.pkg' | wc -l | tr -d ' ')
if [ "$PKG_COUNT" -eq 0 ]; then
  echo "ERROR: no .pkg produced in $EXPORT_PATH" >&2
  echo "(A missing 'Mac Installer Distribution' certificate is the usual cause.)" >&2
  exit 1
elif [ "$PKG_COUNT" -gt 1 ]; then
  echo "ERROR: multiple .pkg files in $EXPORT_PATH — refusing to guess which to upload:" >&2
  find "$EXPORT_PATH" -maxdepth 1 -name '*.pkg' >&2
  exit 1
fi
PKG=$(find "$EXPORT_PATH" -maxdepth 1 -name '*.pkg')
echo "Exported: $PKG"

echo "[5/5] Upload"
if [ "$DO_UPLOAD" = true ]; then
  [ -n "${ASC_KEY_ID:-}" ] && [ -n "${ASC_ISSUER_ID:-}" ] || {
    echo "ERROR: set ASC_KEY_ID and ASC_ISSUER_ID (and place AuthKey_<KEYID>.p8 in ~/.appstoreconnect/private_keys/)" >&2
    exit 1
  }
  xcrun altool --upload-app -f "$PKG" -t macos --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"
  echo "Uploaded to TestFlight (macOS). Bump the build before the next upload: bun run app:version --bump-build"
else
  echo "Skipped (no --upload). The .pkg is ready at:"
  echo "  $PKG"
  echo "Upload it via: ./scripts/testflight-macos.sh --upload   (or Transporter)"
fi
