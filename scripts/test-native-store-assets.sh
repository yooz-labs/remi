#!/bin/bash
# Deterministic store-artifact checks for the native iPhone target (#1543).
set -euo pipefail

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ICON_DIR="$REPO_ROOT/packages/native/iPhone/Assets.xcassets/AppIcon.appiconset"
CONTENTS="$ICON_DIR/Contents.json"
PRIVACY="$REPO_ROOT/packages/native/iPhone/PrivacyInfo.xcprivacy"
PUSH_PRIVACY="$REPO_ROOT/packages/native/RemiKit/Sources/RemiPush/PrivacyInfo.xcprivacy"
PROVENANCE="$REPO_ROOT/packages/native/BRAND-ASSETS.md"
CHECKS=0

fail() { echo "ERROR: $*" >&2; exit 1; }
pass() { CHECKS=$((CHECKS + 1)); printf 'ok %02d - %s\n' "$CHECKS" "$1"; }
require_file() { [ -f "$1" ] || fail "missing $2: $1"; pass "$2 exists"; }
expect_equal() { [ "$1" = "$2" ] || fail "$3 (expected '$2', got '$1')"; pass "$3"; }
expect_contains() { grep -Fq "$2" "$1" || fail "$3"; pass "$3"; }
plist() { /usr/libexec/PlistBuddy -c "Print :$2" "$1" 2>/dev/null || true; }
plist_raw() { plutil -extract "$2" raw -o - "$1" 2>/dev/null || true; }
json() { jq -r ".$2 // empty" "$1" 2>/dev/null || true; }
sha256() { shasum -a 256 "$1" | awk '{print $1}'; }
sips_value() { sips -g "$2" "$1" 2>/dev/null | awk -F': ' -v key="$2" '$1 ~ key {print $2}'; }

command -v plutil >/dev/null || fail "plutil not found"
command -v jq >/dev/null || fail "jq not found"
command -v sips >/dev/null || fail "sips not found"
command -v shasum >/dev/null || fail "shasum not found"

require_file "$CONTENTS" "AppIcon catalog"
require_file "$ICON_DIR/icon-light.png" "light app icon"
require_file "$ICON_DIR/icon-dark.png" "dark app icon"
require_file "$ICON_DIR/icon-tinted.png" "tinted app icon"
require_file "$PRIVACY" "app privacy manifest"
require_file "$PUSH_PRIVACY" "push library privacy manifest"
require_file "$PROVENANCE" "brand provenance"

jq -e . "$CONTENTS" >/dev/null || fail "invalid AppIcon Contents.json"
pass "AppIcon catalog is valid JSON"
expect_equal "$(json "$CONTENTS" 'images[0].filename')" "icon-light.png" "light catalog filename"
expect_equal "$(json "$CONTENTS" 'images[1].filename')" "icon-dark.png" "dark catalog filename"
expect_equal "$(json "$CONTENTS" 'images[2].filename')" "icon-tinted.png" "tinted catalog filename"
expect_equal "$(json "$CONTENTS" 'images[0].size')" "1024x1024" "light catalog size"
expect_equal "$(json "$CONTENTS" 'images[1].appearances[0].value')" "dark" "dark appearance"
expect_equal "$(json "$CONTENTS" 'images[2].appearances[0].value')" "tinted" "tinted appearance"

for appearance in light dark tinted; do
  icon="$ICON_DIR/icon-$appearance.png"
  file "$icon" | grep -Fq 'PNG image data' || fail "$appearance icon is not PNG"
  pass "$appearance icon is PNG"
  expect_equal "$(sips_value "$icon" pixelWidth)" "1024" "$appearance icon width"
  expect_equal "$(sips_value "$icon" pixelHeight)" "1024" "$appearance icon height"
done
expect_equal "$(sips_value "$ICON_DIR/icon-light.png" hasAlpha)" "no" "light icon is opaque"
expect_equal "$(sips_value "$ICON_DIR/icon-dark.png" hasAlpha)" "no" "dark icon is opaque"
expect_equal "$(sips_value "$ICON_DIR/icon-tinted.png" hasAlpha)" "yes" "tinted icon preserves its mask"
expect_equal "$(sha256 "$ICON_DIR/icon-light.png")" "dff003098795008a3b32e2725cd95b6385c38f18c4178dcc42c4fc1d78c82b6c" "light shipping hash"
expect_equal "$(sha256 "$ICON_DIR/icon-dark.png")" "b6174bb0faf30119315759ff153e1ceb212f46bd059ceaedb72401367bcd1361" "dark shipping hash"
expect_equal "$(sha256 "$ICON_DIR/icon-tinted.png")" "0008ea5234506ab88b6e7dc6599432b99999deb557c483390abc763f2c8bd31e" "tinted shipping hash"
expect_contains "$PROVENANCE" "Fraunces Display 800" "font provenance is recorded"
expect_contains "$PROVENANCE" "r-light.png" "canonical source path is recorded"

plutil -lint "$PRIVACY" >/dev/null || fail "invalid PrivacyInfo.xcprivacy"
pass "privacy manifest is a valid plist"
expect_equal "$(plist "$PRIVACY" NSPrivacyTracking)" "false" "tracking is disabled"
expect_equal "$(plist_raw "$PRIVACY" NSPrivacyTrackingDomains)" "0" "tracking domains are empty"
expect_equal "$(plist_raw "$PRIVACY" NSPrivacyCollectedDataTypes)" "0" "collected data types are empty"
expect_equal "$(plist "$PRIVACY" NSPrivacyAccessedAPITypes:0:NSPrivacyAccessedAPIType)" "NSPrivacyAccessedAPICategoryFileTimestamp" "file metadata API category"
expect_equal "$(plist "$PRIVACY" NSPrivacyAccessedAPITypes:0:NSPrivacyAccessedAPITypeReasons:0)" "C617.1" "container file metadata reason"
expect_equal "$(plist "$PRIVACY" NSPrivacyAccessedAPITypes:1:NSPrivacyAccessedAPIType)" "NSPrivacyAccessedAPICategoryUserDefaults" "UserDefaults API category"
expect_equal "$(plist "$PRIVACY" NSPrivacyAccessedAPITypes:1:NSPrivacyAccessedAPITypeReasons:0)" "1C8F.1" "app-group UserDefaults reason"
expect_equal "$(plist "$PRIVACY" NSPrivacyAccessedAPITypes:1:NSPrivacyAccessedAPITypeReasons:1)" "CA92.1" "app-private UserDefaults reason"
plutil -lint "$PUSH_PRIVACY" >/dev/null || fail "invalid RemiPush PrivacyInfo.xcprivacy"
pass "push library privacy manifest is a valid plist"
expect_equal "$(plist "$PUSH_PRIVACY" NSPrivacyAccessedAPITypes:0:NSPrivacyAccessedAPITypeReasons:0)" "C617.1" "push library file metadata reason"
expect_equal "$(plist "$PUSH_PRIVACY" NSPrivacyAccessedAPITypes:1:NSPrivacyAccessedAPITypeReasons:0)" "1C8F.1" "push library app-group defaults reason"
expect_contains "$REPO_ROOT/packages/native/RemiKit/Package.swift" '.process("PrivacyInfo.xcprivacy")' "push manifest is a Swift package resource"

[ "$CHECKS" -ge 30 ] || fail "expected at least 30 checks, ran $CHECKS"
echo "Native store assets passed $CHECKS checks."
