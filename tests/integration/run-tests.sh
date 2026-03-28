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

# ---- Multi-client helpers ----
C1=remi-test-client1
C1_IP=172.28.0.12
c1_remi() { docker exec $C1 remi "$@"; }

# Start remi attach in background inside a container.
# Returns the PID of the remi attach process.
bg_attach() {
  local ctr=$1; shift
  docker exec "$ctr" bash -c 'sleep infinity | remi attach "$@" &>/dev/null & echo $!' -- "$@"
}

# Kill a process inside a container
ckill() { docker exec "$1" kill "$2" 2>/dev/null || true; }

# Poll until session becomes occupied (no 'available to attach' in ls).
# Args after timeout are passed to remi ls (e.g., --host/--port).
wait_occupied() {
  local ctr=$1 secs=${2:-5}; shift 2 || shift $#
  local output
  for i in $(seq 1 "$secs"); do
    if output=$(docker exec "$ctr" remi ls "${@}" 2>&1); then
      if ! echo "$output" | grep -qF 'available to attach'; then return 0; fi
    fi
    sleep 1
  done
  return 1
}

# Poll until session becomes available ('available to attach' in ls).
# Args after timeout are passed to remi ls (e.g., --host/--port).
wait_available() {
  local ctr=$1 secs=${2:-5}; shift 2 || shift $#
  local output
  for i in $(seq 1 "$secs"); do
    if output=$(docker exec "$ctr" remi ls "${@}" 2>&1); then
      if echo "$output" | grep -qF 'available to attach'; then return 0; fi
    fi
    sleep 1
  done
  return 1
}

# Poll until a process exits inside a container
wait_exit() {
  local ctr=$1 pid=$2 secs=${3:-5}
  for i in $(seq 1 "$secs"); do
    if ! docker exec "$ctr" kill -0 "$pid" 2>/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}

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

# Verify daemon2 is still alive after remote spawn attempt
run_test "daemon2 still running after remote spawn" \
  bash -c "docker exec $D2 remi ls 2>&1 | grep -q 'session\|idle\|active\|api-server'"

# ==== Test Group 5: Config system ====
echo ""
echo "== config system =="
run_test "config shows defaults" \
  bash -c "docker exec $D1 remi config 2>&1 | grep -q 'base_port = 18765'"
run_test "config init creates file" \
  bash -c "docker exec $D1 remi config init 2>&1; docker exec $D1 test -f /root/.remi/config.toml"
run_test_expect_fail "config init rejects duplicate" \
  docker exec $D1 remi config init
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

# ==== Test Group 8: Attach lifecycle ====
echo ""
echo "== attach lifecycle =="

PID_A=$(bg_attach $D1)
wait_occupied $D1 5

run_test "attach process stays alive" \
  bash -c "docker exec $D1 kill -0 $PID_A"

run_test "attached session shows occupied" \
  bash -c "! docker exec $D1 remi ls 2>&1 | grep -qF 'available to attach'"

ckill $D1 $PID_A
wait_available $D1 5

run_test "session available after disconnect" \
  bash -c "docker exec $D1 remi ls 2>&1 | grep -qF 'available to attach'"

# Re-attach to same session
PID_A2=$(bg_attach $D1)
wait_occupied $D1 5

run_test "re-attach occupies session again" \
  bash -c "! docker exec $D1 remi ls 2>&1 | grep -qF 'available to attach'"

ckill $D1 $PID_A2
wait_available $D1 5

# ==== Test Group 9: Multi-client local contention ====
echo ""
echo "== multi-client local contention =="

PID_MC1=$(bg_attach $D1)
wait_occupied $D1 5

PID_MC2=$(bg_attach $D1)
sleep 2

run_test "second client alive but session occupied by first" \
  bash -c "docker exec $D1 kill -0 $PID_MC2 && ! docker exec $D1 remi ls 2>&1 | grep -qF 'available to attach'"

run_test "ls works during multi-client contention" d1_remi ls

# Kill second client; first should retain
ckill $D1 $PID_MC2
sleep 1

run_test "first client retains after second disconnects" \
  bash -c "! docker exec $D1 remi ls 2>&1 | grep -qF 'available to attach'"

# Kill first client; session becomes available
ckill $D1 $PID_MC1
wait_available $D1 5

run_test "session available after both clients disconnect" \
  bash -c "docker exec $D1 remi ls 2>&1 | grep -qF 'available to attach'"

# New client attaches after contention
PID_MC3=$(bg_attach $D1)
wait_occupied $D1 5

run_test "new client attaches after contention resolved" \
  bash -c "! docker exec $D1 remi ls 2>&1 | grep -qF 'available to attach'"

ckill $D1 $PID_MC3
wait_available $D1 5

# ==== Test Group 10: Cross-container attach ====
echo ""
echo "== cross-container attach =="

PID_XC=$(bg_attach $C1 --host $D1_IP --port $PORT)
wait_occupied $D1 5

run_test "cross-container attach process alive" \
  bash -c "docker exec $C1 kill -0 $PID_XC"

run_test "remote client occupies D1 session" \
  bash -c "! docker exec $D1 remi ls 2>&1 | grep -qF 'available to attach'"

