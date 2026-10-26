#!/bin/bash
# Build, validate, and optionally upload the native Remi Mac app (#1239).
#
# The Mac counterpart of scripts/testflight-ios.sh: archives the RemiMac scheme from
# packages/native, exports a Mac App Store .pkg, verifies what was exported, and with --upload
# sends it to TestFlight through altool. It shares the App Store Connect record (live.yooz.remi,
# macOS platform), the version and the build counter in config/app-release.json with the iPhone
# app and with the older WebView menu-bar app (scripts/testflight-macos.sh), which it replaces in
# the Mac TestFlight train: bump the build number when either has uploaded the current one.
#
# Usage:
#   packages/native/scripts/testflight-native-macos.sh --preflight-only    # settings and source checks, no build
#   packages/native/scripts/testflight-native-macos.sh --unsigned-archive  # archive without signing, inspect payload
#   packages/native/scripts/testflight-native-macos.sh                     # archive, export and verify the .pkg
#   packages/native/scripts/testflight-native-macos.sh --upload            # ... and upload it to TestFlight
#
# --upload needs ASC_KEY_ID and ASC_ISSUER_ID (in .env or the environment), the API key at
# ~/.appstoreconnect/private_keys/AuthKey_<KEYID>.p8, and the "Apple Distribution" and
# "3rd Party Mac Developer Installer" (Mac Installer Distribution) certificates in the keychain.
set -euo pipefail

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
PROJECT="$REPO_ROOT/packages/native/Remi.xcodeproj"
SCHEME="RemiMac"
TEAM_ID="${REMI_APPLE_TEAM_ID:-9DQ459HAZB}"
APP_ID="live.yooz.remi"
EXTENSION_ID="live.yooz.remi.native-push-service"
OUT_DIR="${REMI_ARCHIVE_DIR:-$REPO_ROOT/build/macos-native}"
CONFIG="$REPO_ROOT/config/app-release.json"
DO_UPLOAD=false
PREFLIGHT_ONLY=false
UNSIGNED_ARCHIVE=false

for arg in "$@"; do
  case "$arg" in
    --upload) DO_UPLOAD=true ;;
    --preflight-only) PREFLIGHT_ONLY=true ;;
    --unsigned-archive) UNSIGNED_ARCHIVE=true ;;
    *) echo "ERROR: unknown argument: $arg (usage: testflight-native-macos.sh [--preflight-only | --unsigned-archive] [--upload])" >&2; exit 1 ;;
  esac
done
[ "$PREFLIGHT_ONLY" = false ] || [ "$DO_UPLOAD" = false ] || { echo "ERROR: --preflight-only cannot upload" >&2; exit 1; }
[ "$UNSIGNED_ARCHIVE" = false ] || [ "$DO_UPLOAD" = false ] || { echo "ERROR: --unsigned-archive cannot upload" >&2; exit 1; }

