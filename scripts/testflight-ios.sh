#!/bin/bash
# Build, validate, and optionally upload the native Remi iPhone app (#1539).
set -euo pipefail

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PROJECT="$REPO_ROOT/packages/native/Remi.xcodeproj"
SCHEME="RemiPhone"
TEAM_ID="${REMI_APPLE_TEAM_ID:-9DQ459HAZB}"
APP_ID="live.yooz.remi"
EXTENSION_ID="live.yooz.remi.native-push-service"
OUT_DIR="${REMI_ARCHIVE_DIR:-$REPO_ROOT/build/ios-native}"
CONFIG="$REPO_ROOT/config/app-release.json"
DO_UPLOAD=false
PREFLIGHT_ONLY=false
UNSIGNED_ARCHIVE=false

for arg in "$@"; do
  case "$arg" in
    --upload) DO_UPLOAD=true ;;
    --preflight-only) PREFLIGHT_ONLY=true ;;
    --unsigned-archive) UNSIGNED_ARCHIVE=true ;;
    *) echo "ERROR: unknown argument: $arg (usage: testflight-ios.sh [--preflight-only | --unsigned-archive] [--upload])" >&2; exit 1 ;;
  esac
done
[ "$PREFLIGHT_ONLY" = false ] || [ "$DO_UPLOAD" = false ] || { echo "ERROR: --preflight-only cannot upload" >&2; exit 1; }
[ "$UNSIGNED_ARCHIVE" = false ] || [ "$DO_UPLOAD" = false ] || { echo "ERROR: --unsigned-archive cannot upload" >&2; exit 1; }

