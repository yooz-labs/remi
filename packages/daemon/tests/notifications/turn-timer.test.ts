/**
 * Tests for TurnTimer + the turn-complete notification decision (#914).
 *
 * No mocks: TurnTimer is pure apart from an injectable clock, and
 * shouldNotifyTurnComplete / buildTurnCompleteText are pure functions, so
 * these are real unit tests over real behavior with nothing to fake.
 */

import { describe, expect, test } from 'bun:test';
import {
  TurnTimer,
  buildTurnCompleteText,
  shouldNotifyTurnComplete,
} from '../../src/notifications/turn-timer.ts';

describe('TurnTimer', () => {
  test('elapsedMs is unknown for a prompt_id never observed', () => {
    const t = new TurnTimer();
    expect(t.elapsedMs('never-seen')).toBeUndefined();
  });

  test('elapsedMs is unknown for an undefined prompt_id', () => {
    const t = new TurnTimer();
    expect(t.elapsedMs(undefined)).toBeUndefined();
  });

  test('records the first observation and measures elapsed from it', () => {
    let now = 1_000_000;
    const t = new TurnTimer({ nowMs: () => now });

    t.observe('prompt-a');
    now += 5_000;
    expect(t.elapsedMs('prompt-a')).toBe(5_000);
  });

  test('a repeat observation does not move the mark', () => {
    let now = 1_000_000;
    const t = new TurnTimer({ nowMs: () => now });

    t.observe('prompt-a');
    now += 3_000;
    // A second (later) hook event for the SAME turn must not reset the clock.
    t.observe('prompt-a');
    now += 2_000;
    expect(t.elapsedMs('prompt-a')).toBe(5_000);
  });

  test('observe ignores an undefined prompt_id', () => {
    const t = new TurnTimer();
    t.observe(undefined);
    expect(t.size).toBe(0);
  });

  test('clear forgets the mark; elapsedMs is unknown again', () => {
    let now = 1_000_000;
    const t = new TurnTimer({ nowMs: () => now });
    t.observe('prompt-a');
    now += 1_000;
    expect(t.elapsedMs('prompt-a')).toBe(1_000);

    t.clear('prompt-a');
    expect(t.elapsedMs('prompt-a')).toBeUndefined();
  });

  test('clear on an undefined/absent prompt_id is a no-op', () => {
    const t = new TurnTimer();
    t.clear(undefined);
    t.clear('never-tracked');
    expect(t.size).toBe(0);
  });

  test('tracks multiple concurrent prompt_ids independently', () => {
    let now = 1_000_000;
    const t = new TurnTimer({ nowMs: () => now });

    t.observe('prompt-a');
    now += 1_000;
    t.observe('prompt-b');
    now += 1_000;

    expect(t.elapsedMs('prompt-a')).toBe(2_000);
    expect(t.elapsedMs('prompt-b')).toBe(1_000);
  });

  test('the tracked-prompt map stays bounded across many distinct turns', () => {
    let now = 1_000_000;
    const t = new TurnTimer({ nowMs: () => now });
    for (let i = 0; i < 400; i++) {
      now += 1;
      t.observe(`prompt-${i}`);
    }
    // Eviction is oldest-first, so the most recently observed prompt must
    // still be tracked -- proving the map was trimmed, not cleared wholesale.
    expect(t.elapsedMs('prompt-399')).not.toBeUndefined();
    expect(t.elapsedMs('prompt-0')).toBeUndefined();
    expect(t.size).toBeLessThanOrEqual(200);
  });
});

describe('shouldNotifyTurnComplete', () => {
  const BASE = {
    onTurnComplete: true,
    stopHookActive: false,
    elapsedMs: 120_000,
    minSeconds: 60,
    lastAssistantMessage: 'All done, tests pass.',
    hasDeviceTokens: true,
  };

  test('notifies when every gate holds', () => {
    expect(shouldNotifyTurnComplete(BASE)).toBe(true);
  });

  test('config off suppresses the push', () => {
    expect(shouldNotifyTurnComplete({ ...BASE, onTurnComplete: false })).toBe(false);
  });

  test('a stop-hook re-entry never notifies', () => {
    expect(shouldNotifyTurnComplete({ ...BASE, stopHookActive: true })).toBe(false);
  });

  test('unknown elapsed (no prompt_id match) fails toward silence', () => {
    expect(shouldNotifyTurnComplete({ ...BASE, elapsedMs: undefined })).toBe(false);
  });

  test('a fast turn below the threshold does not notify', () => {
    expect(shouldNotifyTurnComplete({ ...BASE, elapsedMs: 59_999, minSeconds: 60 })).toBe(false);
  });

  test('exactly at the threshold notifies (>=, not >)', () => {
    expect(shouldNotifyTurnComplete({ ...BASE, elapsedMs: 60_000, minSeconds: 60 })).toBe(true);
  });

  test('an empty last_assistant_message does not notify', () => {
    expect(shouldNotifyTurnComplete({ ...BASE, lastAssistantMessage: '' })).toBe(false);
  });

  test('a whitespace-only last_assistant_message does not notify', () => {
    expect(shouldNotifyTurnComplete({ ...BASE, lastAssistantMessage: '   \n  ' })).toBe(false);
  });

  test('an undefined last_assistant_message does not notify', () => {
    expect(shouldNotifyTurnComplete({ ...BASE, lastAssistantMessage: undefined })).toBe(false);
  });

  test('no registered device tokens does not notify', () => {
    expect(shouldNotifyTurnComplete({ ...BASE, hasDeviceTokens: false })).toBe(false);
  });
});

