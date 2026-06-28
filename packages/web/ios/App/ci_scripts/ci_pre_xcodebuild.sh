#!/bin/sh
# Xcode Cloud pre-build: stamp the iOS app version before archiving (#658).
#
# Marketing version comes from the app's own line (config/app-release.json); the
# build number comes from Xcode Cloud's monotonic CI_BUILD_NUMBER so every
# TestFlight upload increments. Local archives fall back to the config build.
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../../../../.." && pwd)
export PATH="$HOME/.bun/bin:$PATH"

if [ -n "${CI_BUILD_NUMBER:-}" ]; then
  bun "$REPO_ROOT/scripts/sync-app-version.mjs" --build "$CI_BUILD_NUMBER"
else
  bun "$REPO_ROOT/scripts/sync-app-version.mjs"
fi
