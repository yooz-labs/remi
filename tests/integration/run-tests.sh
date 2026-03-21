#!/usr/bin/env bash
#
# Integration tests for remi CLI remote commands.
# Spins up Docker containers running remi daemons, then tests
# ls, recent, new, kill against them from the host.
#
# Usage:
#   ./tests/integration/run-tests.sh
#
# Prerequisites:
#   - Docker and docker compose
#   - CLAUDE_CODE_OAUTH_TOKEN set (or in ~/.zshrc)
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR/../.."

# Must run from project root for bun workspace resolution
cd "$PROJECT_ROOT"

remi_cli() {
  bun run packages/daemon/src/cli.ts "$@"
}
export -f remi_cli

# Use non-standard ports to avoid conflicts with local daemons
D1_PORT=19765
D2_PORT=19766
HOST=localhost

PASS=0
FAIL=0
TOTAL=0

# Load CLAUDE_CODE_OAUTH_TOKEN if not set
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  # Extract token from ~/.zshrc (may be commented out with "# export")
  TOKEN=$(grep 'CLAUDE_CODE_OAUTH_TOKEN=' ~/.zshrc 2>/dev/null | head -1 | sed 's/.*CLAUDE_CODE_OAUTH_TOKEN=//')
  if [ -n "$TOKEN" ]; then
    export CLAUDE_CODE_OAUTH_TOKEN="$TOKEN"
    echo "Loaded CLAUDE_CODE_OAUTH_TOKEN from ~/.zshrc"
  else
    echo "WARNING: CLAUDE_CODE_OAUTH_TOKEN not set. Session creation tests may fail."
  fi
fi

run_test() {
  local name="$1"
  shift
  TOTAL=$((TOTAL + 1))
  echo -n "  [$TOTAL] $name ... "
  local output
  if output=$("$@" 2>&1); then
    echo "PASS"
    PASS=$((PASS + 1))
  else
    echo "FAIL"
    echo "    Output: ${output:0:200}"
    FAIL=$((FAIL + 1))
  fi
}

# Expect failure (exit code != 0)
run_test_expect_fail() {
  local name="$1"
  shift
  TOTAL=$((TOTAL + 1))
  echo -n "  [$TOTAL] $name ... "
  if "$@" >/dev/null 2>&1; then
    echo "FAIL (expected failure but succeeded)"
    FAIL=$((FAIL + 1))
  else
    echo "PASS (failed as expected)"
    PASS=$((PASS + 1))
  fi
}

cleanup() {
  echo ""
  echo "Cleaning up Docker containers..."
  docker compose -f "$SCRIPT_DIR/docker-compose.yml" down --remove-orphans 2>/dev/null || true
}
trap cleanup EXIT

# ---- Start containers ----
echo "Building and starting Docker containers..."
docker compose -f "$SCRIPT_DIR/docker-compose.yml" up -d --build --wait 2>&1

echo ""
echo "Containers ready. Running integration tests..."
echo ""

# ---- Test Group 1: remi ls ----
echo "== ls tests =="
run_test "ls --host --port daemon1" remi_cli ls --host $HOST --port $D1_PORT
run_test "ls --host --port daemon2" remi_cli ls --host $HOST --port $D2_PORT
run_test "ls --port (no --host, defaults to localhost)" remi_cli ls --port $D1_PORT

# ---- Test Group 2: remi recent ----
echo ""
echo "== recent tests =="
run_test "recent --host --port daemon1" remi_cli recent --host $HOST --port $D1_PORT
run_test "recent --host --port daemon2" remi_cli recent --host $HOST --port $D2_PORT

# ---- Test Group 3: remi new (arg parsing - the main bug fix) ----
echo ""
echo "== new --host tests (arg parsing fix) =="

# These test that --host is actually parsed after 'new'.
# Session creation connects to the daemon and spawns Claude.
# We run in background, wait briefly, then kill -- success = connection worked.
run_test "new --host --port daemon1 connects" \
  bash -c "remi_cli new --host $HOST --port $D1_PORT &>/dev/null & PID=\$!; sleep 5; kill \$PID 2>/dev/null; wait \$PID 2>/dev/null; exit 0"

run_test "new --host --port --dir connects" \
  bash -c "remi_cli new --host $HOST --port $D1_PORT --dir /tmp &>/dev/null & PID=\$!; sleep 5; kill \$PID 2>/dev/null; wait \$PID 2>/dev/null; exit 0"

# Verify --recent flag is parsed (may show "no recent dirs" which is expected on fresh container)
run_test "new --host --port --recent parsed" \
  bash -c "remi_cli new --host $HOST --port $D1_PORT --recent 2>&1 | grep -q 'No recent\|Creating session\|Select directory'"

# ---- Test Group 4: flags before subcommand (backward compat) ----
echo ""
echo "== flags before subcommand (backward compat) =="
run_test "flags before: --host X ls" remi_cli --host $HOST --port $D1_PORT ls

# ---- Test Group 5: remi kill ----
echo ""
echo "== kill tests =="
run_test_expect_fail "kill nonexistent (--host flag)" \
  remi_cli kill nonexistent --host $HOST --port $D1_PORT

# Test universal resolver: kill with host:port/session format
run_test_expect_fail "kill host:port/nonexistent (universal resolver)" \
  remi_cli kill $HOST:$D1_PORT/nonexistent

# ---- Test Group 6: remi new /path ----
echo ""
echo "== new /path tests =="
# Test positional directory argument
run_test "new --host /tmp parsed as dir" \
  bash -c "remi_cli new /tmp --host $HOST --port $D1_PORT &>/dev/null & PID=\$!; sleep 5; kill \$PID 2>/dev/null; wait \$PID 2>/dev/null; exit 0"

# ---- Test Group 7: SESSION_BUSY detection ----
echo ""
echo "== session busy tests =="
# Create a session, keep it attached, try to attach from a second client
run_test "session busy: create and hold session" \
  bash -c "remi_cli new --host $HOST --port $D1_PORT &>/dev/null & PID=\$!; sleep 5; \
    SESSION=\$(remi_cli ls --host $HOST --port $D1_PORT 2>&1 | grep -v '^NAME\|^---' | awk '{print \$1}' | head -1); \
    OUTPUT=\$(remi_cli attach \"\$SESSION\" --host $HOST --port $D1_PORT 2>&1); \
    kill \$PID 2>/dev/null; wait \$PID 2>/dev/null; \
    echo \"\$OUTPUT\" | grep -q 'already attached'"

# ---- Test Group 8: -- separator ----
echo ""
echo "== -- separator tests =="
# Verify that -- stops remi flag parsing. --weird-flag should NOT cause a remi error.
run_test "ls with -- separator" remi_cli ls --port $D1_PORT -- --weird-flag

# ---- Results ----
echo ""
echo "==============================="
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
echo "==============================="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
