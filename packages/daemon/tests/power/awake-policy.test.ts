import { describe, expect, test } from 'bun:test';
import {
  type AwakePolicyConfig,
  type AwakePolicyEvent,
  type AwakePolicyResult,
  initialAwakePolicyState,
  stepAwakePolicy,
} from '../../src/power/awake-policy.ts';

const config: AwakePolicyConfig = {
  level1: true,
  question_hold_minutes: 30,
  idle_grace_seconds: 120,
  stuck_busy_minutes: 15,
  ttl_minutes: 20,
};

function step(
  current: AwakePolicyResult['state'],
  event: AwakePolicyEvent,
  at: number,
  override: Partial<AwakePolicyConfig> = {},
): AwakePolicyResult {
  return stepAwakePolicy({ ...config, ...override }, current, event, at);
}

describe('awake level-1 policy', () => {
  test('a turn with no tool calls holds from UserPromptSubmit alone', () => {
    const result = step(initialAwakePolicyState(10), { type: 'turn-open' }, 10);
    expect(result.state.held).toBe(true);
    expect(result.effects).toEqual([{ type: 'hold', reason: 'turn open' }]);
    expect(result.nextDeadline).toBe(900_010);
  });

  test('Escape-interrupted busy state releases at the stuck bound and warns once', () => {
    let result = step(initialAwakePolicyState(), { type: 'turn-open' }, 0);
    result = step(result.state, { type: 'tick' }, 899_999);
    expect(result.state.held).toBe(true);
    expect(result.effects).toEqual([]);

    result = step(result.state, { type: 'tick' }, 900_000);
    expect(result.state.held).toBe(false);
    expect(result.effects).toEqual([
      { type: 'warning', reason: 'stuck bound' },
      { type: 'release', reason: 'stuck bound' },
    ]);
    result = step(result.state, { type: 'tick' }, 901_000);
    expect(result.effects).toEqual([]);
  });

  test('a pending question holds to its cap, then releases and warns once', () => {
    let result = step(initialAwakePolicyState(), { type: 'questions', count: 1 }, 0);
    expect(result.state.held).toBe(true);
    expect(result.effects).toEqual([{ type: 'hold', reason: 'question' }]);

    result = step(result.state, { type: 'activity' }, 1_000_000);
    expect(result.state.held).toBe(true);
    result = step(result.state, { type: 'tick' }, 1_799_999);
    expect(result.state.held).toBe(true);
    result = step(result.state, { type: 'tick' }, 1_800_000);
    expect(result.state.held).toBe(false);
    expect(result.effects).toEqual([
      { type: 'warning', reason: 'question cap' },
      { type: 'release', reason: 'question cap' },
    ]);
    result = step(result.state, { type: 'tick' }, 1_900_000);
    expect(result.effects).toEqual([]);
  });

  test('a question and an open turn both have to end before idle grace begins', () => {
    let result = step(initialAwakePolicyState(), { type: 'turn-open' }, 0);
    result = step(result.state, { type: 'questions', count: 1 }, 10);
    result = step(result.state, { type: 'turn-close' }, 20);
    expect(result.state.held).toBe(true);
    result = step(result.state, { type: 'status', status: 'idle' }, 21);
    expect(result.state.held).toBe(true);
    expect(result.nextDeadline).toBe(1_800_010);

    result = step(result.state, { type: 'questions', count: 0 }, 1_000);
    expect(result.state.held).toBe(true);
    expect(result.nextDeadline).toBe(121_000);
    result = step(result.state, { type: 'tick' }, 121_000);
    expect(result.state.held).toBe(false);
    expect(result.effects).toEqual([{ type: 'release', reason: 'grace' }]);
  });

  test('idle grace delays release and a new turn cancels the old deadline', () => {
    let result = step(initialAwakePolicyState(), { type: 'turn-open' }, 0);
    result = step(result.state, { type: 'turn-close' }, 10);
    expect(result.state.held).toBe(true);
    expect(result.nextDeadline).toBe(120_010);

    result = step(result.state, { type: 'tick' }, 120_009);
    expect(result.state.held).toBe(true);
    result = step(result.state, { type: 'turn-open' }, 120_009);
    expect(result.state.held).toBe(true);
    expect(result.nextDeadline).toBe(1_020_009);

    result = step(result.state, { type: 'turn-close' }, 120_100);
    expect(result.state.held).toBe(true);
    expect(result.nextDeadline).toBe(240_100);
    result = step(result.state, { type: 'tick' }, 240_100);
    expect(result.state.held).toBe(false);
    expect(result.effects).toEqual([{ type: 'release', reason: 'grace' }]);
  });

  test('backward ticks do not expire early and a large forward tick releases stale work', () => {
    let result = step(initialAwakePolicyState(), { type: 'turn-open' }, 1_000);
    result = step(result.state, { type: 'tick' }, -50_000);
    expect(result.state.lastObservedAt).toBe(1_000);
    expect(result.state.held).toBe(true);
    result = step(result.state, { type: 'tick' }, 900_999);
    expect(result.state.held).toBe(true);
    result = step(result.state, { type: 'tick' }, 9_000_000);
    expect(result.state.held).toBe(false);
    expect(result.effects).toEqual([
      { type: 'warning', reason: 'stuck bound' },
      { type: 'release', reason: 'stuck bound' },
    ]);
  });

  test('session end releases immediately without idle grace', () => {
    let result = step(initialAwakePolicyState(), { type: 'status', status: 'executing' }, 0);
    expect(result.state.held).toBe(true);
    result = step(result.state, { type: 'session-end' }, 1);
    expect(result.state.held).toBe(false);
    expect(result.effects).toEqual([{ type: 'release', reason: 'session end' }]);
  });

  test('level1 false never holds', () => {
    const result = step(initialAwakePolicyState(), { type: 'turn-open' }, 0, { level1: false });
    expect(result.state.held).toBe(false);
    expect(result.effects).toEqual([]);
    expect(result.nextDeadline).toBeNull();
  });

  test('a SessionEnd hook (turn close plus idle, as on /clear) releases after grace and the next turn holds again', () => {
    let result = step(initialAwakePolicyState(), { type: 'turn-open' }, 0);
    expect(result.effects).toEqual([{ type: 'hold', reason: 'turn open' }]);
    // The hook bridge maps SessionEnd to turn-close and HookEventBridge sets idle.
    result = step(result.state, { type: 'turn-close' }, 1_000);
    result = step(result.state, { type: 'status', status: 'idle' }, 1_000);
    expect(result.state.held).toBe(true);
    expect(result.state.ended).toBe(false);
    result = step(result.state, { type: 'tick' }, 121_000);
    expect(result.effects).toEqual([{ type: 'release', reason: 'grace' }]);

    result = step(result.state, { type: 'turn-open' }, 130_000);
    expect(result.state.held).toBe(true);
    expect(result.effects).toEqual([{ type: 'hold', reason: 'turn open' }]);
    result = step(result.state, { type: 'status', status: 'executing' }, 131_000);
    expect(result.state.held).toBe(true);
  });

  test('the terminal session-end (dispose only) never holds again', () => {
    let result = step(initialAwakePolicyState(), { type: 'turn-open' }, 0);
    result = step(result.state, { type: 'session-end' }, 10);
    expect(result.effects).toEqual([{ type: 'release', reason: 'session end' }]);
    result = step(result.state, { type: 'turn-open' }, 20);
    expect(result.state.held).toBe(false);
    expect(result.effects).toEqual([]);
  });

  test('the stuck bound drops the stale turn and status, so later activity does not re-arm the hold', () => {
    let result = step(initialAwakePolicyState(), { type: 'turn-open' }, 0);
    result = step(result.state, { type: 'status', status: 'executing' }, 0);
    result = step(result.state, { type: 'tick' }, 900_000);
    expect(result.effects).toEqual([
      { type: 'warning', reason: 'stuck bound' },
      { type: 'release', reason: 'stuck bound' },
    ]);
    expect(result.state.turnOpen).toBe(false);
    expect(result.state.status).toBe('idle');

    result = step(result.state, { type: 'activity' }, 901_000);
    expect(result.state.held).toBe(false);
    expect(result.effects).toEqual([]);
    result = step(result.state, { type: 'activity' }, 2_000_000);
    expect(result.state.held).toBe(false);
    expect(result.effects).toEqual([]);

    result = step(result.state, { type: 'status', status: 'thinking' }, 2_000_001);
    expect(result.effects).toEqual([{ type: 'hold', reason: 'thinking' }]);
    result = step(result.state, { type: 'tick' }, 2_900_001);
    expect(result.effects).toEqual([
      { type: 'warning', reason: 'stuck bound' },
      { type: 'release', reason: 'stuck bound' },
    ]);
    result = step(result.state, { type: 'turn-open' }, 2_900_002);
    expect(result.effects).toEqual([{ type: 'hold', reason: 'turn open' }]);
  });

  test('the question cap bounds a waiting status and an open turn under activity, with no grace after it', () => {
    let result = step(initialAwakePolicyState(), { type: 'turn-open' }, 0);
    result = step(result.state, { type: 'questions', count: 1 }, 10);
    result = step(result.state, { type: 'status', status: 'waiting' }, 20);
    expect(result.state.held).toBe(true);
    expect(result.nextDeadline).toBe(1_800_010);
    for (let at = 300_000; at <= 1_800_000; at += 300_000) {
      result = step(result.state, { type: 'activity' }, at);
      expect(result.state.held).toBe(true);
      expect(result.effects).toEqual([]);
    }

    result = step(result.state, { type: 'tick' }, 1_800_010);
    expect(result.state.held).toBe(false);
    expect(result.state.idleSince).toBeNull();
    expect(result.effects).toEqual([
      { type: 'warning', reason: 'question cap' },
      { type: 'release', reason: 'question cap' },
    ]);

    // The question lingers: more activity and a repeated waiting status do not hold again.
    result = step(result.state, { type: 'activity' }, 1_900_000);
    expect(result.effects).toEqual([]);
    result = step(result.state, { type: 'status', status: 'waiting' }, 1_900_001);
    expect(result.state.held).toBe(false);
    expect(result.effects).toEqual([]);

    // Answered later: the waiting status and the open turn are no longer covered and hold.
    result = step(result.state, { type: 'questions', count: 0 }, 2_000_000);
    expect(result.effects).toEqual([{ type: 'hold', reason: 'waiting' }]);
    expect(result.state.turnOpen).toBe(true);
  });

  test('a working status still holds after the question cap, which only warns', () => {
    let result = step(initialAwakePolicyState(), { type: 'questions', count: 1 }, 0);
    result = step(result.state, { type: 'status', status: 'executing' }, 10);
    result = step(result.state, { type: 'activity' }, 1_500_000);
    result = step(result.state, { type: 'tick' }, 1_800_000);
    expect(result.state.held).toBe(true);
    expect(result.effects).toEqual([{ type: 'warning', reason: 'question cap' }]);
  });

  test('a question replaced at the same count keeps its cap clock; zero to nonzero restarts it', () => {
    let result = step(initialAwakePolicyState(), { type: 'questions', count: 1 }, 0);
    expect(result.nextDeadline).toBe(1_800_000);
    result = step(result.state, { type: 'questions', count: 1 }, 600_000);
    expect(result.state.questionStartedAt).toBe(0);
    expect(result.nextDeadline).toBe(1_800_000);
    result = step(result.state, { type: 'questions', count: 2 }, 700_000);
    expect(result.state.questionStartedAt).toBe(0);

    result = step(result.state, { type: 'questions', count: 0 }, 800_000);
    result = step(result.state, { type: 'questions', count: 1 }, 800_000);
    expect(result.state.questionStartedAt).toBe(800_000);
    expect(result.nextDeadline).toBe(2_600_000);
  });

  test('busy status changes label their reason and holder renewal is a policy deadline', () => {
    const thinking = step(initialAwakePolicyState(), { type: 'status', status: 'thinking' }, 0);
    expect(thinking.effects).toEqual([{ type: 'hold', reason: 'thinking' }]);
    const waiting = step(initialAwakePolicyState(), { type: 'status', status: 'waiting' }, 0);
    expect(waiting.effects).toEqual([{ type: 'hold', reason: 'waiting' }]);

    let result = step(initialAwakePolicyState(), { type: 'status', status: 'executing' }, 0);
    expect(result.effects).toEqual([{ type: 'hold', reason: 'executing' }]);
    result = step(result.state, { type: 'holder-started' }, 0);
    result = step(result.state, { type: 'status', status: 'executing' }, 600_000);
    expect(result.nextDeadline).toBe(960_000);
    result = step(result.state, { type: 'tick' }, 960_000);
    expect(result.state.held).toBe(true);
    expect(result.effects).toEqual([{ type: 'renew' }]);
  });
});