fail() { echo "ERROR: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "$1 not found"; }
expect_file() { [ -f "$1" ] || fail "missing $2: $1"; }
expect_contains() { grep -Fq "$2" "$1" || fail "$3"; }
plist_value() { /usr/libexec/PlistBuddy -c "Print :$2" "$1" 2>/dev/null || true; }

need git
need xcodebuild
need xcrun
need plutil
need codesign
need unzip
expect_file "$CONFIG" "release config"
expect_file "$PROJECT/project.pbxproj" "native Xcode project"
expect_file "$PROJECT/xcshareddata/xcschemes/$SCHEME.xcscheme" "shared $SCHEME scheme"

echo "[0/7] Validating native store assets"
"$REPO_ROOT/scripts/test-native-store-assets.sh"

MARKETING=$(sed -nE 's/.*"marketingVersion"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$CONFIG")
BUILD="${REMI_BUILD_NUMBER:-$(sed -nE 's/.*"buildNumber"[[:space:]]*:[[:space:]]*([0-9]+).*/\1/p' "$CONFIG")}"
[[ "$MARKETING" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "invalid marketing version in $CONFIG"
[[ "$BUILD" =~ ^[0-9]+$ ]] || fail "invalid build number in $CONFIG"
SOURCE_COMMIT=$(git -C "$REPO_ROOT" rev-parse HEAD)
[[ "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || fail "could not resolve an exact source commit"

PBXPROJ="$PROJECT/project.pbxproj"
SCHEME_FILE="$PROJECT/xcshareddata/xcschemes/$SCHEME.xcscheme"
APP_ENTITLEMENTS="$REPO_ROOT/packages/native/iPhone/Remi.entitlements"
EXTENSION_ENTITLEMENTS="$REPO_ROOT/packages/native/PhonePushService/RemiPush.entitlements"
expect_contains "$PBXPROJ" "PRODUCT_BUNDLE_IDENTIFIER = $APP_ID;" "native Release app bundle ID is not $APP_ID"
expect_contains "$PBXPROJ" "PRODUCT_BUNDLE_IDENTIFIER = \"$EXTENSION_ID\";" "native Release extension bundle ID is not $EXTENSION_ID"
expect_contains "$PBXPROJ" "APNS_ENVIRONMENT = production;" "native project has no production APNS configuration"
expect_contains "$APP_ENTITLEMENTS" "group.live.yooz.remi" "app-group entitlement is missing"
expect_contains "$APP_ENTITLEMENTS" "live.yooz.remi.secure-push" "app push keychain group is missing"
expect_contains "$EXTENSION_ENTITLEMENTS" "live.yooz.remi.secure-push" "extension push keychain group is missing"
expect_contains "$PBXPROJ" "INFOPLIST_KEY_NSCameraUsageDescription" "camera usage description is missing"
expect_contains "$PBXPROJ" "INFOPLIST_KEY_NSLocalNetworkUsageDescription" "local-network usage description is missing"
expect_contains "$SCHEME_FILE" 'buildConfiguration = "Release"' "$SCHEME has no Release archive action"

echo "[1/7] Checking native Release build settings"
OVERRIDES=(MARKETING_VERSION="$MARKETING" CURRENT_PROJECT_VERSION="$BUILD"
  INFOPLIST_KEY_CFBundleDisplayName=Remi REMI_SOURCE_COMMIT="$SOURCE_COMMIT"
  CODE_SIGN_STYLE=Automatic DEVELOPMENT_TEAM="$TEAM_ID")
SETTINGS=$(xcodebuild -project "$PROJECT" -scheme "$SCHEME" -configuration Release \
  -destination 'generic/platform=iOS' -showBuildSettings "${OVERRIDES[@]}")
grep -Fq "PRODUCT_BUNDLE_IDENTIFIER = $APP_ID" <<<"$SETTINGS" || fail "resolved app bundle ID is not $APP_ID"
grep -Fq "MARKETING_VERSION = $MARKETING" <<<"$SETTINGS" || fail "resolved marketing version is not $MARKETING"
grep -Fq "CURRENT_PROJECT_VERSION = $BUILD" <<<"$SETTINGS" || fail "resolved build is not $BUILD"
grep -Fq "INFOPLIST_KEY_CFBundleDisplayName = Remi" <<<"$SETTINGS" || fail "resolved display name is not Remi"
grep -Fq "REMI_PUSH_NAMESPACE = native-release" <<<"$SETTINGS" || fail "Release push namespace is not native-release"

if [ "$PREFLIGHT_ONLY" = true ]; then
  echo "Preflight passed: native $SCHEME $MARKETING ($BUILD), source $SOURCE_COMMIT"
  exit 0
fi

[ -z "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=no)" ] ||
  fail "release archive requires a clean tracked checkout"

if [ -f "$REPO_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$REPO_ROOT/.env"
  set +a
fi
AUTH_ARGS=()
if [ "$UNSIGNED_ARCHIVE" = false ] && [ -n "${ASC_KEY_ID:-}" ] && [ -n "${ASC_ISSUER_ID:-}" ]; then
  AUTH_KEY_PATH="${ASC_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8}"
  expect_file "$AUTH_KEY_PATH" "App Store Connect API key"
  AUTH_ARGS=(-authenticationKeyPath "$AUTH_KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")
fi

ARCHIVE_PATH="$OUT_DIR/Remi-${MARKETING}-build${BUILD}.xcarchive"
EXPORT_PATH="$OUT_DIR/Remi-${MARKETING}-build${BUILD}-AppStore"
mkdir -p "$OUT_DIR"

echo "[2/7] Archiving native $SCHEME"
SIGNING_ARGS=()
if [ "$UNSIGNED_ARCHIVE" = true ]; then
  SIGNING_ARGS=(CODE_SIGNING_ALLOWED=NO)
fi
ARCHIVE_CMD=(xcodebuild clean archive -project "$PROJECT" -scheme "$SCHEME" -configuration Release
  -destination 'generic/platform=iOS' -archivePath "$ARCHIVE_PATH" -allowProvisioningUpdates
  -skipPackagePluginValidation "${OVERRIDES[@]}")
if [ "${#AUTH_ARGS[@]}" -gt 0 ]; then ARCHIVE_CMD+=("${AUTH_ARGS[@]}"); fi
if [ "${#SIGNING_ARGS[@]}" -gt 0 ]; then ARCHIVE_CMD+=("${SIGNING_ARGS[@]}"); fi
"${ARCHIVE_CMD[@]}"
[ -d "$ARCHIVE_PATH" ] || fail "archive not created at $ARCHIVE_PATH"

APP="$ARCHIVE_PATH/Products/Applications/Remi.app"
APP_INFO="$APP/Info.plist"
EXTENSION="$APP/PlugIns/PhonePushService.appex"
expect_file "$APP_INFO" "archived app Info.plist"
expect_file "$APP/PrivacyInfo.xcprivacy" "archived app privacy manifest"
expect_file "$APP/Assets.car" "compiled app assets"
expect_file "$APP/RemiKit_RemiPush.bundle/PrivacyInfo.xcprivacy" "archived app RemiPush privacy manifest"
expect_file "$EXTENSION/RemiKit_RemiPush.bundle/PrivacyInfo.xcprivacy" "archived extension RemiPush privacy manifest"
[ -d "$EXTENSION" ] || fail "PhonePushService.appex is not embedded"
[ "$(plist_value "$APP_INFO" CFBundleIdentifier)" = "$APP_ID" ] || fail "archived app bundle ID mismatch"
[ "$(plist_value "$APP_INFO" CFBundleDisplayName)" = "Remi" ] || fail "archived display name mismatch"
[ "$(plist_value "$APP_INFO" CFBundleShortVersionString)" = "$MARKETING" ] || fail "archived marketing version mismatch"
[ "$(plist_value "$APP_INFO" CFBundleVersion)" = "$BUILD" ] || fail "archived build number mismatch"
[ "$(plist_value "$APP_INFO" RemiSourceCommit)" = "$SOURCE_COMMIT" ] || fail "archived source commit mismatch"
[ "$(plist_value "$EXTENSION/Info.plist" CFBundleIdentifier)" = "$EXTENSION_ID" ] || fail "archived extension bundle ID mismatch"
[ "$(plist_value "$EXTENSION/Info.plist" CFBundleShortVersionString)" = "$MARKETING" ] || fail "extension marketing version mismatch"
[ "$(plist_value "$EXTENSION/Info.plist" CFBundleVersion)" = "$BUILD" ] || fail "extension build number mismatch"
! grep -R -a -q 'live.yooz.remi.dev' "$APP" || fail "development identity leaked into Release archive"

if [ "$UNSIGNED_ARCHIVE" = true ]; then
  RECEIPT="$ARCHIVE_PATH/acceptance-receipt.txt"
  {
    echo "source_commit=$SOURCE_COMMIT"
    echo "scheme=$SCHEME"
    echo "configuration=Release"
    echo "validation=unsigned-archive"
    echo "marketing_version=$MARKETING"
    echo "build_number=$BUILD"
    echo "app_bundle_id=$APP_ID"
    echo "extension_bundle_id=$EXTENSION_ID"
  } > "$RECEIPT"
  echo "Unsigned native archive passed packaging validation: $ARCHIVE_PATH"
  echo "Receipt: $RECEIPT"
  exit 0
fi

echo "[3/7] Verifying archive signing and entitlements"
codesign --verify --deep --strict "$APP" || fail "archived app signature verification failed"
ARCHIVE_ENTITLEMENTS=$(codesign -d --entitlements :- "$APP" 2>/dev/null)
grep -Fq 'group.live.yooz.remi' <<<"$ARCHIVE_ENTITLEMENTS" || fail "signed app is missing its app group"
grep -Fq 'live.yooz.remi.secure-push' <<<"$ARCHIVE_ENTITLEMENTS" || fail "signed app is missing the shared push keychain group"
grep -Fq '<string>production</string>' <<<"$ARCHIVE_ENTITLEMENTS" || fail "signed app is not using production APNS"

echo "[4/7] Exporting App Store IPA"
EXPORT_OPTIONS=$(mktemp /tmp/remi-native-export.XXXXXX.plist)
VERIFY_DIR=""
trap 'rm -f "$EXPORT_OPTIONS"; [ -z "$VERIFY_DIR" ] || rm -rf "$VERIFY_DIR"' EXIT
plutil -create xml1 "$EXPORT_OPTIONS"
plutil -insert method -string app-store-connect "$EXPORT_OPTIONS"
plutil -insert destination -string export "$EXPORT_OPTIONS"
plutil -insert signingStyle -string automatic "$EXPORT_OPTIONS"
plutil -insert teamID -string "$TEAM_ID" "$EXPORT_OPTIONS"
EXPORT_CMD=(xcodebuild -exportArchive -archivePath "$ARCHIVE_PATH"
  -exportOptionsPlist "$EXPORT_OPTIONS" -exportPath "$EXPORT_PATH" -allowProvisioningUpdates)
if [ "${#AUTH_ARGS[@]}" -gt 0 ]; then EXPORT_CMD+=("${AUTH_ARGS[@]}"); fi
"${EXPORT_CMD[@]}"

IPA_COUNT=$(find "$EXPORT_PATH" -maxdepth 1 -type f -name '*.ipa' | wc -l | tr -d ' ')
[ "$IPA_COUNT" -eq 1 ] || fail "expected exactly one IPA in $EXPORT_PATH, found $IPA_COUNT"
IPA=$(find "$EXPORT_PATH" -maxdepth 1 -type f -name '*.ipa')
VERIFY_DIR=$(mktemp -d /tmp/remi-native-ipa.XXXXXX)
unzip -q "$IPA" -d "$VERIFY_DIR"
EXPORTED_APP="$VERIFY_DIR/Payload/Remi.app"
[ -d "$EXPORTED_APP" ] || fail "IPA does not contain Payload/Remi.app"
[ -d "$EXPORTED_APP/PlugIns/PhonePushService.appex" ] || fail "IPA does not contain PhonePushService.appex"
codesign --verify --deep --strict "$EXPORTED_APP" || fail "exported app signature verification failed"

echo "[5/7] Writing release receipt"
RECEIPT="$EXPORT_PATH/acceptance-receipt.txt"
{
  echo "source_commit=$SOURCE_COMMIT"
  echo "scheme=$SCHEME"
  echo "configuration=Release"
  echo "marketing_version=$MARKETING"
  echo "build_number=$BUILD"
  echo "app_bundle_id=$APP_ID"
  echo "extension_bundle_id=$EXTENSION_ID"
  echo "archive_manifest_sha256=$(find "$ARCHIVE_PATH" -type f -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | awk '{print $1}')"
  echo "ipa_sha256=$(shasum -a 256 "$IPA" | awk '{print $1}')"
} > "$RECEIPT"

echo "[6/7] Upload"
if [ "$DO_UPLOAD" = true ]; then
  [ -n "${ASC_KEY_ID:-}" ] && [ -n "${ASC_ISSUER_ID:-}" ] || fail "set ASC_KEY_ID and ASC_ISSUER_ID before --upload"
  expect_file "${AUTH_KEY_PATH:-}" "App Store Connect API key"
  xcrun altool --upload-app -f "$IPA" -t ios --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"
  echo "Uploaded native Remi $MARKETING ($BUILD) to TestFlight"
else
  echo "Upload skipped. Native IPA: $IPA"
fi
echo "Receipt: $RECEIPT"
