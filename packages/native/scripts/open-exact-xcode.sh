#!/bin/sh
set -eu

usage() {
    echo "usage: $0 [--check-only] [--expected <commit>] [--receipt-dir <directory>]" >&2
    exit 2
}

check_only=false
expected=
receipt_dir=
while [ "$#" -gt 0 ]; do
    case "$1" in
        --check-only)
            check_only=true
            shift
            ;;
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
        *) usage ;;
    esac
done

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
native_dir=$(CDPATH= cd -- "$script_dir/.." && pwd -P)
repo_root=$(git -C "$native_dir" rev-parse --show-toplevel)
head_commit=$(git -C "$repo_root" rev-parse HEAD)

if [ -n "$expected" ]; then
    expected_commit=$(git -C "$repo_root" rev-parse --verify "$expected^{commit}" 2>/dev/null) || {
        echo "ERROR: expected commit does not resolve: $expected" >&2
        exit 1
    }
else
    expected_commit=$head_commit
fi

if [ "$head_commit" != "$expected_commit" ]; then
    echo "ERROR: checkout is $head_commit, expected $expected_commit" >&2
    exit 1
fi

dirty=$(git -C "$repo_root" status --porcelain --untracked-files=all -- packages/native)
if [ -n "$dirty" ]; then
    echo "ERROR: packages/native has uncommitted files; exact-source acceptance requires a clean checkout" >&2
    printf '%s\n' "$dirty" >&2
    exit 1
fi

project="$native_dir/Remi.xcodeproj"
project_file="$project/project.pbxproj"
mac_source="$native_dir/Mac/MacLiveRootView.swift"
phone_source="$native_dir/iPhone/HomeScreen.swift"
for required in "$project_file" "$mac_source" "$phone_source"; do
    [ -f "$required" ] || {
        echo "ERROR: missing required source: $required" >&2
        exit 1
    }
done

if [ -z "$receipt_dir" ]; then
    short_commit=$(printf '%.12s' "$head_commit")
    receipt_dir="${TMPDIR:-/tmp}/remi-native-xcode-$short_commit"
fi
mkdir -p "$receipt_dir"
receipt="$receipt_dir/source-receipt.txt"
{
    echo "commit=$head_commit"
    echo "repo_root=$repo_root"
    echo "project=$project"
    echo "project_sha256=$(shasum -a 256 "$project_file" | awk '{print $1}')"
    echo "mac_source=$mac_source"
    echo "mac_sha256=$(shasum -a 256 "$mac_source" | awk '{print $1}')"
    echo "phone_source=$phone_source"
    echo "phone_sha256=$(shasum -a 256 "$phone_source" | awk '{print $1}')"
} > "$receipt"

echo "Exact native source: $head_commit"
echo "Receipt: $receipt"

if [ "$check_only" = true ]; then
    exit 0
fi

opened=false
if command -v xed >/dev/null 2>&1 && xed -p "$project" "$mac_source" "$phone_source"; then
    opened=true
else
    developer_dir=$(xcode-select -p 2>/dev/null || true)
    xcode_app=${developer_dir%/Contents/Developer}
    if [ -d "$xcode_app" ] && command -v open >/dev/null 2>&1; then
        if open -a "$xcode_app" "$project" "$mac_source" "$phone_source"; then
            opened=true
        fi
    fi
    xcode_executable="$xcode_app/Contents/MacOS/Xcode"
    if [ "$opened" != true ] && [ -x "$xcode_executable" ]; then
        "$xcode_executable" "$project" "$mac_source" "$phone_source" >/dev/null 2>&1 &
        opened=true
    fi
fi
if [ "$opened" != true ]; then
    echo "ERROR: the selected Xcode application could not be opened" >&2
    exit 1
fi
echo "Xcode launch requested for: $project"
echo "Before accepting runtime evidence, compare the Xcode-loaded source with the receipt hashes."
