#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
builder="$script_dir/build-exact-native.sh"
for expected in \
    'REMI_SOURCE_COMMIT="$head_commit"' \
    '[ "$embedded" = "$head_commit" ]' \
    '[ "$installed_commit" = "$head_commit" ]' \
    'CODE_SIGNING_ALLOWED=NO' \
    'mac_scheme=RemiMac' \
    'phone_scheme=RemiPhone'; do
    grep -F "$expected" "$builder" >/dev/null || {
        echo "ERROR: exact-build guard is missing: $expected" >&2
        exit 1
    }
done

if "$builder" --expected does-not-exist >/dev/null 2>&1; then
    echo "ERROR: an unresolved expected commit was accepted" >&2
    exit 1
fi

echo "exact native build guard checks passed"
