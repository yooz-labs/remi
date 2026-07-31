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
 *
 * Also mirrors `hook-diag.jsonl`'s contamination problem (#934): every
 * `bun test` run that exercises `QuestionStore`/`SessionRegistry` with
 * `REMI_QUESTION_TRACE=1` set appends synthetic records to this SAME file a
 * real session writes to -- `traceQuestionEvent` cannot tell a test's direct
 * call from a real hook-driven one, any more than `HookServer.handleRequest`
 * can tell a test's POST from Claude Code's. Every record now carries a
 * `provenance` field (`debug/provenance.ts`) for exactly that reason.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { QuestionSource } from '@remi/shared';
import { debugProvenance } from '../debug/provenance.ts';

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
  /**
   * `Question.source` (#574) at the moment of an 'add'/'remove': which of
   * remi's own question-detection paths produced it ('permission_request',
   * 'notification', 'pty', 'elicitation'). Added for #934 alongside the
   * provenance stamp -- #920's live reproduction needed exactly this to say
   * which card produced a given PTY write and could not, because this field
   * did not exist. Absent when the question object itself never had a
   * `source` (legacy/PTY-only paths that predate #574, or a call site that
   * does not have the `Question` object in scope).
   */
  questionSource?: QuestionSource | undefined;
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

  // NOT ADDED (#934, a judgment call, not an availability gap -- deliberately
  // UNTRACKED, no issue filed): the answer payload itself. `answer` genuinely
  // IS in scope one layer up: all three `SessionRegistry.removeQuestion`
  // calls in `input-events.ts`'s `handleAnswer` (:342 'user_answer:auq', :460
  // 'user_answer:cancel', :701 the general answered/stale-prompt path) sit
  // inside a function that takes `answer: string` as a parameter. But
  // `QuestionStore.remove` only receives `signal`/`toolName`/`callSite`
  // today, and every OTHER removal call site repo-wide (auto-approve-gate.ts
  // x3, hook-bridge-setup.ts, pty-session-setup.ts, cli.ts) is hook- or
  // system-driven, not answer-driven, with no answer text available at all --
  // and even within `handleAnswer`, the ':460 cancel' site has no meaningful
  // answer to record despite the variable being lexically reachable. Unlike
  // `questionSource` (already on the `Question` object at essentially every
  // removal call site, hook-driven or not), adding `answer` would mean
  // threading an optional string through `SessionRegistry.removeQuestion` ->
  // `QuestionStore.remove`, populated at a small minority of call sites and
  // undefined everywhere else -- judged not cheap enough to do well in this
  // change (the risk being a field that reads as complete and isn't, the
  // exact failure class #934 exists to close).
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
 *
 * `provenance` (#934): a test calling `SessionRegistry`/`QuestionStore`
 * directly is indistinguishable from a real hook-driven mutation by shape
 * alone -- both produce a well-formed `QuestionTraceRecord`. Stamped on every
 * line (see `debug/provenance.ts`) so a reader can filter to genuine records
 * by a real field: 965 of 3,582 lines on a real machine carried the test
 * suite's hardcoded question id before this existed.
 */
export function traceQuestionEvent(record: QuestionTraceRecord): void {
  if (!isEnabled()) return;
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      provenance: debugProvenance(),
      ...record,
    });
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
