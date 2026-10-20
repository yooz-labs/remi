#!/bin/sh
set -eu

usage() {
    echo "usage: $0 [--expected <commit>] [--receipt-dir <directory>] [--simulator <device-identifier>]" >&2
    exit 2
}

expected=
receipt_dir=
simulator=
while [ "$#" -gt 0 ]; do
    case "$1" in
        --expected)
            [ "$#" -ge 2 ] || usage
            expected=$2
            shift 2
            ;;
        --receipt-dir)
            [ "$#" -ge 2 ] || usage
            receipt_dir=$2
            shift 2
            ;;
        --simulator)
            [ "$#" -ge 2 ] || usage
            simulator=$2
            shift 2
            ;;
        *) usage ;;
    esac
done

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
native_dir=$(CDPATH= cd -- "$script_dir/.." && pwd -P)
repo_root=$(git -C "$native_dir" rev-parse --show-toplevel)
head_commit=$(git -C "$repo_root" rev-parse HEAD)
expected=${expected:-$head_commit}
expected_commit=$(git -C "$repo_root" rev-parse --verify "$expected^{commit}" 2>/dev/null) || {
    echo "ERROR: expected commit does not resolve: $expected" >&2
    exit 1
}

[ "$head_commit" = "$expected_commit" ] || {
    echo "ERROR: checkout is $head_commit, expected $expected_commit" >&2
    exit 1
}
dirty=$(git -C "$repo_root" status --porcelain --untracked-files=all -- packages/native)
[ -z "$dirty" ] || {
    echo "ERROR: packages/native has uncommitted files; exact-build acceptance requires a clean checkout" >&2
    printf '%s\n' "$dirty" >&2
    exit 1
}

short_commit=$(printf '%.12s' "$head_commit")
receipt_dir=${receipt_dir:-"${TMPDIR:-/tmp}/remi-native-acceptance-$short_commit"}
mkdir -p "$receipt_dir"
receipt_dir=$(CDPATH= cd -- "$receipt_dir" && pwd -P)
project="$native_dir/Remi.xcodeproj"
mac_derived="$receipt_dir/DerivedData-Mac"
phone_derived="$receipt_dir/DerivedData-Phone"
mac_log="$receipt_dir/RemiMac-build.log"
phone_log="$receipt_dir/RemiPhone-build.log"

build() {
    scheme=$1
    destination=$2
    derived=$3
    log=$4
    signing=$5
    if [ "$signing" = local ]; then
        xcodebuild -project "$project" -scheme "$scheme" -destination "$destination" \
            -derivedDataPath "$derived" REMI_SOURCE_COMMIT="$head_commit" \
            build >"$log" 2>&1 || {
            tail -80 "$log" >&2
            exit 1
        }
    else
        xcodebuild -project "$project" -scheme "$scheme" -destination "$destination" \
            -derivedDataPath "$derived" CODE_SIGNING_ALLOWED=NO \
            REMI_SOURCE_COMMIT="$head_commit" build >"$log" 2>&1 || {
            tail -80 "$log" >&2
            exit 1
        }
    fi
}

build RemiMac 'platform=macOS' "$mac_derived" "$mac_log" unsigned
if [ -n "$simulator" ]; then
    phone_destination="platform=iOS Simulator,id=$simulator"
    phone_signing=local
else
    phone_destination='generic/platform=iOS Simulator'
    phone_signing=unsigned
fi
build RemiPhone "$phone_destination" "$phone_derived" "$phone_log" "$phone_signing"

mac_app="$mac_derived/Build/Products/Debug/Remi.app"
phone_app="$phone_derived/Build/Products/Debug-iphonesimulator/Remi.app"
for app in "$mac_app" "$phone_app"; do
    [ -d "$app" ] || { echo "ERROR: expected app bundle is missing: $app" >&2; exit 1; }
    if [ -f "$app/Contents/Info.plist" ]; then
        info_plist="$app/Contents/Info.plist"
    else
        info_plist="$app/Info.plist"
    fi
    embedded=$(/usr/libexec/PlistBuddy -c 'Print :RemiSourceCommit' "$info_plist" 2>/dev/null || true)
    [ "$embedded" = "$head_commit" ] || {
        echo "ERROR: $app embeds '${embedded:-no commit}', expected $head_commit" >&2
        exit 1
    }
done

installed_phone=
if [ -n "$simulator" ]; then
    xcrun simctl install "$simulator" "$phone_app"
    container=$(xcrun simctl get_app_container "$simulator" live.yooz.remi.dev app)
    installed_commit=$(/usr/libexec/PlistBuddy -c 'Print :RemiSourceCommit' "$container/Info.plist")
    [ "$installed_commit" = "$head_commit" ] || {
        echo "ERROR: installed iPhone app embeds $installed_commit, expected $head_commit" >&2
        exit 1
    }
    installed_phone=$container
fi

receipt="$receipt_dir/acceptance-receipt.txt"
{
    echo "commit=$head_commit"
    echo "repo_root=$repo_root"
    echo "project=$project"
    echo "xcode=$(/usr/bin/xcodebuild -version | tr '\n' ' ')"
    echo "mac_scheme=RemiMac"
    echo "mac_destination=platform=macOS"
    echo "mac_app=$mac_app"
    echo "mac_bundle_sha256=$(find "$mac_app" -type f -exec shasum -a 256 {} + | LC_ALL=C sort | shasum -a 256 | awk '{print $1}')"
    echo "phone_scheme=RemiPhone"
    echo "phone_destination=$phone_destination"
    echo "phone_app=$phone_app"
    echo "phone_bundle_sha256=$(find "$phone_app" -type f -exec shasum -a 256 {} + | LC_ALL=C sort | shasum -a 256 | awk '{print $1}')"
    echo "installed_phone=$installed_phone"
    for source in Remi.xcodeproj/project.pbxproj Mac/MacLiveRootView.swift iPhone/HomeScreen.swift; do
        echo "source_${source##*/}_sha256=$(shasum -a 256 "$native_dir/$source" | awk '{print $1}')"
    done
} > "$receipt"

echo "Exact native build: $head_commit"
echo "Receipt: $receipt"
