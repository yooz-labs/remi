#!/usr/bin/env bash
# Transcript-binding e2e runner. Executes the validated failure-mode scenarios
# against a real claude + real daemon and prints PASS/FAIL per check.
#
#   REMI_BIN=/path/to/remi E2E_TRUSTED=/private/tmp/remi-tb-e2e ./run.sh
#
# See README.md for prerequisites (trusted dir, real claude auth) and what each
# scenario validates. Exit code = number of failed checks.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"

# reset_cwd deletes this dir's transcript history AND its .claude (trust+hooks).
# Refuse to run unless E2E_TRUSTED is a throwaway temp path, so a wrong value
# can never delete a real project's history/config.
case "$E2E_TRUSTED" in
  /tmp/* | /private/tmp/* | /var/folders/*) ;;
  *) echo "ABORT: E2E_TRUSTED must be under a temp dir (/tmp, /private/tmp, /var/folders); got: $E2E_TRUSTED"; exit 1 ;;
esac

PASS=0; FAIL=0
ok()   { echo "  PASS: $1"; PASS=$((PASS + 1)); }
bad()  { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }
check(){ if eval "$2"; then ok "$1"; else bad "$1 ($2)"; fi; }

CWD="$E2E_TRUSTED"
# Isolate each scenario: drop the daemon hook config AND the transcript history
# for this cwd, so a prior run's same-port transcripts cannot contaminate the
# dir-poll. E2E_TRUSTED MUST be a throwaway scratch dir (see README).
reset_cwd() {
  rm -rf "$CWD/.claude" 2>/dev/null
  rm -f "$(tdir_for "$CWD")"/*.jsonl 2>/dev/null
}

EXPLORE="Read README.md or list the files here, then give a 2-sentence summary. Read-only, do not modify anything."

# ---------------------------------------------------------------------------
echo "### Scenario 1: SINGLE DAEMON — bind + /clear rotation (hook or dir-poll) + /compact"
# ---------------------------------------------------------------------------
# The TranscriptBinder is the single, unconditional binding path (#470/#503) —
# there is no shadow/drive mode to select; every check below exercises the
# real driving path. See failure-mode-matrix.md -> "The oracle".
reset_cwd
start_daemon s1 "$CWD" 18811; wait_ready s1 || exit 1
SID=$(session_id 18811); attach_start s1 18811 "$SID"; sleep 2
prompt s1 "$EXPLORE"
A=$(wait_bound "$CWD" 18811 8 100) || { bad "initial bind"; A=""; }
[ -n "$A" ] && ok "claude bound (honoured pre-assigned --session-id): $A"
check "binder drove the bind" "grep -q 'Binder] Lock adopted' '$E2E_STATE/s1.log'"

prompt s1 "/clear"
wait_log s1 "DirPollRotation|restart detected" 25
B=$(bound_transcript "$CWD" 18811 2>/dev/null | awk '{print $1}')
check "/clear rotated to a NEW id (B != A)" "[ -n '$B' ] && [ '$B' != '$A' ]"
check "rotation announced exactly once" "[ \$(grep -c '\[Binder\] Claude restart detected' '$E2E_STATE/s1.log') -eq 1 ]"
check "no Transcript-not-found wedge" "[ \$(grep -ci 'not found' '$E2E_STATE/s1.log') -eq 0 ]"
# Hooks are up in this scenario, so which mechanism observes the /clear
# rotation first is a genuine race (a local readdir tick vs. a hook POST
# round-trip) — NOT a bug either way. The dir-poll firing is not required
# here; only the hooks-DOWN leg (fm-452, manual, see failure-mode-matrix.md)
# forces it to be the sole path. Report which mechanism won as informational,
# but if the dir-poll DID engage, its own two log lines must both be present.
if grep -q 'No-hooks rotation detected via dir poll' "$E2E_STATE/s1.log"; then
  ok "dir-poll (#452 machinery) engaged this run: No-hooks rotation detected via dir poll"
  check "dir-poll rebound + rearmed watcher on B" "grep -q 'Transcript from DirPollRotation' '$E2E_STATE/s1.log'"
else
  ok "hook path caught the rotation first this run (dir-poll backstop did not need to engage)"
fi

Bf=$(tdir_for "$CWD")/$B.jsonl; Af=$(tdir_for "$CWD")/$A.jsonl
bb=$(wc -l < "$Bf" 2>/dev/null || echo 0); ab=$(wc -l < "$Af" 2>/dev/null || echo 0)
prompt s1 "Say the word DELTA."
for i in $(seq 1 20); do [ "$(wc -l < "$Bf" 2>/dev/null||echo 0)" -gt "$bb" ] && break; sleep 2; done
check "follow-up landed in rotated session B" "[ \$(grep -c DELTA '$Bf' 2>/dev/null) -ge 1 ]"
check "old session A stayed frozen"           "[ \$(wc -l < '$Af' 2>/dev/null) -eq $ab ]"

rc=$(grep -c 'rotation detected\|restart detected\|DirPollRotation' "$E2E_STATE/s1.log")
prompt s1 "/compact"; sleep 12
check "/compact did NOT rotate or over-fire the dir-poll" "[ \$(grep -c 'rotation detected\|restart detected\|DirPollRotation' '$E2E_STATE/s1.log') -eq $rc ]"
attach_stop s1; stop_daemon s1

# ---------------------------------------------------------------------------
echo "### Scenario 2: TWO daemons, same cwd — cross-bind (fm-427) + zombie (fm-451)"
# ---------------------------------------------------------------------------
reset_cwd
start_daemon d1 "$CWD" 18813; wait_ready d1 || exit 1
sleep 2   # stagger so the two daemons do not collide writing ~/.remi/sessions.json
start_daemon d2 "$CWD" 18814; wait_ready d2 || exit 1
S1=$(session_id 18813); S2=$(session_id 18814)
attach_start d1 18813 "$S1"; attach_start d2 18814 "$S2"; sleep 2
prompt d1 "Say the word ALPHA."
prompt d2 "Say the word BETA."
C1=$(wait_bound "$CWD" 18813 8 100); C2=$(wait_bound "$CWD" 18814 8 100)
check "two-daemon: distinct binds (no cross-bind)" "[ -n '$C1' ] && [ -n '$C2' ] && [ '$C1' != '$C2' ]"
F1=$(tdir_for "$CWD")/$C1.jsonl; F2=$(tdir_for "$CWD")/$C2.jsonl
check "two-daemon: ALPHA only in D1's transcript" "[ \$(grep -c ALPHA '$F1' 2>/dev/null) -ge 1 ] && [ \$(grep -c BETA '$F1' 2>/dev/null) -eq 0 ]"
check "two-daemon: BETA only in D2's transcript"  "[ \$(grep -c BETA '$F2' 2>/dev/null) -ge 1 ] && [ \$(grep -c ALPHA '$F2' 2>/dev/null) -eq 0 ]"
check "two-daemon: each binds its own port marker" "head -c 4000 '$F1' | grep -q 'remi:18813' && head -c 4000 '$F2' | grep -q 'remi:18814'"

# fm-451 zombie: kill D1's INNER claude child only (wrapper stays alive).
CC=$(pgrep -f "claude .*remi:18813" | head -1)
kill -9 "$CC" 2>/dev/null
check "zombie: D1 daemon wrapper still alive (false-live sibling)" "kill -0 \$(cat '$E2E_STATE/d1.pid') 2>/dev/null"
prompt d2 "/clear"
wait_log d2 "owned by port 18813, not 18814|DirPollRotation|restart detected" 25
prompt d2 "Say the word GAMMA."
C2B=$(bound_transcript "$CWD" 18814 2>/dev/null | awk '{print $1}')
check "zombie: D2 rebound despite the zombie sibling" "[ -n '$C2B' ] && [ '$C2B' != '$C2' ]"
check "zombie: D2 ignored the foreign/zombie transcript by marker" "grep -q 'owned by port 18813, not 18814; ignoring' '$E2E_STATE/d2.log'"
check "zombie: no Transcript-not-found wedge in D2" "[ \$(grep -ci 'not found' '$E2E_STATE/d2.log') -eq 0 ]"
attach_stop d1; attach_stop d2; stop_daemon d1; stop_daemon d2

echo
echo "==================== RESULT: $PASS passed, $FAIL failed ===================="
echo "logs + renders: $E2E_STATE"
exit "$FAIL"
