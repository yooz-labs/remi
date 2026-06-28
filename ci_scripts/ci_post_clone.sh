#!/bin/sh
# Xcode Cloud post-clone for Remi (#658).
#
# Remi is a bun monorepo: the Capacitor app lives in packages/web, NOT the repo
# root (unlike yooz-notes, whose Capacitor app is at the root). Xcode Cloud clones
# the repo root, so this script installs bun, installs the workspace deps, builds
# the web app, and syncs it into the native project before Xcode archives.
#
# The thin per-platform wrapper under <app>/ci_scripts calls this with
# YOOZ_XCODE_CLOUD_PLATFORM set; run directly it defaults to ios.
set -eu

# Keep in lockstep with .github/workflows/ci.yml (BUN_VERSION): 1.3.12's
# `bun build --compile` ships silent-exit binaries, so the whole pipeline pins.
BUN_VERSION="1.3.11"

PLATFORM="${YOOZ_XCODE_CLOUD_PLATFORM:-ios}"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
WEB_DIR="$REPO_ROOT/packages/web"

echo "[ci] Remi post-clone (platform=$PLATFORM, repo=$REPO_ROOT)"

# Xcode Cloud images do not ship bun. Download to a file first: in POSIX sh,
# `curl | bash` masks a curl failure behind bash's exit status, so a network
# error would slip past `set -e` and surface later as a confusing "bun: not
# found". Pin the version to match the rest of the pipeline.
if ! command -v bun >/dev/null 2>&1; then
  echo "[ci] installing bun v$BUN_VERSION"
  export BUN_INSTALL="$HOME/.bun"
  INSTALLER=$(mktemp /tmp/bun-install.XXXXXX.sh)
  if ! curl -fsSL https://bun.sh/install -o "$INSTALLER"; then
    echo "[ci] ERROR: failed to download the bun installer" >&2
    rm -f "$INSTALLER"
    exit 1
  fi
  bash "$INSTALLER" "bun-v$BUN_VERSION"
  rm -f "$INSTALLER"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi

echo "[ci] installing workspace dependencies"
cd "$REPO_ROOT"
bun install --frozen-lockfile

echo "[ci] building web app"
cd "$WEB_DIR"
bun run build

# Verify the build output BEFORE syncing it into the native project, so a build
# that exits 0 but produced no dist/ fails here instead of silently shipping an
# empty app.
if [ ! -f "$WEB_DIR/dist/index.html" ]; then
  echo "[ci] ERROR: $WEB_DIR/dist/index.html missing after build" >&2
  exit 1
fi

case "$PLATFORM" in
  ios)
    echo "[ci] syncing Capacitor iOS (SPM)"
    bunx cap sync ios
    ;;
  macos)
    # Phase 2 (#658): the native macOS shell embeds the same dist/; nothing to sync.
    echo "[ci] macOS: web dist prepared"
    ;;
  *)
    echo "[ci] unknown YOOZ_XCODE_CLOUD_PLATFORM '$PLATFORM'" >&2
    exit 1
    ;;
esac

echo "[ci] post-clone complete"
