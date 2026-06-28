#!/bin/sh
# Xcode Cloud runs the ci_scripts co-located with the selected workspace
# (packages/web/ios/App/App.xcworkspace). Delegate to the repo-root script, which
# does the monorepo-aware bun install + web build + `cap sync ios` (#658).
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../../../../.." && pwd)
YOOZ_XCODE_CLOUD_PLATFORM=ios exec "$REPO_ROOT/ci_scripts/ci_post_clone.sh"