describe('buildTurnCompleteText', () => {
  test('title names the session in the house style', () => {
    const { title } = buildTurnCompleteText('my-project', 'Done.');
    expect(title).toBe('my-project: turn complete');
  });

  test('body carries the actual last message', () => {
    const { body } = buildTurnCompleteText('my-project', 'Fixed the flaky test and pushed.');
    expect(body).toBe('Fixed the flaky test and pushed.');
  });

  test('collapses embedded newlines/whitespace in the body', () => {
    const { body } = buildTurnCompleteText('proj', 'Line one.\n\n  Line two.\t\tLine three.');
    expect(body).toBe('Line one. Line two. Line three.');
  });

  test('truncates a long body with an ellipsis marker', () => {
    const long = 'x'.repeat(500);
    const { body } = buildTurnCompleteText('proj', long);
    expect(body.length).toBeLessThan(long.length);
    expect(body.endsWith('…')).toBe(true);
  });

  test('does not truncate a short body', () => {
    const { body } = buildTurnCompleteText('proj', 'short');
    expect(body).toBe('short');
    expect(body.endsWith('…')).toBe(false);
  });

  test('truncates a very long session name in the title', () => {
    const longName = 'a'.repeat(200);
    const { title } = buildTurnCompleteText(longName, 'Done.');
    // slice(0, max) + the ellipsis marker itself, same off-by-one convention
    // as hook-bridge-setup.ts's summarizeForLog.
    expect(title.length).toBeLessThanOrEqual(121);
    expect(title.endsWith('…')).toBe(true);
  });
});

/**
 * The session filter that keeps a turn-complete push from reporting a SIBLING
 * daemon's turn (#914).
 *
 * This is not defence-in-depth, it is the only defence. Two daemons in the same
 * project directory each append their own matcher to the shared
 * `.claude/settings.local.json` hooks array, so Claude Code POSTs every `Stop`
 * to both. The timer cannot help: `onAnyEvent` observes the sibling's earlier
 * events too, so `elapsedMs` comes back populated and plausible for a turn that
 * was never ours.
 *
 * `cli.ts`'s `onTurnStop` is a module-private closure over daemon state, so
 * these tests pin the DECISION RULE it implements — "notify only if some live
 * session's binder admits the event, fail closed when none does" — against the
 * same admits-shaped predicate. If that rule changes in cli.ts without changing
 * here, the reviewer sees an unexplained divergence.
 */
describe('turn-complete session filter (#914)', () => {
  type Admits = (input: { session_id: string }) => boolean;

  /** The rule `onTurnStop` applies before considering a notification. */
  function admittedByAnySession(
    handles: Map<string, Admits>,
    input: { session_id: string },
  ): boolean {
    for (const admits of handles.values()) {
      try {
        if (admits(input)) return true;
      } catch {
        // A throwing binder must not break the hook path; treat as not ours.
      }
    }
    return false;
  }

  test('a sibling daemon turn is refused', () => {
    const handles = new Map<string, Admits>([['ours', (i) => i.session_id === 'our-claude-id']]);
    expect(admittedByAnySession(handles, { session_id: 'sibling-claude-id' })).toBe(false);
  });

  test('our own turn is admitted', () => {
    const handles = new Map<string, Admits>([['ours', (i) => i.session_id === 'our-claude-id']]);
    expect(admittedByAnySession(handles, { session_id: 'our-claude-id' })).toBe(true);
  });

  test('with no live sessions it fails CLOSED, not open', () => {
    // The dangerous default. An empty map must mean "not ours", never "sure".
    expect(admittedByAnySession(new Map(), { session_id: 'anything' })).toBe(false);
  });

  test('a throwing binder is treated as not-ours and does not propagate', () => {
    const handles = new Map<string, Admits>([
      [
        'broken',
        () => {
          throw new Error('binder exploded');
        },
      ],
    ]);
    expect(() => admittedByAnySession(handles, { session_id: 'x' })).not.toThrow();
    expect(admittedByAnySession(handles, { session_id: 'x' })).toBe(false);
  });

  test('one admitting session among several is enough', () => {
    const handles = new Map<string, Admits>([
      ['a', () => false],
      ['b', (i) => i.session_id === 'mine'],
      ['c', () => false],
    ]);
    expect(admittedByAnySession(handles, { session_id: 'mine' })).toBe(true);
  });
});
