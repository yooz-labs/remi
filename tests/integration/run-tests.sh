#!/usr/bin/env bash
#
# Integration tests for remi using Docker containers.
#
# Tests run the compiled remi binary inside Docker containers on a shared
# network, simulating real-world multi-machine scenarios.
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
cd "$PROJECT_ROOT"

# Container names and IPs
D1=remi-test-daemon1
D2=remi-test-daemon2
D1_IP=172.28.0.10
D2_IP=172.28.0.11
PORT=18765

PASS=0
FAIL=0
TOTAL=0

# Load CLAUDE_CODE_OAUTH_TOKEN if not set
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
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
    echo "    Output: ${output:0:300}"
    FAIL=$((FAIL + 1))
  fi
}

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

# Run remi inside a container
d1_remi() { docker exec $D1 remi "$@"; }
d2_remi() { docker exec $D2 remi "$@"; }

cleanup() {
  echo ""
  echo "Cleaning up Docker containers..."
  docker compose -f "$SCRIPT_DIR/docker-compose.yml" down --remove-orphans 2>/dev/null || true
}
trap cleanup EXIT

# ---- Build and start containers ----
echo "Building and starting Docker containers..."
echo "(This builds the remi binary inside Docker, may take a minute on first run)"
docker compose -f "$SCRIPT_DIR/docker-compose.yml" up -d --build --wait 2>&1

echo ""
echo "Containers ready. Running integration tests..."
echo ""

# ==== Test Group 1: Binary installation ====
echo "== binary installation =="
run_test "remi binary exists on daemon1" docker exec $D1 which remi
run_test "remi binary exists on daemon2" docker exec $D2 which remi
run_test "remi --version works" docker exec $D1 remi --version

# ==== Test Group 2: Session listing ====
echo ""
echo "== session listing =="
run_test "ls on daemon1 shows session" d1_remi ls
run_test "ls on daemon2 shows session" d2_remi ls
run_test "ls shows project name (sample-app)" \
  bash -c "docker exec $D1 remi ls 2>&1 | grep -q 'sample-app'"
run_test "ls shows project name (api-server)" \
  bash -c "docker exec $D2 remi ls 2>&1 | grep -q 'api-server'"

# ==== Test Group 3: Cross-container ls ====
echo ""
echo "== cross-container discovery =="
run_test "daemon1 can ls daemon2" d1_remi ls --host $D2_IP --port $PORT
run_test "daemon2 can ls daemon1" d2_remi ls --host $D1_IP --port $PORT

# ==== Test Group 4: Remote daemon spawning ====
echo ""
echo "== remote daemon spawning =="

# daemon1 asks daemon2 to spawn a new session in /projects/sample-app
run_test "remote spawn: daemon1 triggers new daemon on daemon2" \
  bash -c "docker exec $D1 bash -c \
    'remi new --host $D2_IP --port $PORT --dir /projects/sample-app &>/dev/null & PID=\$!; sleep 12; kill \$PID 2>/dev/null; wait \$PID 2>/dev/null; exit 0'"

# Verify daemon2 now has sessions on multiple ports
run_test "daemon2 has sessions on multiple ports after spawn" \
  bash -c "OUTPUT=\$(docker exec $D2 remi ls 2>&1); \
    echo \"\$OUTPUT\"; \
    echo \"\$OUTPUT\" | grep -c 'session\|idle\|active' | grep -q '[2-9]'"

# ==== Test Group 5: Config system ====
echo ""
echo "== config system =="
run_test "config shows defaults" \
  bash -c "docker exec $D1 remi config 2>&1 | grep -q 'base_port = 18765'"
run_test "config init creates file" \
  bash -c "docker exec $D1 remi config init 2>&1 | grep -q 'Config file created'"
run_test "config init rejects duplicate" \
  bash -c "! docker exec $D1 remi config init 2>&1 | grep -q 'already exists' || exit 1; exit 0"
run_test "config path shows location" \
  bash -c "docker exec $D1 remi config path 2>&1 | grep -q 'config.toml'"

# ==== Test Group 6: Kill session ====
echo ""
echo "== kill session =="
run_test_expect_fail "kill nonexistent session" d1_remi kill nonexistent
run_test_expect_fail "kill nonexistent on remote" d1_remi kill nonexistent --host $D2_IP --port $PORT

# ==== Test Group 7: Help and CLI ====
echo ""
echo "== help and CLI =="
run_test "help shows config command" \
  bash -c "docker exec $D1 remi --help 2>&1 | grep -q 'config'"
run_test "help shows reload command" \
  bash -c "docker exec $D1 remi --help 2>&1 | grep -q 'reload'"
run_test "-- separator works" d1_remi ls -- --weird-flag

# ---- Results ----
echo ""
echo "==============================="
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
echo "==============================="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
