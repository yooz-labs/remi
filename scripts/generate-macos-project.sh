#!/usr/bin/env bash
# Regenerate packages/macos/Remi.xcodeproj from project.yml (#649).
#
# Wraps `xcodegen generate` with one portability fix: xcodegen run under a
# new Xcode emits objectVersion 77 (Xcode 16.3+-only format), which older
# xcodebuilds (e.g. the macos-14 CI runner) refuse to open. The project uses
# no 77-only constructs, so pinning the version down keeps it readable
# everywhere. Always regenerate through this script, not bare xcodegen.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR/packages/macos"

command -v xcodegen >/dev/null 2>&1 || { echo "ERROR: xcodegen not found (brew install xcodegen)" >&2; exit 1; }
command -v bun >/dev/null 2>&1 || { echo "ERROR: bun not found (needed for the version re-stamp)" >&2; exit 1; }

xcodegen generate

PBXPROJ="Remi.xcodeproj/project.pbxproj"
sed -i '' 's/objectVersion = [0-9]*;/objectVersion = 56;/' "$PBXPROJ"
echo "Pinned $(grep -m1 objectVersion "$PBXPROJ" | tr -d '\t')"

# Regeneration resets MARKETING_VERSION/CURRENT_PROJECT_VERSION to the
# project.yml literals; re-stamp from the app's real version line (#658).
bun "$ROOT_DIR/scripts/sync-app-version.mjs"
