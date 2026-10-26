#!/bin/bash
# Fast regression checks for the native Mac TestFlight release contract (#1239).
set -euo pipefail

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
SCRIPT="$REPO_ROOT/packages/native/scripts/testflight-native-macos.sh"
fail() { echo "FAIL: $*" >&2; exit 1; }
contains() { grep -Fq -- "$2" "$1" || fail "$3"; }
excludes() { ! grep -Fq -- "$2" "$1" || fail "$3"; }

bash -n "$SCRIPT"
contains "$SCRIPT" 'packages/native/Remi.xcodeproj' "script does not select the native project"
contains "$SCRIPT" 'SCHEME="RemiMac"' "script does not select RemiMac"
contains "$SCRIPT" "configuration Release" "script does not use Release"
contains "$SCRIPT" "generic/platform=macOS" "script does not use the generic macOS destination"
contains "$SCRIPT" 'APP_ID="live.yooz.remi"' "production app ID is not pinned"
contains "$SCRIPT" 'EXTENSION_ID="live.yooz.remi.native-push-service"' "production extension ID is not pinned"
contains "$SCRIPT" "MARKETING_VERSION" "marketing version is not overridden"
contains "$SCRIPT" "CURRENT_PROJECT_VERSION" "build number is not overridden"
contains "$SCRIPT" "INFOPLIST_KEY_CFBundleDisplayName=Remi" "release display name is not overridden"
contains "$SCRIPT" 'REMI_SOURCE_COMMIT="$SOURCE_COMMIT"' "source commit is not embedded"
contains "$SCRIPT" "MacPushService.appex" "extension is not validated"
contains "$SCRIPT" 'PrivacyInfo.xcprivacy' "privacy manifests are not validated"
contains "$SCRIPT" 'AppIcon.icns' "compiled app icon is not validated"
contains "$SCRIPT" 'icon_${size}.png' "source app icons are not preflighted"
contains "$SCRIPT" "Assets.car" "compiled app assets are not validated"
contains "$SCRIPT" "Remi.entitlements" "app entitlements are not preflighted"
contains "$SCRIPT" "RemiPush.entitlements" "extension entitlements are not preflighted"
contains "$SCRIPT" "com.apple.security.app-sandbox" "sandbox is not required"
contains "$SCRIPT" "NSLocalNetworkUsageDescription" "local network purpose string is not preflighted"
contains "$SCRIPT" "LSApplicationCategoryType" "App Store category is not preflighted"
contains "$SCRIPT" "codesign --verify --deep --strict" "signature is not verified"
contains "$SCRIPT" "pkgutil --check-signature" "installer signature is not verified"
contains "$SCRIPT" "app-store-connect" "App Store export is not selected"
contains "$SCRIPT" 'DO_UPLOAD=false' "upload is not opt-in"
contains "$SCRIPT" 'UNSIGNED_ARCHIVE=false' "unsigned archive validation is unavailable"
contains "$SCRIPT" 'CODE_SIGNING_ALLOWED=NO' "unsigned archive does not disable signing"
contains "$SCRIPT" 'ASC_KEY_ID' "upload key ID is not checked"
contains "$SCRIPT" 'ASC_ISSUER_ID' "upload issuer ID is not checked"
contains "$SCRIPT" '-t macos' "upload is not for the macOS platform"
contains "$SCRIPT" 'acceptance-receipt.txt' "release receipt is not written"
contains "$SCRIPT" 'archive_manifest_sha256' "archive manifest is not hashed"
contains "$SCRIPT" 'pkg_sha256' "package is not hashed"
excludes "$SCRIPT" 'packages/macos' "the retired WebView Mac project is in the native release path"
excludes "$SCRIPT" 'stage-macos-web' "web staging is in the native release path"

# Automatic signing can archive with a development profile; App Store export applies the
# distribution profile. Enforce production APNS on what ships, after the export.
export_line=$(awk '/EXPORT_CMD=\(xcodebuild -exportArchive/ { print NR; exit }' "$SCRIPT")
apns_line=$(awk '/fail "exported app is not using production APNS"/ { print NR; exit }' "$SCRIPT")
[ -n "$export_line" ] && [ -n "$apns_line" ] || fail "export/APNS checks are absent"
[ "$apns_line" -gt "$export_line" ] || fail "production APNS is checked before distribution export"

"$SCRIPT" --preflight-only
if "$SCRIPT" --preflight-only --upload >/tmp/remi-macos-invalid.out 2>&1; then
  fail "--preflight-only --upload was accepted"
fi
if "$SCRIPT" --unsigned-archive --upload >/tmp/remi-macos-invalid.out 2>&1; then
  fail "--unsigned-archive --upload was accepted"
fi
if "$SCRIPT" --not-an-option >/tmp/remi-macos-invalid.out 2>&1; then
  fail "unknown option was accepted"
fi
rm -f /tmp/remi-macos-invalid.out
echo "PASS: native Mac TestFlight release contract"