run_test "D2 can ls D1 while remote client attached" \
  d2_remi ls --host $D1_IP --port $PORT

# D1 tries to attach its own session while remote holds it
PID_XC_LOCAL=$(bg_attach $D1)
sleep 2

run_test "local client cannot displace remote attach" \
  bash -c "! docker exec $D1 remi ls 2>&1 | grep -qF 'available to attach'"

ckill $D1 $PID_XC_LOCAL
ckill $C1 $PID_XC
wait_available $D1 5

run_test "D1 session available after remote disconnects" \
  bash -c "docker exec $D1 remi ls 2>&1 | grep -qF 'available to attach'"

# ==== Test Group 11: Three-client contention ====
echo ""
echo "== three-client contention =="

# C1 attaches first (remote to D1)
PID_3A=$(bg_attach $C1 --host $D1_IP --port $PORT)
wait_occupied $D1 5

# D2 also tries (remote to D1)
PID_3B=$(bg_attach $D2 --host $D1_IP --port $PORT)
sleep 2

# D1 tries locally
PID_3C=$(bg_attach $D1)
sleep 2

run_test "three clients: all processes alive" \
  bash -c "docker exec $C1 kill -0 $PID_3A && docker exec $D2 kill -0 $PID_3B && docker exec $D1 kill -0 $PID_3C"

run_test "three clients: session remains occupied" \
  bash -c "! docker exec $D1 remi ls 2>&1 | grep -qF 'available to attach'"

# Kill second and third; first retains
ckill $D2 $PID_3B
ckill $D1 $PID_3C
sleep 1

run_test "three clients: first retains after others disconnect" \
  bash -c "! docker exec $D1 remi ls 2>&1 | grep -qF 'available to attach'"

# Kill first; session available
ckill $C1 $PID_3A
wait_available $D1 5

run_test "three clients: session available after all disconnect" \
  bash -c "docker exec $D1 remi ls 2>&1 | grep -qF 'available to attach'"

# New client can take over
PID_3D=$(bg_attach $D2 --host $D1_IP --port $PORT)
wait_occupied $D1 5

run_test "new client attaches after three-way contention" \
  bash -c "! docker exec $D1 remi ls 2>&1 | grep -qF 'available to attach'"

ckill $D2 $PID_3D
wait_available $D1 5

# ==== Test Group 12: Edge cases ====
echo ""
echo "== edge cases =="

run_test "concurrent ls: D1 local" d1_remi ls
run_test "concurrent ls: D2 local" d2_remi ls
run_test "concurrent ls: C1 to D1" c1_remi ls --host $D1_IP --port $PORT
run_test "concurrent ls: C1 to D2" c1_remi ls --host $D2_IP --port $PORT

# Rapid attach/detach cycles (3 rounds)
RAPID_OK=true
for round in 1 2 3; do
  PID_RAPID=$(bg_attach $D1)
  if ! wait_occupied $D1 3; then RAPID_OK=false; break; fi
  ckill $D1 $PID_RAPID
  if ! wait_available $D1 3; then RAPID_OK=false; break; fi
done

run_test "session stable after rapid attach/detach cycles" \
  bash -c "$RAPID_OK && docker exec $D1 remi ls 2>&1 | grep -qF 'available to attach'"

# Session name visible while occupied
PID_NAME=$(bg_attach $D1)
wait_occupied $D1 5

run_test "occupied session still shows project name in ls" \
  bash -c "docker exec $D1 remi ls 2>&1 | grep -q 'sample-app'"

ckill $D1 $PID_NAME
wait_available $D1 5

# Cross-container ls sees correct occupancy
PID_OCC=$(bg_attach $D1)
wait_occupied $D1 5

run_test "remote ls reflects occupancy (no * for occupied session)" \
  bash -c "! docker exec $C1 remi ls --host $D1_IP --port $PORT 2>&1 | grep -qF 'available to attach'"

ckill $D1 $PID_OCC
wait_available $D1 5

run_test "remote ls reflects availability after disconnect" \
  bash -c "docker exec $C1 remi ls --host $D1_IP --port $PORT 2>&1 | grep -qF 'available to attach'"

# ==== Test Group 13: Kill while attached (destructive, uses D1) ====
echo ""
echo "== kill while attached =="

# Attach C1 to D1 (D1 session is in known-good state from prior tests)
PID_KA=$(bg_attach $C1 --host $D1_IP --port $PORT)
wait_occupied $D1 10

run_test "client attached before kill" \
  bash -c "docker exec $C1 kill -0 $PID_KA"

run_test "session occupied before kill" \
  bash -c "! docker exec $D1 remi ls 2>&1 | grep -qF 'available to attach'"

# Extract session name for kill command
D1_KILL_SESSION=$(docker exec $D1 remi ls 2>&1 | grep -E 'active|idle' | awk '{print $1}' | head -1)

run_test "kill occupied session from owning daemon" \
  d1_remi kill "$D1_KILL_SESSION"

wait_exit $C1 $PID_KA 5

run_test "attached client exits after session killed" \
  bash -c "! docker exec $C1 kill -0 $PID_KA 2>/dev/null"

run_test "daemon still responds after session killed" d1_remi ls

# ---- Results ----
echo ""
echo "==============================="
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
echo "==============================="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