fail() { echo "ERROR: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "$1 not found"; }
expect_file() { [ -f "$1" ] || fail "missing $2: $1"; }
expect_dir() { [ -d "$1" ] || fail "missing $2: $1"; }
expect_contains() { grep -Fq "$2" "$1" || fail "$3"; }
plist_value() { /usr/libexec/PlistBuddy -c "Print :$2" "$1" 2>/dev/null || true; }
expect_exempt_encryption() {
  # Owner-confirmed Apple-OS-only implementation, not a claim of no encryption.
  # Reassess this declaration before uploading any changed crypto implementation.
  [ "$(plutil -type ITSAppUsesNonExemptEncryption "$1" 2>/dev/null)" = bool ] ||
    fail "export compliance must declare a Boolean ITSAppUsesNonExemptEncryption"
  [ "$(plist_value "$1" ITSAppUsesNonExemptEncryption)" = false ] ||
    fail "export compliance differs from the owner-confirmed exempt classification"
}
# A signed bundle's entitlements as a plist on stdout.
entitlements_of() { codesign -d --entitlements :- "$1" 2>/dev/null; }
# PlistBuddy, not plutil -extract: entitlement keys contain dots, which plutil reads as nesting.
entitlement_value() {
  local file
  file=$(mktemp /tmp/remi-entitlements.XXXXXX)
  printf '%s' "$1" > "$file"
  /usr/libexec/PlistBuddy -c "Print :$2" "$file" 2>/dev/null || true
  rm -f "$file"
}

# Tests source this file for its helpers and stop here, before anything runs.
if [ "${REMI_TESTFLIGHT_SOURCE_ONLY:-}" = 1 ]; then return 0 2>/dev/null || exit 0; fi

need git
need xcodebuild
need xcrun
need plutil
need codesign
need pkgutil
expect_file "$CONFIG" "release config"
expect_file "$PROJECT/project.pbxproj" "native Xcode project"
expect_file "$PROJECT/xcshareddata/xcschemes/$SCHEME.xcscheme" "shared $SCHEME scheme"

MAC_SOURCE="$REPO_ROOT/packages/native/Mac"
expect_exempt_encryption "$MAC_SOURCE/Info.plist"

MARKETING=$(sed -nE 's/.*"marketingVersion"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$CONFIG")
BUILD="${REMI_BUILD_NUMBER:-$(sed -nE 's/.*"buildNumber"[[:space:]]*:[[:space:]]*([0-9]+).*/\1/p' "$CONFIG")}"
[[ "$MARKETING" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "invalid marketing version in $CONFIG"
[[ "$BUILD" =~ ^[0-9]+$ ]] || fail "invalid build number in $CONFIG"
SOURCE_COMMIT=$(git -C "$REPO_ROOT" rev-parse HEAD)
[[ "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || fail "could not resolve an exact source commit"

PBXPROJ="$PROJECT/project.pbxproj"
SCHEME_FILE="$PROJECT/xcshareddata/xcschemes/$SCHEME.xcscheme"
APP_ENTITLEMENTS="$MAC_SOURCE/Remi.entitlements"
EXTENSION_ENTITLEMENTS="$REPO_ROOT/packages/native/MacPushService/RemiPush.entitlements"
expect_contains "$PBXPROJ" "PRODUCT_BUNDLE_IDENTIFIER = $APP_ID;" "native Release app bundle ID is not $APP_ID"
expect_contains "$PBXPROJ" "PRODUCT_BUNDLE_IDENTIFIER = \"$EXTENSION_ID\";" "native Release extension bundle ID is not $EXTENSION_ID"
expect_contains "$PBXPROJ" "APNS_ENVIRONMENT = production;" "native project has no production APNS configuration"
expect_contains "$APP_ENTITLEMENTS" "com.apple.security.app-sandbox" "Mac app is not sandboxed"
expect_contains "$APP_ENTITLEMENTS" "com.apple.security.network.client" "Mac app has no outgoing network entitlement"
expect_contains "$APP_ENTITLEMENTS" "live.yooz.remi.secure-push" "app push keychain group is missing"
expect_contains "$APP_ENTITLEMENTS" "\$(DEVELOPMENT_TEAM).live.yooz.remi" "app-group entitlement is missing"
expect_contains "$EXTENSION_ENTITLEMENTS" "\$(DEVELOPMENT_TEAM).live.yooz.remi" "extension app-group entitlement is missing"
expect_contains "$EXTENSION_ENTITLEMENTS" "live.yooz.remi.secure-push" "extension push keychain group is missing"
expect_contains "$EXTENSION_ENTITLEMENTS" "com.apple.security.app-sandbox" "Mac push extension is not sandboxed"
expect_contains "$PBXPROJ" "INFOPLIST_KEY_NSLocalNetworkUsageDescription" "local-network usage description is missing"
expect_contains "$PBXPROJ" "INFOPLIST_KEY_LSApplicationCategoryType" "App Store category is missing"
expect_contains "$SCHEME_FILE" 'buildConfiguration = "Release"' "$SCHEME has no Release archive action"
# An empty icon set builds and then fails App Store validation, so check the source.
ICON_SET="$MAC_SOURCE/Assets.xcassets/AppIcon.appiconset"
for size in 16 32 64 128 256 512 1024; do
  expect_file "$ICON_SET/icon_${size}.png" "Mac app icon ${size}"
done
expect_file "$MAC_SOURCE/PrivacyInfo.xcprivacy" "Mac app privacy manifest"
plutil -lint "$MAC_SOURCE/PrivacyInfo.xcprivacy" >/dev/null || fail "Mac privacy manifest is not a valid plist"
[ "$(plist_value "$MAC_SOURCE/PrivacyInfo.xcprivacy" NSPrivacyTracking)" = false ] || fail "Mac privacy manifest declares tracking"
# MachinePanes reads the system uptime to time out requests; that API needs its reason declared.
expect_contains "$MAC_SOURCE/PrivacyInfo.xcprivacy" "NSPrivacyAccessedAPICategorySystemBootTime" "Mac privacy manifest does not declare system boot time"

echo "[1/7] Checking native Release build settings"
OVERRIDES=(MARKETING_VERSION="$MARKETING" CURRENT_PROJECT_VERSION="$BUILD"
  INFOPLIST_KEY_CFBundleDisplayName=Remi REMI_SOURCE_COMMIT="$SOURCE_COMMIT"
  CODE_SIGN_STYLE=Automatic DEVELOPMENT_TEAM="$TEAM_ID")
SETTINGS=$(xcodebuild -project "$PROJECT" -scheme "$SCHEME" -configuration Release \
  -destination 'generic/platform=macOS' -showBuildSettings "${OVERRIDES[@]}")
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
  # altool looks in the default key directory only, so a custom path would pass the check and then
  # fail at upload; the key is always read from there.
  AUTH_KEY_PATH="$HOME/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8"
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
  -destination 'generic/platform=macOS' -archivePath "$ARCHIVE_PATH" -allowProvisioningUpdates
  -skipPackagePluginValidation "${OVERRIDES[@]}")
if [ "${#AUTH_ARGS[@]}" -gt 0 ]; then ARCHIVE_CMD+=("${AUTH_ARGS[@]}"); fi
if [ "${#SIGNING_ARGS[@]}" -gt 0 ]; then ARCHIVE_CMD+=("${SIGNING_ARGS[@]}"); fi
"${ARCHIVE_CMD[@]}"
expect_dir "$ARCHIVE_PATH" "archive"

APP="$ARCHIVE_PATH/Products/Applications/Remi.app"
APP_INFO="$APP/Contents/Info.plist"
EXTENSION="$APP/Contents/PlugIns/MacPushService.appex"
PUSH_MANIFEST="Contents/Resources/RemiKit_RemiPush.bundle/Contents/Resources/PrivacyInfo.xcprivacy"
expect_file "$APP_INFO" "archived app Info.plist"
expect_file "$APP/Contents/Resources/PrivacyInfo.xcprivacy" "archived app privacy manifest"
expect_file "$APP/Contents/Resources/Assets.car" "compiled app assets"
expect_file "$APP/Contents/Resources/AppIcon.icns" "compiled app icon"
expect_file "$APP/$PUSH_MANIFEST" "archived app RemiPush privacy manifest"
expect_dir "$EXTENSION" "embedded MacPushService.appex"
expect_file "$EXTENSION/$PUSH_MANIFEST" "archived extension RemiPush privacy manifest"
[ "$(plist_value "$APP_INFO" CFBundleIdentifier)" = "$APP_ID" ] || fail "archived app bundle ID mismatch"
[ "$(plist_value "$APP_INFO" CFBundleDisplayName)" = "Remi" ] || fail "archived display name mismatch"
[ "$(plist_value "$APP_INFO" CFBundleShortVersionString)" = "$MARKETING" ] || fail "archived marketing version mismatch"
[ "$(plist_value "$APP_INFO" CFBundleVersion)" = "$BUILD" ] || fail "archived build number mismatch"
[ "$(plist_value "$APP_INFO" RemiSourceCommit)" = "$SOURCE_COMMIT" ] || fail "archived source commit mismatch"
[ -n "$(plist_value "$APP_INFO" LSApplicationCategoryType)" ] || fail "archived app has no App Store category"
[ -n "$(plist_value "$APP_INFO" CFBundleIconName)" ] || fail "archived app has no icon name"
expect_exempt_encryption "$APP_INFO"
[ "$(plist_value "$EXTENSION/Contents/Info.plist" CFBundleIdentifier)" = "$EXTENSION_ID" ] || fail "archived extension bundle ID mismatch"
[ "$(plist_value "$EXTENSION/Contents/Info.plist" CFBundleShortVersionString)" = "$MARKETING" ] || fail "extension marketing version mismatch"
[ "$(plist_value "$EXTENSION/Contents/Info.plist" CFBundleVersion)" = "$BUILD" ] || fail "extension build number mismatch"
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
  echo "Unsigned native Mac archive passed packaging validation: $ARCHIVE_PATH"
  echo "Receipt: $RECEIPT"
  exit 0
fi

echo "[3/7] Verifying archive signing and entitlements"
codesign --verify --deep --strict "$APP" || fail "archived app signature verification failed"
ARCHIVE_ENTITLEMENTS=$(entitlements_of "$APP") || fail "cannot read archived app entitlements"
[ "$(entitlement_value "$ARCHIVE_ENTITLEMENTS" com.apple.security.app-sandbox)" = true ] || fail "signed app is not sandboxed"
grep -Fq 'live.yooz.remi.secure-push' <<<"$ARCHIVE_ENTITLEMENTS" || fail "signed app is missing the shared push keychain group"
grep -Fq "$TEAM_ID.live.yooz.remi" <<<"$ARCHIVE_ENTITLEMENTS" || fail "signed app is missing its app group"
# Automatic signing may use a development profile here. App Store export re-signs the payload;
# production APNS and no debugger access are required on that final app.

echo "[4/7] Exporting Mac App Store package"
EXPORT_OPTIONS=$(mktemp /tmp/remi-native-macos-export.XXXXXX.plist)
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

PKG_COUNT=$(find "$EXPORT_PATH" -maxdepth 1 -type f -name '*.pkg' | wc -l | tr -d ' ')
[ "$PKG_COUNT" -eq 1 ] || fail "expected exactly one .pkg in $EXPORT_PATH, found $PKG_COUNT"
PKG=$(find "$EXPORT_PATH" -maxdepth 1 -type f -name '*.pkg')
PKG_SIGNATURE=$(pkgutil --check-signature "$PKG") || fail "the package is not signed"
grep -Eq '3rd Party Mac Developer Installer|Mac Installer Distribution' <<<"$PKG_SIGNATURE" ||
  fail "the package is not signed with a Mac installer distribution certificate"
VERIFY_DIR=$(mktemp -d /tmp/remi-native-macos-pkg.XXXXXX)
pkgutil --expand-full "$PKG" "$VERIFY_DIR/expanded" >/dev/null || fail "cannot expand the package"
EXPORTED_APP=$(find "$VERIFY_DIR/expanded" -maxdepth 6 -type d -name 'Remi.app' | head -1)
[ -n "$EXPORTED_APP" ] || fail "the package does not contain Remi.app"
EXPORTED_EXTENSION="$EXPORTED_APP/Contents/PlugIns/MacPushService.appex"
expect_dir "$EXPORTED_EXTENSION" "exported MacPushService.appex"
expect_exempt_encryption "$EXPORTED_APP/Contents/Info.plist"
for TARGET in "$EXPORTED_APP" "$EXPORTED_EXTENSION"; do
  codesign --verify --deep --strict "$TARGET" || fail "exported target signature verification failed"
  ENTITLEMENTS=$(entitlements_of "$TARGET") || fail "cannot read exported target entitlements"
  [ "$(entitlement_value "$ENTITLEMENTS" com.apple.security.app-sandbox)" = true ] || fail "exported target is not sandboxed"
  grep -Fq 'live.yooz.remi.secure-push' <<<"$ENTITLEMENTS" || fail "exported target is missing the shared push keychain group"
  grep -Fq "$TEAM_ID.live.yooz.remi" <<<"$ENTITLEMENTS" || fail "exported target is missing its app group"
  [ "$(entitlement_value "$ENTITLEMENTS" com.apple.security.get-task-allow)" != true ] || fail "exported target permits debugger access"
  # A development identity here would mean the export did not re-sign for distribution.
  codesign -dvv "$TARGET" 2>&1 | grep -Eq '^Authority=(Apple Distribution|3rd Party Mac Developer Application)' ||
    fail "exported target is not signed with a distribution identity"
done
! grep -R -a -q 'live.yooz.remi.dev' "$EXPORTED_APP" || fail "development identity leaked into the exported app"
EXPORTED_APP_ENTITLEMENTS=$(entitlements_of "$EXPORTED_APP") || fail "cannot read exported app entitlements"
[ "$(entitlement_value "$EXPORTED_APP_ENTITLEMENTS" com.apple.developer.aps-environment)" = production ] || fail "exported app is not using production APNS"

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
  echo "exported_apns_environment=production"
  echo "exported_debugger_access=false"
  echo "archive_manifest_sha256=$(find "$ARCHIVE_PATH" -type f -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | awk '{print $1}')"
  echo "pkg_sha256=$(shasum -a 256 "$PKG" | awk '{print $1}')"
} > "$RECEIPT"

echo "[6/7] Upload"
if [ "$DO_UPLOAD" = true ]; then
  [ -n "${ASC_KEY_ID:-}" ] && [ -n "${ASC_ISSUER_ID:-}" ] || fail "set ASC_KEY_ID and ASC_ISSUER_ID before --upload"
  expect_file "${AUTH_KEY_PATH:-}" "App Store Connect API key"
  # Validate first: App Store Connect rejects a repeated build number or a bad plist here, before
  # the upload, so a number already used by the older WebView Mac app (it shares this counter and
  # this record) fails with a clear message. Nothing is delivered by this step.
  xcrun altool --validate-app -f "$PKG" -t macos --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID" ||
    fail "App Store Connect validation failed; nothing was uploaded"
  xcrun altool --upload-app -f "$PKG" -t macos --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"
  echo "Uploaded native Remi for Mac $MARKETING ($BUILD) to TestFlight"
else
  echo "Upload skipped. Native Mac package: $PKG"
fi
echo "Receipt: $RECEIPT"
