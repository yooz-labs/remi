#!/bin/bash
# Fast regression checks for the native TestFlight release contract (#1539).
set -euo pipefail

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SCRIPT="$REPO_ROOT/scripts/testflight-ios.sh"
fail() { echo "FAIL: $*" >&2; exit 1; }
contains() { grep -Fq "$2" "$1" || fail "$3"; }
excludes() { ! grep -Fq "$2" "$1" || fail "$3"; }

bash -n "$SCRIPT"
contains "$SCRIPT" 'packages/native/Remi.xcodeproj' "script does not select the native project"
contains "$SCRIPT" 'SCHEME="RemiPhone"' "script does not select RemiPhone"
contains "$SCRIPT" "configuration Release" "script does not use Release"
contains "$SCRIPT" "generic/platform=iOS" "script does not use the generic iOS destination"
contains "$SCRIPT" 'APP_ID="live.yooz.remi"' "production app ID is not pinned"
contains "$SCRIPT" 'EXTENSION_ID="live.yooz.remi.native-push-service"' "production extension ID is not pinned"
contains "$SCRIPT" "MARKETING_VERSION" "marketing version is not overridden"
contains "$SCRIPT" "CURRENT_PROJECT_VERSION" "build number is not overridden"
contains "$SCRIPT" "INFOPLIST_KEY_CFBundleDisplayName=Remi" "release display name is not overridden"
contains "$SCRIPT" 'REMI_SOURCE_COMMIT="$SOURCE_COMMIT"' "source commit is not embedded"
contains "$SCRIPT" "PhonePushService.appex" "extension is not validated"
contains "$SCRIPT" "Remi.entitlements" "app entitlements are not preflighted"
contains "$SCRIPT" "RemiPush.entitlements" "extension entitlements are not preflighted"
contains "$SCRIPT" "NSCameraUsageDescription" "camera purpose string is not preflighted"
contains "$SCRIPT" "NSLocalNetworkUsageDescription" "local network purpose string is not preflighted"
contains "$SCRIPT" "codesign --verify --deep --strict" "signature is not verified"
contains "$SCRIPT" "app-store-connect" "App Store export is not selected"
contains "$SCRIPT" 'DO_UPLOAD=false' "upload is not opt-in"
contains "$SCRIPT" 'UNSIGNED_ARCHIVE=false' "unsigned archive validation is unavailable"
contains "$SCRIPT" 'CODE_SIGNING_ALLOWED=NO' "unsigned archive does not disable signing"
contains "$SCRIPT" 'ASC_KEY_ID' "upload key ID is not checked"
contains "$SCRIPT" 'ASC_ISSUER_ID' "upload issuer ID is not checked"
contains "$SCRIPT" 'acceptance-receipt.txt' "release receipt is not written"
contains "$SCRIPT" 'archive_manifest_sha256' "archive manifest is not hashed"
contains "$SCRIPT" 'ipa_sha256' "IPA is not hashed"
excludes "$SCRIPT" 'packages/web/ios/App' "retired Capacitor project remains in the native release path"
excludes "$SCRIPT" 'bunx cap sync' "Capacitor sync remains in the native release path"

"$SCRIPT" --preflight-only
if "$SCRIPT" --preflight-only --upload >/tmp/remi-testflight-invalid.out 2>&1; then
  fail "--preflight-only --upload was accepted"
fi
if "$SCRIPT" --unsigned-archive --upload >/tmp/remi-testflight-invalid.out 2>&1; then
  fail "--unsigned-archive --upload was accepted"
fi
if "$SCRIPT" --not-an-option >/tmp/remi-testflight-invalid.out 2>&1; then
  fail "unknown option was accepted"
fi
rm -f /tmp/remi-testflight-invalid.out
echo "PASS: native TestFlight release contract"
