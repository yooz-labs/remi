/**
 * Runner for answering Claude Code's interactive AskUserQuestion TUI (#627).
 *
 * Orchestrates the pure planner/verifier in `auq-answer.ts` against a live PTY:
 * plan keystrokes -> send them -> WATCH for closure (the "User answered" marker)
 * -> if not closed, the review screen is up: verify it matches the target, and
 * ONLY THEN submit. Never submits a wrong answer; on any failure/timeout it
 * escalates (returns 'escalated') WITHOUT pressing Esc — the user keeps their
 * intended answer and can Cancel (Esc) or answer in the terminal. Bounded by a
 * hard timeout so it can never spin (the never-stuck safeguards, see
 * `.context/auq-tui-interaction-model.md`).
 *
 * All side effects are injected (write / readRecentOutput / resetOutput / sleep)
 * so the control flow is unit-testable against a scripted output sequence.
 */

import {
  AUQ_KEYS,
  type AuqQuestionSpec,
  isAuqClosed,
  isReviewScreen,
  parseReviewAnswers,
  planAnswerKeys,
  reviewMatchesTarget,
} from './auq-answer.ts';

export type AuqRunOutcome =
  | 'closed' // the tool accepted the answer (lone single-select submits on the pick)
  | 'submitted' // we verified the review and pressed submit; tool then closed
  | 'escalated'; // could not auto-answer safely; left for the user (no wrong submit)

export interface AuqRunDeps {
  /** Write raw bytes (keystrokes) to the PTY. May be async. */
  write(data: string): Promise<void> | void;
  /** The decoded PTY output accumulated since the last resetOutput(). */
  readRecentOutput(): string;
  /** Clear the output buffer so stale markers from a prior prompt are ignored. */
  resetOutput(): void;
  /** Sleep for ms (injected so tests run instantly). */
  sleep(ms: number): Promise<void>;
  /** Monotonic ms clock (injected so tests control the timeout). */
  nowMs(): number;
  /** Aborts the run mid-flight (e.g. the user pressed Cancel). When aborted the
   *  runner stops IMMEDIATELY and escalates — it never sends another keystroke, so
   *  a cancel's Esc can't be followed by stray queued keys landing on Claude's
   *  next state. */
  signal?: AbortSignal;
  log?(msg: string): void;
}

export interface AuqRunConfig {
  /** Delay after each keystroke for the TUI to render (default 70ms). */
  keyDelayMs?: number;
  /** Hard cap on total runtime before escalating (default 8000ms). */
  timeoutMs?: number;
  /** Poll interval while waiting for closure / the review screen (default 120ms). */
  pollMs?: number;
}

export interface AuqRunInput {
  /** Per sub-question type + option count, in tab order. */
  readonly questions: readonly AuqQuestionSpec[];
  /** Per sub-question chosen option indices (0-based), questions.length entries. */
  readonly targets: readonly (readonly number[])[];
  /** Per sub-question chosen option LABELS, for review-screen verification. */
  readonly expectedLabels: readonly (readonly string[])[];
}

/**
 * Drive the on-screen AskUserQuestion to the requested answer. The prompt is
 * already rendered (Phase 1 escalates AUQ as passthrough, so Claude is waiting at
 * the interactive TUI). Returns the outcome; never throws.
 */
export async function runAuqAnswer(
  input: AuqRunInput,
  deps: AuqRunDeps,
  config: AuqRunConfig = {},
): Promise<AuqRunOutcome> {
  const keyDelayMs = config.keyDelayMs ?? 70;
  const timeoutMs = config.timeoutMs ?? 8000;
  const pollMs = config.pollMs ?? 120;
  const started = deps.nowMs();
  const timedOut = () => deps.nowMs() - started > timeoutMs;

  let keys: string[];
  try {
    keys = planAnswerKeys(input.questions, input.targets);
  } catch (err) {
    deps.log?.(
      `[auq-runner] plan failed (escalating): ${err instanceof Error ? err.message : err}`,
    );
    return 'escalated';
  }

  deps.resetOutput();

  // Send the planned keystrokes. A lone single-select submits on its ENTER, so
  // check for closure after each key and stop early.
  try {
    for (const k of keys) {
      // Abort BEFORE writing so a cancel never injects another key after its Esc.
      if (deps.signal?.aborted) {
        deps.log?.('[auq-runner] aborted (cancel) while sending keys');
        return 'escalated';
      }
      await deps.write(k);
      await deps.sleep(keyDelayMs);
      if (isAuqClosed(deps.readRecentOutput())) return 'closed';
      if (timedOut()) {
        deps.log?.('[auq-runner] timed out while sending keys (escalating)');
        return 'escalated';
      }
    }
  } catch (err) {
    deps.log?.(
      `[auq-runner] write failed (escalating): ${err instanceof Error ? err.message : err}`,
    );
    return 'escalated';
  }

  // Multi-select / 2+ questions: a review/Submit screen is up. Verify it matches
  // the target, then submit. Poll until closed, the review appears, or timeout.
  let submitted = false;
  while (!timedOut()) {
    if (deps.signal?.aborted) {
      deps.log?.('[auq-runner] aborted (cancel) while awaiting review/closure');
      return 'escalated';
    }
    const out = deps.readRecentOutput();
    if (isAuqClosed(out)) return submitted ? 'submitted' : 'closed';
    if (!submitted && isReviewScreen(out)) {
      const parsed = parseReviewAnswers(out);
      if (parsed.length > 0 && reviewMatchesTarget(parsed, input.expectedLabels)) {
        try {
          await deps.write(AUQ_KEYS.ENTER); // "Submit answers"
        } catch (err) {
          deps.log?.(
            `[auq-runner] submit write failed (escalating): ${err instanceof Error ? err.message : err}`,
          );
          return 'escalated';
        }
        submitted = true;
        await deps.sleep(keyDelayMs);
        continue; // loop back to confirm closure
      }
      // The review is up but does not match (open-loop nav drifted, or an
      // unexpected variant). Do NOT submit and do NOT Esc — hand back to the user.
      deps.log?.(
        `[auq-runner] review did not match target (escalating, no submit): parsed=${JSON.stringify(parsed)} expected=${JSON.stringify(input.expectedLabels)}`,
      );
      return 'escalated';
    }
    await deps.sleep(pollMs);
  }

  deps.log?.(`[auq-runner] timed out (escalating); submitted=${submitted}`);
  return 'escalated';
}
