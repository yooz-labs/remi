/**
 * The chat acceptance tracker (#1818): the matching and bookkeeping rules on their own.
 * The hook and terminal sides are exercised together in
 * `tests/integration/chat-acceptance.test.ts`.
 */

import { describe, expect, test } from 'bun:test';
import type { ProtocolMessage, UUID } from '@remi/shared';
import {
  CHAT_ACCEPTANCE_MAX_PENDING,
  CHAT_ACCEPTANCE_TTL_MS,
  ChatAcceptanceTracker,
  isTrackableChat,
} from '../../../src/cli/handlers/chat-acceptance.ts';

const SESSION = 'session-0000-0000-0000-000000000001' as UUID;
const OTHER_SESSION = 'session-0000-0000-0000-000000000002' as UUID;
const CONN_A = 'conn-a000-0000-0000-000000000000' as UUID;
const CONN_B = 'conn-b000-0000-0000-000000000000' as UUID;
const id = (n: number) => `message-${n}` as UUID;

function setup(options: { canReceive?: (id: UUID) => boolean } = {}) {
  const sent: Array<{ connectionId: UUID; message: ProtocolMessage }> = [];
  let clock = 1_000;
  const tracker = new ChatAcceptanceTracker({
    send: (connectionId, message) => {
      sent.push({ connectionId, message });
      return true;
    },
    now: () => clock,
    ...options,
  });
  return {
    tracker,
    sent,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('isTrackableChat', () => {
  test.each([
    ['plain text', true],
    ['two\nlines', true],
    ['  padded  ', true],
    ['unicode: café ☃', true],
    ['', false],
    ['   \n ', false],
    ['carriage\rreturn', false],
    ['tab\there', false],
    ['escape\x1b[A', false],
    ['bell\x07', false],
    ['delete\x7f', false],
    ['c1 control \u0085', false],
  ])('%j -> %p', (text, expected) => {
    expect(isTrackableChat(text)).toBe(expected);
  });
});

describe('ChatAcceptanceTracker', () => {
  test('cross-kind signals do not confirm a second identical submission', () => {
    const timestamp = new Date(1000).toISOString();
    for (const first of ['attachment', 'hook'] as const) {
      const { tracker, sent, advance } = setup();
      tracker.record(SESSION, id(1), 'again', CONN_A);
      tracker.record(SESSION, id(2), 'again', CONN_B);
      if (first === 'attachment') {
        expect(tracker.queuedCommand(SESSION, 'again', timestamp, 'q1')).toBe(true);
        expect(tracker.promptSubmitted(SESSION, 'again')).toBe(false);
        expect(tracker.queuedCommand(SESSION, 'again', timestamp, 'q1')).toBe(false);
      } else {
        expect(tracker.promptSubmitted(SESSION, 'again')).toBe(true);
        expect(tracker.queuedCommand(SESSION, 'again', timestamp, 'q1')).toBe(false);
      }
      expect(sent).toHaveLength(1);
      advance(10_000);
      expect(tracker.queuedCommand(SESSION, 'again', timestamp, 'q2')).toBe(true);
      expect(sent.map((s) => s.connectionId)).toEqual([CONN_A, CONN_B]);
    }
  });

  test('two different attachments confirm identical texts FIFO', () => {
    const { tracker, sent } = setup();
    tracker.record(SESSION, id(1), 'again', CONN_A);
    tracker.record(SESSION, id(2), 'again', CONN_B);
    expect(tracker.queuedCommand(SESSION, 'different', new Date(1000).toISOString(), 'other')).toBe(
      false,
    );
    expect(tracker.queuedCommand(SESSION, 'again', undefined, 'q0')).toBe(false);
    expect(tracker.queuedCommand(SESSION, 'again', 'bad', 'q0')).toBe(false);
    expect(tracker.queuedCommand(SESSION, 'again', new Date(1000).toISOString(), 'q1')).toBe(true);
    expect(tracker.queuedCommand(SESSION, 'again', new Date(1000).toISOString(), 'q2')).toBe(true);
    expect(sent.map((s) => s.connectionId)).toEqual([CONN_A, CONN_B]);
  });

  test('an equal prompt resolves the message and tells only its connection', () => {
    const { tracker, sent } = setup();
    expect(tracker.record(SESSION, id(1), 'hello', CONN_A)).toBe(true);
    expect(tracker.promptSubmitted(SESSION, 'hello')).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.connectionId).toBe(CONN_A);
    expect(sent[0]?.message).toMatchObject({
      type: 'user_input_result',
      sessionId: SESSION,
      messageId: id(1),
      outcome: 'accepted',
    });
  });

  test.each([
    ['a prefix', 'hell'],
    ['a longer prompt', 'hello there'],
    ['a different case', 'Hello'],
    ['a trailing space', 'hello '],
    ['a leading space', ' hello'],
    ['a trailing newline', 'hello\n'],
    ['an empty prompt', ''],
  ])('%s does not match and nothing is sent', (_name, prompt) => {
    const { tracker, sent } = setup();
    tracker.record(SESSION, id(1), 'hello', CONN_A);
    expect(tracker.promptSubmitted(SESSION, prompt)).toBe(false);
    expect(sent).toEqual([]);
    // The entry is still waiting for its real prompt.
    expect(tracker.promptSubmitted(SESSION, 'hello')).toBe(true);
  });

  test('a multi-line message matches its exact text', () => {
    const { tracker, sent } = setup();
    tracker.record(SESSION, id(1), 'first line\nsecond line', CONN_A);
    expect(tracker.promptSubmitted(SESSION, 'first line second line')).toBe(false);
    expect(tracker.promptSubmitted(SESSION, 'first line\nsecond line')).toBe(true);
    expect(sent).toHaveLength(1);
  });

  test('identical texts resolve first in, first out, each once', () => {
    const { tracker, sent } = setup();
    tracker.record(SESSION, id(1), 'again', CONN_A);
    tracker.record(SESSION, id(2), 'again', CONN_B);
    tracker.record(SESSION, id(3), 'again', CONN_A);

    expect(tracker.promptSubmitted(SESSION, 'again')).toBe(true);
    expect(tracker.promptSubmitted(SESSION, 'again')).toBe(true);
    expect(sent.map((s) => [s.connectionId, (s.message as { messageId: UUID }).messageId])).toEqual(
      [
        [CONN_A, id(1)],
        [CONN_B, id(2)],
      ],
    );
    expect(tracker.promptSubmitted(SESSION, 'again')).toBe(true);
    expect(tracker.promptSubmitted(SESSION, 'again')).toBe(false);
    expect(sent).toHaveLength(3);
  });

  test('a different text does not consume an older entry of another text', () => {
    const { tracker, sent } = setup();
    tracker.record(SESSION, id(1), 'one', CONN_A);
    tracker.record(SESSION, id(2), 'two', CONN_A);
    expect(tracker.promptSubmitted(SESSION, 'two')).toBe(true);
    expect((sent[0]?.message as { messageId: UUID }).messageId).toBe(id(2));
    expect(tracker.promptSubmitted(SESSION, 'one')).toBe(true);
    expect((sent[1]?.message as { messageId: UUID }).messageId).toBe(id(1));
  });

  test('an entry expires silently and then matches nothing', () => {
    const { tracker, sent, advance } = setup();
    tracker.record(SESSION, id(1), 'late', CONN_A);
    advance(CHAT_ACCEPTANCE_TTL_MS - 1);
    // Still waiting just before the deadline.
    tracker.record(SESSION, id(2), 'other', CONN_A);
    advance(1);
    expect(tracker.promptSubmitted(SESSION, 'late')).toBe(false);
    expect(sent).toEqual([]);
    // The entry recorded later has its own deadline.
    expect(tracker.promptSubmitted(SESSION, 'other')).toBe(true);
  });

  test('an expired entry does not shadow a later identical message', () => {
    const { tracker, sent, advance } = setup();
    tracker.record(SESSION, id(1), 'same', CONN_A);
    advance(CHAT_ACCEPTANCE_TTL_MS);
    tracker.record(SESSION, id(2), 'same', CONN_B);
    expect(tracker.promptSubmitted(SESSION, 'same')).toBe(true);
    expect(sent[0]?.connectionId).toBe(CONN_B);
    expect((sent[0]?.message as { messageId: UUID }).messageId).toBe(id(2));
  });

  test('the list per session is bounded and drops the oldest without a word', () => {
    const { tracker, sent } = setup();
    for (let n = 0; n < CHAT_ACCEPTANCE_MAX_PENDING + 1; n++) {
      tracker.record(SESSION, id(n), `text ${n}`, CONN_A);
    }
    expect(tracker.promptSubmitted(SESSION, 'text 0')).toBe(false);
    expect(tracker.promptSubmitted(SESSION, 'text 1')).toBe(true);
    expect(sent).toHaveLength(1);
  });

  test('sessions are separate', () => {
    const { tracker, sent } = setup();
    tracker.record(SESSION, id(1), 'mine', CONN_A);
    expect(tracker.promptSubmitted(OTHER_SESSION, 'mine')).toBe(false);
    expect(sent).toEqual([]);
    tracker.forget(SESSION);
    expect(tracker.promptSubmitted(SESSION, 'mine')).toBe(false);
  });

  test('an untrackable text is not recorded, so a prompt with it matches nothing', () => {
    const { tracker, sent } = setup();
    expect(tracker.record(SESSION, id(1), 'a\rb', CONN_A)).toBe(false);
    expect(tracker.record(SESSION, id(2), '   ', CONN_A)).toBe(false);
    expect(tracker.promptSubmitted(SESSION, 'a\rb')).toBe(false);
    expect(tracker.promptSubmitted(SESSION, '   ')).toBe(false);
    expect(sent).toEqual([]);
  });

  test('a connection that did not list the capability is never told', () => {
    const { tracker, sent } = setup({ canReceive: (connection) => connection !== CONN_A });
    expect(tracker.record(SESSION, id(1), 'hi', CONN_A)).toBe(false);
    expect(tracker.record(SESSION, id(2), 'hi', CONN_B)).toBe(true);
    expect(tracker.promptSubmitted(SESSION, 'hi')).toBe(true);
    expect(sent.map((s) => s.connectionId)).toEqual([CONN_B]);
  });

  test('a send that throws is swallowed and the entry is still consumed', () => {
    const tracker = new ChatAcceptanceTracker({
      send: () => {
        throw new Error('socket closing');
      },
    });
    tracker.record(SESSION, id(1), 'hi', CONN_A);
    expect(tracker.promptSubmitted(SESSION, 'hi')).toBe(true);
    expect(tracker.promptSubmitted(SESSION, 'hi')).toBe(false);
  });
});
