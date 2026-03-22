#!/usr/bin/env bash
#
# Integration tests for remi CLI remote commands.
# Spins up Docker containers running remi daemons, then tests
# ls, recent, new, kill against them from the host and cross-container.
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

# Docker container IPs on the test network
D1_DOCKER_IP=172.28.0.10
D2_DOCKER_IP=172.28.0.11
DAEMON_PORT=18765  # Internal port inside containers

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

# Run remi CLI inside a Docker container
docker_remi() {
  local container="$1"
  shift
  docker exec "$container" bun run packages/daemon/src/cli.ts "$@"
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

# ---- Test Group 1: remi ls (from host via port mapping) ----
echo "== ls tests =="
run_test "ls --host --port daemon1" remi_cli ls --host $HOST --port $D1_PORT
run_test "ls --host --port daemon2" remi_cli ls --host $HOST --port $D2_PORT
run_test "ls --port (no --host, defaults to localhost)" remi_cli ls --port $D1_PORT

# ---- Test Group 2: remi recent ----
echo ""
echo "== recent tests =="
run_test "recent --host --port daemon1" remi_cli recent --host $HOST --port $D1_PORT
run_test "recent --host --port daemon2" remi_cli recent --host $HOST --port $D2_PORT

# ---- Test Group 3: remi new --host (cross-container via docker exec) ----
echo ""
echo "== new --host tests (remote daemon spawning) =="

# daemon1 asks daemon2 to spawn a new session (cross-container, same Docker network)
# This tests the full flow: create_session_request -> spawn daemon -> return port -> attach
run_test "new --host from daemon1 to daemon2 spawns daemon" \
  bash -c "docker exec remi-test-daemon1 bash -c \
    'bun run packages/daemon/src/cli.ts new --host $D2_DOCKER_IP --port $DAEMON_PORT --dir /tmp &>/dev/null & PID=\$!; sleep 12; kill \$PID 2>/dev/null; wait \$PID 2>/dev/null; exit 0'"

# Verify daemon2 now has sessions on multiple ports
run_test "ls on daemon2 shows spawned session" \
  bash -c "OUTPUT=\$(docker_remi remi-test-daemon2 ls 2>&1); \
    echo \"\$OUTPUT\"; \
    echo \"\$OUTPUT\" | grep -c 'session\|idle\|active' | grep -q '[1-9]'"

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

# ---- Test Group 6: -- separator ----
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
