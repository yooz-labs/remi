#!/bin/bash
# bump-version.sh - Bump version, commit, tag, and optionally push to trigger release
#
# Usage:
#   ./scripts/bump-version.sh patch          # 0.2.3 -> 0.2.4
#   ./scripts/bump-version.sh minor          # 0.2.3 -> 0.3.0
#   ./scripts/bump-version.sh major          # 0.2.3 -> 1.0.0
#   ./scripts/bump-version.sh dev            # 0.2.3 -> 0.2.4-dev.1 (or -dev.N+1)
#   ./scripts/bump-version.sh set 1.0.0      # Set specific version
#   ./scripts/bump-version.sh --push patch   # Bump and push (triggers release)
#   ./scripts/bump-version.sh --push dev     # Bump dev and push (triggers dev release)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PKG_JSON="$ROOT_DIR/package.json"

if [[ ! -f "$PKG_JSON" ]]; then
  echo "Error: package.json not found. Run from project root or scripts/ directory." >&2
  exit 1
fi

# Parse flags
PUSH=false
while [[ "${1:-}" == --* ]]; do
  case "$1" in
    --push) PUSH=true; shift ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

BUMP_TYPE="${1:-}"
if [[ -z "$BUMP_TYPE" ]]; then
  echo "Usage: $0 [--push] <patch|minor|major|dev|set <version>>" >&2
  exit 1
fi

# Read current version from package.json
CURRENT_VERSION=$(node -e "process.stdout.write(require('$PKG_JSON').version)")
echo "Current: v$CURRENT_VERSION"

# Extract base version and any prerelease suffix
BASE_VERSION="${CURRENT_VERSION%%-*}"
PRERELEASE="${CURRENT_VERSION#"$BASE_VERSION"}"

# Parse base version components
IFS='.' read -r MAJOR MINOR PATCH <<< "$BASE_VERSION"

case "$BUMP_TYPE" in
  major)
    MAJOR=$((MAJOR + 1))
    MINOR=0
    PATCH=0
    NEW_VERSION="$MAJOR.$MINOR.$PATCH"
    ;;
  minor)
    MINOR=$((MINOR + 1))
    PATCH=0
    NEW_VERSION="$MAJOR.$MINOR.$PATCH"
    ;;
  patch)
    PATCH=$((PATCH + 1))
    NEW_VERSION="$MAJOR.$MINOR.$PATCH"
    ;;
  dev)
    if [[ "$PRERELEASE" =~ ^-dev\.([0-9]+)$ ]]; then
      # Already a dev version; increment dev number
      DEV_NUM="${BASH_REMATCH[1]}"
      DEV_NUM=$((DEV_NUM + 1))
      NEW_VERSION="$MAJOR.$MINOR.$PATCH-dev.$DEV_NUM"
    else
      # Stable version; bump patch and start dev.1
      PATCH=$((PATCH + 1))
      NEW_VERSION="$MAJOR.$MINOR.$PATCH-dev.1"
    fi
    ;;
  set)
    NEW_VER="${2:-}"
    if [[ -z "$NEW_VER" ]]; then
      echo "Usage: $0 set <version>" >&2
      echo "Example: $0 set 1.0.0" >&2
      exit 1
    fi
    if ! [[ "$NEW_VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-.+)?$ ]]; then
      echo "Error: version must be semver (e.g. 1.0.0), got: $NEW_VER" >&2
      exit 1
    fi
    NEW_VERSION="$NEW_VER"
    ;;
  *)
    echo "Usage: $0 [--push] <patch|minor|major|dev|set <version>>" >&2
    exit 1
    ;;
esac

if [[ "$NEW_VERSION" == "$CURRENT_VERSION" ]]; then
  echo "Version is already $CURRENT_VERSION, nothing to do." >&2
  exit 0
fi

echo "New:     v$NEW_VERSION"

# Update package.json
PKG_FILE="$PKG_JSON" PKG_VERSION="$NEW_VERSION" node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync(process.env.PKG_FILE, 'utf8'));
pkg.version = process.env.PKG_VERSION;
fs.writeFileSync(process.env.PKG_FILE, JSON.stringify(pkg, null, 2) + '\n');
"

echo "Updated package.json"

# Update compiled version fallback in cli.ts
CLI_TS="$ROOT_DIR/packages/daemon/src/cli.ts"
if [[ -f "$CLI_TS" ]]; then
  if ! grep -q "REMI_COMPILED_VERSION" "$CLI_TS"; then
    echo "Error: REMI_COMPILED_VERSION marker not found in cli.ts." >&2
    echo "Was the version fallback format changed?" >&2
    exit 1
  fi
  # Portable sed in-place: macOS uses -i '', GNU uses -i without arg
  # Pattern matches stable (0.4.3) and prerelease (0.4.4-dev.1) versions
  if [[ "$(uname)" == "Darwin" ]]; then
    sed -i '' "s/return '[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*[^']*'; \/\/ REMI_COMPILED_VERSION/return '$NEW_VERSION'; \/\/ REMI_COMPILED_VERSION/" "$CLI_TS"
  else
    sed -i "s/return '[0-9]\+\.[0-9]\+\.[0-9]\+[^']*'; \/\/ REMI_COMPILED_VERSION/return '$NEW_VERSION'; \/\/ REMI_COMPILED_VERSION/" "$CLI_TS"
  fi
  if ! grep -q "return '$NEW_VERSION'; // REMI_COMPILED_VERSION" "$CLI_TS"; then
    echo "Error: sed substitution failed; cli.ts version not updated." >&2
    exit 1
  fi
  echo "Updated cli.ts compiled version fallback"
fi

# Check for uncommitted changes beyond our version bump
if ! git diff --quiet -- ':!package.json' ':!packages/daemon/src/cli.ts'; then
  echo "Warning: you have other uncommitted changes. Only version files will be committed." >&2
fi

# Commit and tag
git add "$PKG_JSON" "$CLI_TS"
git commit -m "chore: bump version to $NEW_VERSION"
git tag "v$NEW_VERSION"

echo "Committed and tagged v$NEW_VERSION"

if [[ "$PUSH" == true ]]; then
  echo "Pushing to origin (this will trigger the release pipeline)..."
  git push origin HEAD
  git push origin "v$NEW_VERSION"
  echo "Done. Release pipeline triggered for v$NEW_VERSION."
else
  echo ""
  echo "To trigger a release:"
  echo "  git push origin HEAD && git push origin v$NEW_VERSION"
fi
