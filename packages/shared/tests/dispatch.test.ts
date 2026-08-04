/**
 * Tests for the total-dispatch helpers (#896): `MessageHandlers`,
 * `dispatchMessage`, `assertNever`.
 *
 * Two of the tests below are primarily compile-time demonstrations —
 * `// @ts-expect-error` lines that `tsc --noEmit` (`bun run typecheck`)
 * enforces are real errors, not merely present. Removing either
 * `@ts-expect-error` comment makes typecheck fail with "Unused
 * '@ts-expect-error' directive", which is how this was verified while
 * writing it (both lines were briefly removed to confirm the underlying
 * assignment/call really does error, then restored).
 */
import { describe, expect, test } from 'bun:test';
import type { MessageHandlers, ProtocolMessageMap } from '../src/index.ts';
import { MESSAGE_DIRECTION, assertNever, dispatchMessage } from '../src/index.ts';
import { createPing, createQuestionResolved } from '../src/protocol.ts';

const registryTypes = Object.keys(MESSAGE_DIRECTION) as (keyof ProtocolMessageMap)[];

describe('dispatchMessage()', () => {
  test('routes to the handler for the message type and returns its result', () => {
    const msg = createQuestionResolved('session-1', 'question-1', 'answered');
    const handlers: MessageHandlers<'question_resolved', string> = {
      question_resolved: (m) => `resolved:${m.sessionId}:${m.questionId}:${m.reason}`,
    };

    expect(dispatchMessage(msg, handlers)).toBe('resolved:session-1:question-1:answered');
  });

  test("returns undefined without invoking anything when the handler is 'ignore'", () => {
    const msg = createPing();
    const handlers: MessageHandlers<'ping', number> = { ping: 'ignore' };

    expect(dispatchMessage(msg, handlers)).toBeUndefined();
  });

  test('handler receives the exact message instance', () => {
    const msg = createQuestionResolved('session-2', 'question-2', 'cancelled');
    let received: unknown;
    const handlers: MessageHandlers<'question_resolved', void> = {
      question_resolved: (m) => {
        received = m;
      },
    };

    dispatchMessage(msg, handlers);
    expect(received).toBe(msg);
  });
});

describe('assertNever()', () => {
  test('throws, naming the unexpected value', () => {
    // Cast is the point: assertNever's parameter is `never` so nothing
    // type-checks here in real usage; this simulates the runtime-only case
    // (parsed JSON, a switch that forgot a member) where a bad value reaches
    // the exhaustiveness guard despite TypeScript's static types.
    expect(() => assertNever('not_a_real_case' as never)).toThrow(/Unexpected value/);
    expect(() => assertNever('not_a_real_case' as never)).toThrow(/not_a_real_case/);
  });
});

// --- Compile-time totality demonstrations (#896 acceptance criterion) ---

type Direction = (typeof MESSAGE_DIRECTION)[keyof typeof MESSAGE_DIRECTION];

/** Exhaustive: every `Direction` member is handled, so `assertNever` in the
 *  default branch never actually type-checks against a non-`never` value. */
function describeDirection(d: Direction): string {
  switch (d) {
    case 'c2d':
      return 'client to daemon';
    case 'd2c':
      return 'daemon to client';
    case 'both':
      return 'both directions';
    default:
      return assertNever(d);
  }
}

/** Deliberately non-exhaustive (missing the `'both'` case) so the `default`
 *  branch narrows `d` to `'both'`, not `never` — `assertNever` then rejects
 *  it at compile time, which is the entire point of the helper. */
function describeDirectionIncomplete(d: Direction): string {
  switch (d) {
    case 'c2d':
      return 'client to daemon';
    case 'd2c':
      return 'daemon to client';
    default:
      // @ts-expect-error - `d` is `'both'` here (unhandled case above), not
      // `never`; assertNever's `never` parameter rejects it. This is the
      // "unhandled switch case becomes a compile error" property #896 exists
      // to provide.
      return assertNever(d);
  }
}

describe('assertNever() forces switch exhaustiveness (compile-time)', () => {
  test('the exhaustive switch handles every direction', () => {
    expect(describeDirection('c2d')).toBe('client to daemon');
    expect(describeDirection('d2c')).toBe('daemon to client');
    expect(describeDirection('both')).toBe('both directions');
  });

  test('the non-exhaustive switch above still throws at runtime on the unhandled case', () => {
    // TypeScript's types are erased at runtime, so 'both' reaching the
    // unhandled default branch doesn't stop at the type error above — it
    // reaches assertNever and throws, instead of the silent wrong-answer a
    // plain missing `case` would otherwise produce.
    expect(() => describeDirectionIncomplete('both')).toThrow(/Unexpected value/);
  });
});

describe('MessageHandlers is a total map (compile-time)', () => {
  test('a handler map missing one registry key is rejected by the MessageHandlers<...> type', () => {
    // Every key except 'question_snapshot' — typed honestly as a handler map
    // over that 44-key subset, not cast to the full 45-key type.
    const allButOne = registryTypes.filter((t) => t !== 'question_snapshot');
    const missingOneHandler = Object.fromEntries(
      allButOne.map((t) => [t, 'ignore' as const]),
    ) as MessageHandlers<Exclude<keyof ProtocolMessageMap, 'question_snapshot'>>;

    expect(Object.keys(missingOneHandler).length).toBe(registryTypes.length - 1);

    // @ts-expect-error - missingOneHandler's type deliberately excludes
    // 'question_snapshot'; assigning it to the full MessageHandlers type
    // must fail. This is the #896 acceptance criterion: adding a registry
    // key without adding a handler for it is a compile error, not a silent
    // no-op.
    const incomplete: MessageHandlers<keyof ProtocolMessageMap> = missingOneHandler;
    void incomplete;
  });

  test('the same map WITH the missing key satisfies the full MessageHandlers type', () => {
    const complete = Object.fromEntries(
      registryTypes.map((t) => [t, 'ignore' as const]),
    ) as MessageHandlers<keyof ProtocolMessageMap>;

    const total: MessageHandlers<keyof ProtocolMessageMap> = complete;
    expect(Object.keys(total).length).toBe(registryTypes.length);
  });
});
