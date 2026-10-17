#!/bin/bash
# Static contract for the hosted native-app gate (#1541).
set -euo pipefail

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
WORKFLOW="$REPO_ROOT/.github/workflows/native-app.yml"
fail() { echo "FAIL: $*" >&2; exit 1; }
contains() { grep -Fq -- "$2" "$1" || fail "$3"; }

contains "$WORKFLOW" 'runs-on: xcode-27' "workflow is not on the Xcode 27 image"
contains "$WORKFLOW" 'packages/native/**' "native changes do not trigger the workflow"
contains "$WORKFLOW" 'scripts/testflight-ios.sh' "release script changes do not trigger the workflow"
contains "$WORKFLOW" 'native-app.yml' "workflow does not trigger for its own changes"
contains "$WORKFLOW" 'cancel-in-progress:' "superseded PR runs are not cancelled"
contains "$WORKFLOW" 'actions/checkout@v5' "checkout action is not pinned"
contains "$WORKFLOW" 'xcodebuild -version' "Xcode version is not recorded"
contains "$WORKFLOW" 'Xcode 27' "Xcode major is not validated"
contains "$WORKFLOW" '"$RUNNER_TEMP/xcode-version.txt"' "Xcode validation does not read the complete captured output"
contains "$WORKFLOW" 'swift --version' "Swift version is not recorded"
contains "$WORKFLOW" 'Swift version' "Swift version is not validated"
contains "$WORKFLOW" '"$RUNNER_TEMP/swift-version.txt"' "Swift validation does not read the complete captured output"
contains "$WORKFLOW" 'swift test' "RemiKit tests are absent"
contains "$WORKFLOW" '-scheme RemiMac' "RemiMac is not built"
contains "$WORKFLOW" '-configuration Debug' "Debug configuration is not built"
contains "$WORKFLOW" '-configuration Release' "Release configuration is not built"
contains "$WORKFLOW" 'platform=macOS' "macOS destination is absent"
contains "$WORKFLOW" '-scheme RemiPhone' "RemiPhone is not built"
contains "$WORKFLOW" 'generic/platform=iOS Simulator' "iOS simulator build is absent"
contains "$WORKFLOW" 'generic/platform=iOS' "generic iOS build is absent"
contains "$WORKFLOW" 'CODE_SIGNING_ALLOWED=NO' "CI builds unexpectedly require signing"
contains "$WORKFLOW" 'test-testflight-ios.sh' "release contract test is absent"
contains "$WORKFLOW" '--unsigned-archive' "payload archive validation is absent"
contains "$WORKFLOW" 'acceptance-receipt.txt' "archive receipt is not retained"
contains "$WORKFLOW" 'git diff --exit-code' "tracked-source mutation is not rejected"
contains "$WORKFLOW" 'if: always()' "failure evidence is not retained"
contains "$WORKFLOW" 'actions/upload-artifact@v4' "evidence uploader is not pinned"
contains "$WORKFLOW" 'timeout-minutes: 45' "job has no bounded timeout"
contains "$WORKFLOW" 'contents: read' "workflow permissions are not least-privilege"

echo "PASS: native CI workflow contract"
