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

xcodegen generate

PBXPROJ="Remi.xcodeproj/project.pbxproj"
sed -i '' 's/objectVersion = [0-9]*;/objectVersion = 56;/' "$PBXPROJ"
echo "Pinned $(grep -m1 objectVersion "$PBXPROJ" | tr -d '\t')"
