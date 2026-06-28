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

# Fail loudly with a pointer rather than a bare "bun: not found" if the
# post-clone install didn't carry over to this phase.
if ! command -v bun >/dev/null 2>&1; then
  echo "[ci] ERROR: bun not on PATH (expected ci_post_clone.sh to install it to \$HOME/.bun)" >&2
  exit 1
fi
if [ ! -f "$REPO_ROOT/scripts/sync-app-version.mjs" ]; then
  echo "[ci] ERROR: sync-app-version.mjs not found at $REPO_ROOT/scripts (REPO_ROOT wrong?)" >&2
  exit 1
fi

if [ -n "${CI_BUILD_NUMBER:-}" ]; then
  bun "$REPO_ROOT/scripts/sync-app-version.mjs" --build "$CI_BUILD_NUMBER"
else
  bun "$REPO_ROOT/scripts/sync-app-version.mjs"
fi
