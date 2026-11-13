#!/bin/bash
# Fast regression checks for the native Mac TestFlight release contract (#1239).
set -euo pipefail

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
SCRIPT="$REPO_ROOT/packages/native/scripts/testflight-native-macos.sh"
OUT=$(mktemp /tmp/remi-macos-contract.XXXXXX)
trap 'rm -f "$OUT"' EXIT
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

# The Mac app icon is the iPhone's light icon (BRAND-ASSETS.md): same bytes at 1024, so the two
# apps cannot drift apart, and the menu bar mask is bundled.
cmp -s "$REPO_ROOT/packages/native/Mac/Assets.xcassets/AppIcon.appiconset/icon_1024.png" \
  "$REPO_ROOT/packages/native/iPhone/Assets.xcassets/AppIcon.appiconset/icon-light.png" ||
  fail "the Mac app icon is not the iPhone light icon"
# Every size is that file scaled the way BRAND-ASSETS.md says, so a hand-edited size is caught.
ICON_SOURCE="$REPO_ROOT/packages/native/iPhone/Assets.xcassets/AppIcon.appiconset/icon-light.png"
ICON_CHECK=$(mktemp -d /tmp/remi-macos-icons.XXXXXX)
for size in 16 32 64 128 256 512; do
  sips -z "$size" "$size" "$ICON_SOURCE" --out "$ICON_CHECK/icon_${size}.png" >/dev/null
  cmp -s "$ICON_CHECK/icon_${size}.png" "$REPO_ROOT/packages/native/Mac/Assets.xcassets/AppIcon.appiconset/icon_${size}.png" ||
    { rm -rf "$ICON_CHECK"; fail "Mac icon_${size}.png is not the iPhone light icon scaled to ${size}"; }
done
rm -rf "$ICON_CHECK"
MASK="$REPO_ROOT/packages/native/Mac/Assets.xcassets/MenuBarGlyph.imageset/r-mask.png"
[ -s "$MASK" ] || fail "the menu bar glyph mask is missing"
[ -s "$REPO_ROOT/packages/native/Mac/Assets.xcassets/MenuBarGlyph.imageset/Contents.json" ] || fail "the menu bar glyph image set has no Contents.json"

# The ordering the release depends on: validate with App Store Connect before uploading.
validate_line=$(awk '/altool --validate-app/ { print NR; exit }' "$SCRIPT")
upload_line=$(awk '/altool --upload-app/ { print NR; exit }' "$SCRIPT")
[ -n "$validate_line" ] && [ -n "$upload_line" ] || fail "validate/upload steps are absent"
[ "$validate_line" -lt "$upload_line" ] || fail "the package is uploaded before it is validated"
contains "$SCRIPT" 'REMI_TESTFLIGHT_SOURCE_ONLY' "helpers cannot be sourced for testing"

# Both apps read the system uptime (MachinePanes), so both manifests declare its reason.
for manifest in packages/native/Mac/PrivacyInfo.xcprivacy packages/native/iPhone/PrivacyInfo.xcprivacy; do
  contains "$REPO_ROOT/$manifest" "NSPrivacyAccessedAPICategorySystemBootTime" "$manifest does not declare system boot time"
  contains "$REPO_ROOT/$manifest" "35F9.1" "$manifest has no reason for system boot time"
done

# The entitlement helper, on a real plist. Keys contain dots, which plutil reads as nesting; an
# absent key must read as empty, not fail.
FIXTURE='<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
<key>com.apple.security.app-sandbox</key><true/>
<key>com.apple.developer.aps-environment</key><string>production</string>
<key>keychain-access-groups</key><array><string>T.live.yooz.remi.secure-push</string></array>
</dict></plist>'
(
  REMI_TESTFLIGHT_SOURCE_ONLY=1 . "$SCRIPT"
  [ "$(entitlement_value "$FIXTURE" com.apple.security.app-sandbox)" = true ] || fail "sandbox entitlement is not read"
  [ "$(entitlement_value "$FIXTURE" com.apple.developer.aps-environment)" = production ] || fail "APNs entitlement is not read"
  [ -z "$(entitlement_value "$FIXTURE" com.apple.security.get-task-allow)" ] || fail "an absent entitlement is not read as empty"
) || exit 1

"$SCRIPT" --preflight-only
if "$SCRIPT" --preflight-only --upload >"$OUT" 2>&1; then
  fail "--preflight-only --upload was accepted"
fi
if "$SCRIPT" --unsigned-archive --upload >"$OUT" 2>&1; then
  fail "--unsigned-archive --upload was accepted"
fi
if "$SCRIPT" --not-an-option >"$OUT" 2>&1; then
  fail "unknown option was accepted"
fi
echo "PASS: native Mac TestFlight release contract"
