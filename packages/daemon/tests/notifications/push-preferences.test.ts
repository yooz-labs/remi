/**
 * Per-device push preferences (#968).
 *
 * The interesting cases are all about DIRECTION: which way a missing or
 * malformed value resolves, and which push classes are exempt from filtering
 * entirely. Getting either backwards silently drops notifications, which is the
 * one failure mode this product cannot have.
 */

import { describe, expect, test } from 'bun:test';
import type { UUID } from '@remi/shared';
import type { DeviceTokenEntry } from '../../src/cli/handlers/trivial-events.ts';
import type { PushKind } from '../../src/notifications/push-client.ts';
import {
  DEFAULT_PUSH_PREFERENCES,
  type ResolvedPushPreferences,
  sanitizePushPreferences,
  tokensWanting,
  wantsPush,
} from '../../src/notifications/push-preferences.ts';

const CID = 'c0000000-0000-0000-0000-000000000000' as UUID;

function entry(token: string, pushPrefs?: ResolvedPushPreferences): DeviceTokenEntry {
  return {
    token,
    platform: 'ios',
    registeredAt: 1,
    connectionId: CID,
    ...(pushPrefs !== undefined && { pushPrefs }),
  };
}

describe('sanitizePushPreferences', () => {
  test('undefined resolves to every class enabled', () => {
    expect(sanitizePushPreferences(undefined)).toEqual(DEFAULT_PUSH_PREFERENCES);
    expect(DEFAULT_PUSH_PREFERENCES).toEqual({ questions: true, turnComplete: true });
  });

  test('explicit booleans pass through, including false', () => {
    expect(sanitizePushPreferences({ questions: false, turnComplete: true })).toEqual({
      questions: false,
      turnComplete: true,
    });
    expect(sanitizePushPreferences({ questions: true, turnComplete: false })).toEqual({
      questions: true,
      turnComplete: false,
    });
  });

  test('a partial object defaults only the missing field', () => {
    expect(sanitizePushPreferences({ questions: false })).toEqual({
      questions: false,
      turnComplete: true,
    });
    expect(sanitizePushPreferences({ turnComplete: false })).toEqual({
      questions: true,
      turnComplete: false,
    });
  });

  test('a FALSY non-boolean falls back to ON, it is never coerced', () => {
    // The direction is the point, and only a FALSY non-boolean can prove it:
    // `Boolean('false')` is `true`, so a truthy junk value resolves the same way
    // under both a type check and a coercion and proves nothing. `0` / `''` /
    // `null` are where the two implementations diverge -- coercion silently
    // MUTES a device that never asked to be muted, which is the one failure
    // mode this product cannot have. Both fields, so neither can regress alone.
    for (const falsy of [0, '', null]) {
      expect(
        sanitizePushPreferences({ questions: falsy } as unknown as { questions?: boolean }),
      ).toEqual({ questions: true, turnComplete: true });
      expect(
        sanitizePushPreferences({ turnComplete: falsy } as unknown as { turnComplete?: boolean }),
      ).toEqual({ questions: true, turnComplete: true });
    }
  });

  test('a truthy non-boolean also falls back to ON rather than being coerced', () => {
    expect(
      sanitizePushPreferences({ questions: 'false', turnComplete: 'yes' } as unknown as {
        questions?: boolean;
        turnComplete?: boolean;
      }),
    ).toEqual({ questions: true, turnComplete: true });
  });

  test('a non-object (null, string, number) resolves to the defaults', () => {
    for (const bad of [null, 'nope', 42, []]) {
      expect(sanitizePushPreferences(bad as never)).toEqual(DEFAULT_PUSH_PREFERENCES);
    }
  });
});

describe('wantsPush', () => {
  test('an entry with no stored preferences wants every class', () => {
    const legacy = entry('t');
    const kinds: PushKind[] = [
      'question',
      'turn_complete',
      'subagent_alert',
      'dismiss',
      'auto_denied',
    ];
    for (const kind of kinds) {
      expect(wantsPush(legacy, kind)).toBe(true);
    }
  });

  test('each preference gates exactly its own class', () => {
    const noQuestions = entry('t', { questions: false, turnComplete: true });
    expect(wantsPush(noQuestions, 'question')).toBe(false);
    expect(wantsPush(noQuestions, 'turn_complete')).toBe(true);

    const noTurn = entry('t', { questions: true, turnComplete: false });
    expect(wantsPush(noTurn, 'question')).toBe(true);
    expect(wantsPush(noTurn, 'turn_complete')).toBe(false);
  });

  test('dismiss is never filtered, even with everything muted', () => {
    // A device that muted questions can still be holding a card delivered
    // BEFORE the mute. Dropping its dismissal strands that card on the lock
    // screen of the device that asked for less noise -- more notification
    // clutter, not less.
    const muted = entry('t', { questions: false, turnComplete: false });
    expect(wantsPush(muted, 'dismiss')).toBe(true);
  });

  test('subagent_alert is never filtered, even with everything muted', () => {
    // It already has a user-facing control: it fires only on the patterns the
    // user put in `auto_approve.subagent_alert`.
    const muted = entry('t', { questions: false, turnComplete: false });
    expect(wantsPush(muted, 'subagent_alert')).toBe(true);
  });

  test('auto_denied is never filtered, even with everything muted (#1015)', () => {
    // The strongest of the three exemptions. A deny builds no Question, so
    // there is no card to find later and no history entry to scroll back to --
    // this push IS the record. Muting it does not reduce noise; it restores
    // the invisibility the notification exists to end.
    const muted = entry('t', { questions: false, turnComplete: false });
    expect(wantsPush(muted, 'auto_denied')).toBe(true);
  });
});

describe('tokensWanting', () => {
  test('keeps only the entries that want the kind, preserving the rest', () => {
    const tokens = [
      entry('all'),
      entry('questions-only', { questions: true, turnComplete: false }),
      entry('turn-only', { questions: false, turnComplete: true }),
      entry('muted', { questions: false, turnComplete: false }),
    ];

    expect(tokensWanting(tokens, 'question').map((e) => e.token)).toEqual([
      'all',
      'questions-only',
    ]);
    expect(tokensWanting(tokens, 'turn_complete').map((e) => e.token)).toEqual([
      'all',
      'turn-only',
    ]);
    expect(tokensWanting(tokens, 'dismiss').map((e) => e.token)).toEqual([
      'all',
      'questions-only',
      'turn-only',
      'muted',
    ]);
  });

  test('returns empty when every device muted the kind', () => {
    const tokens = [
      entry('a', { questions: false, turnComplete: true }),
      entry('b', { questions: false, turnComplete: true }),
    ];
    expect(tokensWanting(tokens, 'question')).toEqual([]);
  });

  test('accepts a Map#values() iterator, the shape every call site passes', () => {
    const map = new Map<string, DeviceTokenEntry>([
      ['a', entry('a', { questions: true, turnComplete: false })],
      ['b', entry('b', { questions: false, turnComplete: false })],
    ]);
    expect(tokensWanting(map.values(), 'question').map((e) => e.token)).toEqual(['a']);
  });
});
