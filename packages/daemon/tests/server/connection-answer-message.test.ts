/**
 * #1126: a "No" on a held permission card may carry a `message` that Claude
 * receives as the denied tool's result. The WebSocket transport must hand it
 * to `onAnswer` as `extra.message`; before this test nothing pinned that.
 *
 * Real `Connection`; the socket is a capture double (same pattern as
 * connection-auth.test.ts).
 */

import { describe, expect, test } from 'bun:test';
import { createAnswer, createHello, deserialize, serialize } from '@remi/shared';
import type { AnswerExtras, ProtocolMessage, UUID } from '@remi/shared';
import { Connection } from '../../src/server/connection.ts';

class MockWebSocket {
  readyState = WebSocket.OPEN;
  sentMessages: ProtocolMessage[] = [];

  send(data: string): void {
    const msg = deserialize(data);
    if (msg) this.sentMessages.push(msg);
  }

  close(): void {}
}

const SID = 'aaaaaaaa-0000-0000-0000-000000000001' as UUID;
const QID = 'bbbbbbbb-0000-0000-0000-000000000001' as UUID;

function connected(calls: Array<{ answer: string; extra: AnswerExtras | undefined }>): Connection {
  const ws = new MockWebSocket();
  const conn = new Connection(
    ws as unknown as WebSocket,
    {
      onAnswer: (_sessionId, _questionId, answer, _claudeSessionId, extra) => {
        calls.push({ answer, extra });
      },
    },
    {},
  );
  conn.handleMessage(serialize(createHello('client-1' as UUID, '1.0.0')));
  return conn;
}

describe('Connection answer: the deny message reaches onAnswer (#1126)', () => {
  test('a No with a message forwards it as extra.message', () => {
    const calls: Array<{ answer: string; extra: AnswerExtras | undefined }> = [];
    const conn = connected(calls);
    conn.handleMessage(serialize(createAnswer(SID, QID, 'No', undefined, 'run the tests first')));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.answer).toBe('No');
    expect(calls[0]?.extra?.message).toBe('run the tests first');
  });

  test('an answer without a message carries no extra', () => {
    const calls: Array<{ answer: string; extra: AnswerExtras | undefined }> = [];
    const conn = connected(calls);
    conn.handleMessage(serialize(createAnswer(SID, QID, 'Yes')));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.extra).toBeUndefined();
  });
});
