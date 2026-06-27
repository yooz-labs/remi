import { describe, expect, it } from 'bun:test';
import { AUQ_KEYS, type AuqQuestionSpec } from '../../src/hooks/auq-answer.ts';
import { type AuqRunDeps, runAuqAnswer } from '../../src/hooks/auq-runner.ts';

const single = (optionCount: number): AuqQuestionSpec => ({ multiSelect: false, optionCount });
const multi = (optionCount: number): AuqQuestionSpec => ({ multiSelect: true, optionCount });

const CLOSED = "⏺ User answered Claude's questions:  ⎿ · …";
const REVIEW =
  'Review your answers● Favorite color? → Green● Which fruits? → Apple, CherryReady to submit your answers?❯ 1. Submit answers 2. Cancel';

/**
 * A scripted PTY: `behavior(key, sim)` updates `output` in response to a keystroke,
 * modelling the AUQ TUI. `sleep` advances a virtual clock so timeouts are testable
 * instantly; `nowMs` reads it.
 */
function makeSim(behavior: (key: string, sim: { keys: string[]; output: string }) => string) {
  const state = { keys: [] as string[], output: '' };
  let clock = 0;
  const deps: AuqRunDeps = {
    write: (d: string) => {
      state.keys.push(d);
      state.output = behavior(d, state);
    },
    readRecentOutput: () => state.output,
    resetOutput: () => {
      state.output = '';
    },
    sleep: async (ms: number) => {
      clock += ms;
    },
    nowMs: () => clock,
    log: () => {},
  };
  return { deps, state };
}

describe('runAuqAnswer', () => {
  it('lone single-select: closes on the pick ENTER (no submit step)', async () => {
    // Only the final ENTER closes the tool; DOWN does not.
    const { deps, state } = makeSim((key, s) => (key === AUQ_KEYS.ENTER ? CLOSED : s.output));
    const outcome = await runAuqAnswer(
      { questions: [single(3)], targets: [[1]], expectedLabels: [['Green']] },
      deps,
    );
    expect(outcome).toBe('closed');
    // Exactly DOWN then ENTER — no stray keys, no Esc.
    expect(state.keys).toEqual([AUQ_KEYS.DOWN, AUQ_KEYS.ENTER]);
  });

  it('two questions: drives, sees the review, verifies, submits, closes', async () => {
    // After all 7 planned keys, the review shows; the next ENTER (submit) closes.
    let phase: 'ans' | 'review' | 'done' = 'ans';
    const { deps, state } = makeSim((key, s) => {
      if (phase === 'ans' && s.keys.length >= 7) {
        phase = 'review';
        return REVIEW;
      }
      if (phase === 'review' && key === AUQ_KEYS.ENTER) {
        phase = 'done';
        return CLOSED;
      }
      return s.output;
    });
    const outcome = await runAuqAnswer(
      {
        questions: [single(3), multi(4)],
        targets: [[1], [0, 2]],
        expectedLabels: [['Green'], ['Apple', 'Cherry']],
      },
      deps,
    );
    expect(outcome).toBe('submitted');
    // 7 planned keys + 1 submit ENTER; no Esc ever.
    expect(state.keys).toHaveLength(8);
    expect(state.keys).not.toContain(AUQ_KEYS.ESC);
    expect(state.keys[7]).toBe(AUQ_KEYS.ENTER);
  });

  it('review mismatch: escalates WITHOUT submitting or pressing Esc', async () => {
    // Review shows a WRONG answer (Blue, not Green) -> must not submit.
    const wrongReview = REVIEW.replace('→ Green', '→ Blue');
    let phase: 'ans' | 'review' = 'ans';
    const { deps, state } = makeSim((_key, s) => {
      if (phase === 'ans' && s.keys.length >= 7) {
        phase = 'review';
        return wrongReview;
      }
      return s.output;
    });
    const outcome = await runAuqAnswer(
      {
        questions: [single(3), multi(4)],
        targets: [[1], [0, 2]],
        expectedLabels: [['Green'], ['Apple', 'Cherry']],
      },
      deps,
    );
    expect(outcome).toBe('escalated');
    // Only the 7 planned keys; no submit ENTER beyond them, no Esc.
    expect(state.keys).toHaveLength(7);
    expect(state.keys).not.toContain(AUQ_KEYS.ESC);
  });

  it('timeout (never closes / no review): escalates, never presses Esc', async () => {
    const { deps, state } = makeSim((_key, s) => s.output); // output stays empty forever
    const outcome = await runAuqAnswer(
      { questions: [multi(4)], targets: [[0]], expectedLabels: [['Apple']] },
      deps,
      { timeoutMs: 500, pollMs: 120 },
    );
    expect(outcome).toBe('escalated');
    expect(state.keys).not.toContain(AUQ_KEYS.ESC);
  });

  it('plan failure (out-of-range target): escalates without sending any keys', async () => {
    const { deps, state } = makeSim((_key, s) => s.output);
    const outcome = await runAuqAnswer(
      { questions: [single(3)], targets: [[9]], expectedLabels: [['x']] },
      deps,
    );
    expect(outcome).toBe('escalated');
    expect(state.keys).toHaveLength(0);
  });

  it('write failure: escalates (never throws)', async () => {
    const deps: AuqRunDeps = {
      write: () => {
        throw new Error('pty gone');
      },
      readRecentOutput: () => '',
      resetOutput: () => {},
      sleep: async () => {},
      nowMs: () => 0,
      log: () => {},
    };
    const outcome = await runAuqAnswer(
      { questions: [single(3)], targets: [[0]], expectedLabels: [['x']] },
      deps,
    );
    expect(outcome).toBe('escalated');
  });
});
