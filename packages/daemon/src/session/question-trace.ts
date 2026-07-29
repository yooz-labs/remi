/**
 * Opt-in question-lifecycle trace (#808).
 *
 * The #798/#799 fixes were reasoned entirely from hook semantics, never from
 * a live capture — exactly why the residual phantom-card shapes (#808)
 * survived them. This module is the capture tool: when
 * `REMI_QUESTION_TRACE=1`, every mutation of `SessionRegistry.currentQuestions`
 * (an add, or a removal via the `removeQuestion`/`clearQuestions` funnel) and
 * a handful of adjacent diagnostic moments (a `STALE_ANSWER` rejection, a
 * `question_snapshot` broadcast) append one JSONL record to
 * `~/.remi/question-trace.jsonl`.
 *
 * Mirrors the existing `REMI_HOOK_DEBUG` diagnostic dump (see
 * `hooks/hook-server.ts`): synchronous `fs.appendFileSync`, wrapped so a
 * write failure can never escape into the caller, warn-once (not every call)
 * so a broken sink is still visible without spamming the log. Disabled (the
 * default) short-circuits before touching the filesystem at all, so this can
 * never affect the decision path it observes.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** One question-lifecycle event. */
export interface QuestionTraceRecord {
  /**
   * What happened:
   *   - 'add'    — a question was registered (`SessionRegistry.addQuestion`).
   *   - 'remove' — a question left the store, whether singly
   *     (`removeQuestion`) or as part of a wholesale `clearQuestions` (one
   *     record per cleared question).
   *   - 'stale_answer' — a client tried to answer a question no longer in
   *     the store; informational (nothing removed), but tells you what WAS
   *     still pending at that moment (see `detail.pendingQuestionIds`).
   *   - 'snapshot_broadcast' — the daemon broadcast a `question_snapshot`
   *     (the authoritative live-id set for a session); this is the signal
   *     that SHOULD drive client-side reconciliation (#798 parts 2/3).
   */
  action: 'add' | 'remove' | 'stale_answer' | 'snapshot_broadcast';
  sessionId: string;
  /** Absent only for a 'snapshot_broadcast' (session-scoped, not per-question). */
  questionId?: string | undefined;
  /**
   * Claude Code's `prompt_id` (#887): the turn-scoped correlation key the
   * hook contract carries on every event (`Question.promptId`, threaded from
   * `HookCommonInput.prompt_id`). Present when the question this record is
   * about was hook-born and the daemon captured one; undefined for a
   * genuinely hook-less question (PTY-only) or an install predating Claude
   * Code 2.1.196 (the field's own version floor). This is the join key #887
   * asked for so a future capture can group every record belonging to ONE
   * Claude turn without inferring it from timing.
   */
  promptId?: string | undefined;
  /** The Claude agent this question belongs to (hook `agent_id`); absent for
   *  the main agent. */
  agentId?: string | undefined;
  /** Derived from `agentId` presence — kept as an explicit field so a JSONL
   *  consumer can filter without re-deriving it. */
  isSubagent?: boolean | undefined;
  /** The tool this question/escalation was for, when known at the call site
   *  (not every removal path has it — a plain user-answered question, for
   *  instance, does not carry a tool name). */
  toolName?: string | undefined;
  /** The event or reason that caused this action, e.g. 'PostToolUse',
   *  'PostToolUse-subagent', 'Stop', 'SubagentStop', 'user_answer',
   *  'STALE_ANSWER', 'duplicate-re-park-subagent', 'session_restart'. */
  signal: string;
  /**
   * For a 'remove': true iff this went through `SessionRegistry`'s own
   * `removeQuestion`/`clearQuestions` funnel — always true for a
   * daemon-emitted record, since the #808 audit confirmed no other code path
   * mutates `currentQuestions` directly (grep for `.delete(`/`.clear(` on the
   * map turns up only these two methods). Kept as an explicit field rather
   * than assumed: a FUTURE regression that bypasses the funnel would not
   * emit a trace record at all, so a removal a client observed (a card
   * clearing) with NO matching 'remove' record here is itself the signal a
   * bypass has been introduced.
   */
  throughFunnel?: boolean | undefined;
  /**
   * The internal function that emitted THIS record (#887), e.g.
   * `'SessionRegistry.addQuestion'`, `'SessionRegistry.removeQuestion'`,
   * `'AutoApproveGate.resolveHeld'`. Distinct from `signal`, which names the
   * EXTERNAL reason (a Claude Code hook event name, an internal reason
   * string) — several different internal call sites can legitimately share
   * one `signal` (e.g. both the main and subagent PostToolUse listeners in
   * `hook-bridge-setup.ts` route through `cancelExternallyResolved`, which
   * itself funnels through `resolveSupersededQuestion`). Narrows the gap named
   * in #887: a double-'remove' for one questionId showed THAT it happened but
   * not WHICH path did each one.
   *
   * KNOWN LIMIT, do not over-read this field. It is only as specific as the
   * caller that passes it. `SessionRegistry.removeQuestion` defaults to naming
   * itself, and every gate resolution route converges there, so two records
   * reading `'SessionRegistry.removeQuestion'` do NOT prove "one path fired
   * twice" — they may be two different upstream callers that have not been
   * threaded yet. Only a value naming a specific upstream (e.g.
   * `'AutoApproveGate.resolveHeld'`) is evidence about which path ran. When
   * chasing the #888 double-removal, treat an unthreaded default as UNKNOWN,
   * not as a match.
   */
  callSite?: string | undefined;
  /** Free-form extra context (e.g. the live id count for a snapshot, or the
   *  pending id list for a stale-answer rejection). Kept loose so the trace
   *  can absorb future signal types without a schema migration. */
  detail?: Record<string, unknown> | undefined;
}

const TRACE_FILE_NAME = 'question-trace.jsonl';

let warned = false;

function isEnabled(): boolean {
  return process.env['REMI_QUESTION_TRACE'] === '1';
}

/**
 * Append one trace record. No-op (and does not touch the filesystem) unless
 * `REMI_QUESTION_TRACE=1`. Throw-safe: a write failure is logged once (not
 * on every call, so a broken sink cannot spam the log) and otherwise
 * swallowed — this function must NEVER be able to affect the question
 * lifecycle it is only observing.
 */
export function traceQuestionEvent(record: QuestionTraceRecord): void {
  if (!isEnabled()) return;
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...record });
    const remiDir = path.join(os.homedir(), '.remi');
    fs.mkdirSync(remiDir, { recursive: true });
    fs.appendFileSync(path.join(remiDir, TRACE_FILE_NAME), `${line}\n`);
  } catch (err) {
    if (!warned) {
      warned = true;
      console.warn(
        `[QuestionTrace] REMI_QUESTION_TRACE enabled but writing failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
