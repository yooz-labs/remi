#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
launcher="$script_dir/open-exact-xcode.sh"
head_commit=$(git -C "$script_dir/../../.." rev-parse HEAD)
scratch=$(mktemp -d "${TMPDIR:-/tmp}/remi-xcode-source-test.XXXXXX")
trap 'rm -rf "$scratch"' EXIT HUP INT TERM

output=$($launcher --check-only --expected "$head_commit" --receipt-dir "$scratch/receipt")
receipt="$scratch/receipt/source-receipt.txt"
test -f "$receipt"
grep -F "Exact native source: $head_commit" <<EOF
$output
EOF
grep -F "commit=$head_commit" "$receipt"
grep -F "project=$(CDPATH= cd -- "$script_dir/.." && pwd -P)/Remi.xcodeproj" "$receipt"
grep -E '^project_sha256=[0-9a-f]{64}$' "$receipt"
grep -E '^mac_sha256=[0-9a-f]{64}$' "$receipt"
grep -E '^phone_sha256=[0-9a-f]{64}$' "$receipt"

wrong_commit=$(git -C "$script_dir/../../.." rev-parse HEAD^)
if $launcher --check-only --expected "$wrong_commit" --receipt-dir "$scratch/wrong" >"$scratch/out" 2>"$scratch/error"; then
    echo "ERROR: wrong expected commit was accepted" >&2
    exit 1
fi
grep -E 'expected commit does not resolve|checkout is .* expected' "$scratch/error"

echo "exact Xcode source launcher checks passed"
