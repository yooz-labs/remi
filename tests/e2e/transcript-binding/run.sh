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

PASS=0; FAIL=0
ok()   { echo "  PASS: $1"; PASS=$((PASS + 1)); }
bad()  { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }
check(){ if eval "$2"; then ok "$1"; else bad "$1 ($2)"; fi; }

CWD="$E2E_TRUSTED"
reset_cwd() { rm -rf "$CWD/.claude" 2>/dev/null; }

EXPLORE="Read README.md or list the files here, then give a 2-sentence summary. Read-only, do not modify anything."

# ---------------------------------------------------------------------------
echo "### Scenario 1: SHADOW (shipping default) — bind + /clear rotation + /compact"
# ---------------------------------------------------------------------------
reset_cwd
start_daemon s1 "$CWD" 18811 shadow; wait_ready s1 || exit 1
SID=$(session_id 18811); attach_start s1 18811 "$SID"; sleep 2
prompt s1 "$EXPLORE"
A=$(wait_bound "$CWD" 18811 8 100) || { bad "shadow: initial bind"; A=""; }
[ -n "$A" ] && ok "shadow: claude bound (honoured pre-assigned --session-id): $A"
check "shadow: 0 DISAGREE on a normal session" "[ \$(grep -c 'ShadowBinder] DISAGREE' '$E2E_STATE/s1.log') -eq 0 ]"

prompt s1 "/clear"; sleep 6
B=$(bound_transcript "$CWD" 18811 2>/dev/null | awk '{print $1}')
check "shadow: /clear rotated to a NEW id (B != A)" "[ -n '$B' ] && [ '$B' != '$A' ]"
check "shadow: rotation announced exactly once"     "[ \$(grep -c 'restart detected' '$E2E_STATE/s1.log') -eq 1 ]"
check "shadow: still 0 DISAGREE after /clear"        "[ \$(grep -c 'ShadowBinder] DISAGREE' '$E2E_STATE/s1.log') -eq 0 ]"

Bf=$(tdir_for "$CWD")/$B.jsonl; Af=$(tdir_for "$CWD")/$A.jsonl
bb=$(wc -l < "$Bf" 2>/dev/null || echo 0); ab=$(wc -l < "$Af" 2>/dev/null || echo 0)
prompt s1 "Say the word DELTA."
for i in $(seq 1 20); do [ "$(wc -l < "$Bf" 2>/dev/null||echo 0)" -gt "$bb" ] && break; sleep 2; done
check "shadow: follow-up landed in rotated session B" "[ \$(grep -c DELTA '$Bf' 2>/dev/null) -ge 1 ]"
check "shadow: old session A stayed frozen"           "[ \$(wc -l < '$Af' 2>/dev/null) -eq $ab ]"

rb=$(grep -c 'restart detected' "$E2E_STATE/s1.log")
prompt s1 "/compact"; sleep 12
check "shadow: /compact did NOT rotate (no new restart)" "[ \$(grep -c 'restart detected' '$E2E_STATE/s1.log') -eq $rb ]"
attach_stop s1; stop_daemon s1

# ---------------------------------------------------------------------------
echo "### Scenario 2: DRIVE (the binder itself) — bind + /clear via dir-poll + /compact"
# ---------------------------------------------------------------------------
reset_cwd
start_daemon s2 "$CWD" 18812 drive; wait_ready s2 || exit 1
check "drive: shadow suppressed when enabled" "[ \$(grep -c 'ShadowBinder' '$E2E_STATE/s2.log') -eq 0 ]"
SID=$(session_id 18812); attach_start s2 18812 "$SID"; sleep 2
prompt s2 "$EXPLORE"
A2=$(wait_bound "$CWD" 18812 8 100) || { bad "drive: initial bind"; A2=""; }
check "drive: binder drove the bind" "grep -q 'Binder] Lock adopted' '$E2E_STATE/s2.log'"

prompt s2 "/clear"; sleep 6
B2=$(bound_transcript "$CWD" 18812 2>/dev/null | awk '{print $1}')
check "drive: /clear rotated (B != A)" "[ -n '$B2' ] && [ '$B2' != '$A2' ]"
check "drive: new dir-poll detected the rotation (#452 machinery)" "grep -q 'No-hooks rotation detected via dir poll' '$E2E_STATE/s2.log'"
check "drive: rebound + rearmed watcher on B" "grep -q 'Transcript from DirPollRotation' '$E2E_STATE/s2.log'"
check "drive: no Transcript-not-found wedge" "[ \$(grep -ci 'not found' '$E2E_STATE/s2.log') -eq 0 ]"

rc=$(grep -c 'rotation detected\|restart detected\|DirPollRotation' "$E2E_STATE/s2.log")
prompt s2 "/compact"; sleep 12
check "drive: /compact did NOT over-fire the dir-poll" "[ \$(grep -c 'rotation detected\|restart detected\|DirPollRotation' '$E2E_STATE/s2.log') -eq $rc ]"
attach_stop s2; stop_daemon s2

# ---------------------------------------------------------------------------
echo "### Scenario 3: TWO daemons, same cwd — cross-bind (fm-427) + zombie (fm-451)"
# ---------------------------------------------------------------------------
reset_cwd
start_daemon d1 "$CWD" 18813 drive; wait_ready d1 || exit 1
sleep 2   # stagger so the two daemons do not collide writing ~/.remi/sessions.json
start_daemon d2 "$CWD" 18814 drive; wait_ready d2 || exit 1
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
prompt d2 "/clear"; sleep 6; prompt d2 "Say the word GAMMA."
C2B=$(bound_transcript "$CWD" 18814 2>/dev/null | awk '{print $1}')
check "zombie: D2 rebound despite the zombie sibling" "[ -n '$C2B' ] && [ '$C2B' != '$C2' ]"
check "zombie: D2 ignored the foreign/zombie transcript by marker" "grep -q 'owned by port 18813, not 18814; ignoring' '$E2E_STATE/d2.log'"
check "zombie: no Transcript-not-found wedge in D2" "[ \$(grep -ci 'not found' '$E2E_STATE/d2.log') -eq 0 ]"
attach_stop d1; attach_stop d2; stop_daemon d1; stop_daemon d2

echo
echo "==================== RESULT: $PASS passed, $FAIL failed ===================="
echo "logs + renders: $E2E_STATE"
exit "$FAIL"
