#!/usr/bin/env bash
# Transcript-binding e2e harness primitives.
#
# Drives REAL `claude` sessions under a real remi daemon and observes binding,
# rotation, and persistence the way a remi client (the phone) would. This is a
# MANUAL / semi-automated harness: it needs a real authenticated `claude` and a
# trusted working directory. It is NOT wired into CI (see README.md).
#
# Source this in a scenario script. Required env (see README):
#   REMI_BIN       path to the remi binary to test (built from the branch)
#   E2E_TRUSTED    a claude-trusted working dir (hasTrustDialogAccepted=true)
# Optional:
#   E2E_STATE      scratch dir for logs/pids/fifos (default: mktemp -d)

set -uo pipefail

REMI_BIN="${REMI_BIN:?set REMI_BIN to the remi binary under test}"
E2E_TRUSTED="${E2E_TRUSTED:?set E2E_TRUSTED to a claude-trusted working dir}"
E2E_STATE="${E2E_STATE:-$(mktemp -d "${TMPDIR:-/tmp}/remi-tb-e2e-XXXXXX")}"
mkdir -p "$E2E_STATE"

# Strip ANSI/OSC so logs and renders are greppable.
deansi() { sed -E 's/\x1b\[[0-9;?]*[a-zA-Z]//g; s/\x1b\][0-9;]*\x07//g; s/\r//g'; }

# start_daemon NAME CWD PORT MODE(shadow|drive|off)
# Launches a daemon with ANTHROPIC_MODEL=haiku (claude --model is not forwarded
# by --daemon, but the daemon's env is, and claude honours ANTHROPIC_MODEL).
start_daemon() {
  local name=$1 cwd=$2 port=$3 mode=$4
  local log="$E2E_STATE/$name.log"
  rm -f "$log"
  local sh=false dr=false
  case "$mode" in
    shadow) sh=true ;;
    drive)  dr=true ;;
    off)    : ;;
  esac
  cat > "$E2E_STATE/launch-$name.sh" <<LAUNCH
#!/usr/bin/env bash
cd "$cwd"
exec "$REMI_BIN" --daemon --bind 127.0.0.1 --port $port --no-auth --no-relay --no-mdns
LAUNCH
  chmod +x "$E2E_STATE/launch-$name.sh"
  ANTHROPIC_MODEL=haiku \
  REMI_TRANSCRIPT_BINDER_SHADOW=$sh \
  REMI_TRANSCRIPT_BINDER_ENABLED=$dr \
    nohup bash "$E2E_STATE/launch-$name.sh" > "$log" 2>&1 &
  echo "$!" > "$E2E_STATE/$name.pid"
  echo "$port" > "$E2E_STATE/$name.port"
  echo "daemon[$name] pid=$(cat "$E2E_STATE/$name.pid") port=$port mode=$mode log=$log"
}

wait_ready() {
  local name=$1 secs=${2:-20}
  local log="$E2E_STATE/$name.log"
  local i
  for ((i = 0; i < secs; i++)); do
    grep -q "Remi daemon ready" "$log" 2>/dev/null && return 0
    kill -0 "$(cat "$E2E_STATE/$name.pid")" 2>/dev/null || { echo "daemon[$name] DIED"; tail -8 "$log"; return 1; }
    sleep 1
  done
  echo "daemon[$name] not ready in ${secs}s"; tail -8 "$log"; return 1
}

# Session id/name as `remi ls` reports it (one daemon = one session).
session_id() {
  "$REMI_BIN" ls --host 127.0.0.1 --port "$1" 2>/dev/null | deansi \
    | grep -iE 'active|idle|orphan|starting|available' | awk '{print $1}' | head -1
}

# attach_start NAME PORT SESSION
# Persistent FIFO-driven `remi attach` acting as BOTH input driver and observer
# (this is literally how a remi client drives claude). A holder keeps the FIFO
# write-end open so the attach never sees EOF across multiple sends.
attach_start() {
  local name=$1 port=$2 session=$3
  local fifo="$E2E_STATE/$name.fifo" render="$E2E_STATE/$name.render"
  rm -f "$fifo" "$render"; mkfifo "$fifo"
  nohup sleep 100000 > "$fifo" 2>/dev/null &
  echo "$!" > "$E2E_STATE/$name.holder.pid"
  nohup "$REMI_BIN" attach "$session" --host 127.0.0.1 --port "$port" < "$fifo" > "$render" 2>&1 &
  echo "$!" > "$E2E_STATE/$name.attach.pid"
}

# Type text then submit with a SEPARATE Enter. claude's composer treats the
# initial burst as a bracketed paste, so an inline \r is NOT a submit; the
# standalone Enter (a distinct write) is what submits.
prompt() {
  local name=$1; shift
  printf '%s' "$*" > "$E2E_STATE/$name.fifo"
  sleep 0.5
  printf '\r' > "$E2E_STATE/$name.fifo"
}
enter() { printf '\r' > "$E2E_STATE/$1.fifo"; }

attach_stop() {
  local name=$1
  kill "$(cat "$E2E_STATE/$name.attach.pid" 2>/dev/null)" 2>/dev/null
  kill "$(cat "$E2E_STATE/$name.holder.pid" 2>/dev/null)" 2>/dev/null
}

stop_daemon() {
  local name=$1
  kill -TERM "$(cat "$E2E_STATE/$name.pid" 2>/dev/null)" 2>/dev/null
  local i
  for ((i = 0; i < 8; i++)); do kill -0 "$(cat "$E2E_STATE/$name.pid" 2>/dev/null)" 2>/dev/null || break; sleep 0.5; done
  pkill -f "remi:$(cat "$E2E_STATE/$name.port" 2>/dev/null)" 2>/dev/null || true
}

# claude encodes the cwd into the transcript dir: / -> -
tdir_for() { echo "$HOME/.claude/projects/$(echo "$1" | sed 's#/#-#g')"; }

# Newest transcript in CWD carrying THIS daemon's `remi:<port>` head marker.
# Prints "<claudeId> <path>"; non-zero if none.
bound_transcript() {
  local cwd=$1 port=$2 td f
  td=$(tdir_for "$cwd")
  # Newest-first by mtime; filenames are controlled `<uuid>.jsonl` (no spaces).
  # shellcheck disable=SC2045
  for f in $(ls -t "$td"/*.jsonl 2>/dev/null); do
    if head -c 4000 "$f" 2>/dev/null | grep -q "remi:$port"; then
      echo "$(basename "$f" .jsonl) $f"; return 0
    fi
  done
  return 1
}

# Wait until a log line matching PATTERN (grep -E) appears, or time out.
wait_log() {
  local name=$1 pattern=$2 secs=${3:-20} i
  local log="$E2E_STATE/$name.log"
  for ((i = 0; i < secs; i++)); do
    grep -qE "$pattern" "$log" 2>/dev/null && return 0
    sleep 1
  done
  return 1
}

# Wait until a daemon binds a transcript with >= MINLINES lines. Prints id.
wait_bound() {
  local cwd=$1 port=$2 minlines=${3:-8} secs=${4:-100} i bt cid f
  for ((i = 0; i < secs; i += 2)); do
    if bt=$(bound_transcript "$cwd" "$port" 2>/dev/null); then
      cid=$(echo "$bt" | awk '{print $1}'); f=$(echo "$bt" | awk '{print $2}')
      [ "$(wc -l < "$f" 2>/dev/null || echo 0)" -ge "$minlines" ] && { echo "$cid"; return 0; }
    fi
    sleep 2
  done
  return 1
}
