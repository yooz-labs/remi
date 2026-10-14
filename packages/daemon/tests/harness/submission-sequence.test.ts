/** These controls use the real writer/client in an unavailable state, not a Codex response stub. */
import { expect, test } from 'bun:test';
import type { ChatSubmitRequest } from '@remi/shared/structured-chat.ts';
import {
  decodeStructuredChatFrame,
  encodeStructuredChatFrame,
} from '@remi/shared/structured-chat.ts';
import { AppServerClient } from '../../src/harness/codex/app-server-client.ts';
import { CodexTextWriter } from '../../src/harness/codex/codex-text-writer.ts';
import { SubmissionSequence } from '../../src/harness/submission-sequence.ts';

const threadId = '00112233-4455-7677-8899-aabbccddeeff';
const request = (seq: number): ChatSubmitRequest => ({
  type: 'chat_submit_request',
  id: crypto.randomUUID(),
  timestamp: new Date().toISOString(),
  sessionId: '11223344-5566-4788-99aa-bbccddeeff00',
  seq,
  binding: { harness: 'codex', harnessSessionId: threadId },
  content: 'Continue this task.',
});
function fixture() {
  const client = new AppServerClient(
    {
      socketPath: () => '/nonexistent/remi-sequence.sock',
      clientInfo: { name: 'remi', title: null, version: 'test' },
    },
    () => {},
  );
  const writer = new CodexTextWriter({
    client,
    current: () => ({ threadId, epoch: client }),
    blocked: () => false,
  });
  const sequence = new SubmissionSequence();
  const calls: ChatSubmitRequest[] = [];
  const submit = (value: ChatSubmitRequest) =>
    sequence.submit(value, async (captured) => {
      calls.push(captured);
      return writer.send(
        { id: captured.id, threadId: captured.binding.harnessSessionId, text: captured.content },
        () => true,
      );
    });
  return {
    sequence,
    submit,
    calls,
    close: () => {
      sequence.close();
      writer.close();
      client.stop();
    },
  };
}

test('concurrent matching request shares one actual writer call and frozen correlated receipt', async () => {
  const f = fixture();
  try {
    const first = request(1);
    const [a, b] = await Promise.all([
      f.submit(first),
      f.submit({ ...first, binding: { ...first.binding } }),
    ]);
    expect(f.calls).toHaveLength(1);
    expect(a).toBe(b);
    expect(a).toMatchObject({
      requestId: first.id,
      sessionId: first.sessionId,
      seq: 1,
      outcome: 'refused',
      code: 'unavailable',
    });
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(f.calls[0])).toBe(true);
    expect(Object.isFrozen(f.calls[0]?.binding)).toBe(true);
    expect(decodeStructuredChatFrame(encodeStructuredChatFrame(a))).toEqual(a);
  } finally {
    f.close();
  }
});

test('busy, conflict, sequence gaps and changed property order never repeat the earlier call', async () => {
  const f = fixture();
  try {
    const first = request(1);
    const pending = f.submit(first);
    expect(await f.submit({ ...first, content: 'different' })).toMatchObject({
      outcome: 'uncertain',
      code: 'conflict',
    });
    expect(await f.submit(request(2))).toMatchObject({ outcome: 'refused', code: 'busy' });
    await pending;
    expect(await f.submit({ ...first, content: 'different' })).toMatchObject({
      outcome: 'refused',
      code: 'conflict',
    });
    expect(await f.submit(request(4))).toMatchObject({ outcome: 'refused', code: 'sequence' });
    expect(
      await f.submit({
        content: first.content,
        binding: first.binding,
        seq: first.seq,
        sessionId: first.sessionId,
        timestamp: first.timestamp,
        id: first.id,
        type: first.type,
      }),
    ).toMatchObject({ requestId: first.id, outcome: 'refused', code: 'unavailable' });
    expect(f.calls).toHaveLength(1);
    expect(await f.submit({ ...first, seq: 3 })).toMatchObject({
      outcome: 'refused',
      code: 'conflict',
    });
    expect(f.calls).toHaveLength(1);
    await f.submit(request(4));
    expect(f.calls).toHaveLength(2);
  } finally {
    f.close();
  }
});

test('receipt eviction keeps a high-water mark and refuses re-execution of old requests', async () => {
  const f = fixture();
  try {
    const first = request(1);
    await f.submit(first);
    for (let seq = 2; seq <= 130; seq++) await f.submit(request(seq));
    expect(f.calls).toHaveLength(130);
    expect(await f.submit(first)).toMatchObject({
      outcome: 'uncertain',
      code: 'receipt_expired',
      requestId: first.id,
      seq: 1,
    });
    expect(f.calls).toHaveLength(130);
  } finally {
    f.close();
  }
});

test('a pending record remains pinned while later busy receipts fill the bounded cache', async () => {
  const f = fixture();
  try {
    const first = request(1);
    const pending = f.submit(first);
    // Reserve these calls synchronously, before the real unavailable writer settles.
    const busy = Array.from({ length: 64 }, (_, i) => f.submit(request(i + 2)));
    const duplicate = f.submit(first);
    const [a, b] = await Promise.all([pending, duplicate]);
    expect(a).toBe(b);
    for (const response of await Promise.all(busy))
      expect(response).toMatchObject({ outcome: 'refused', code: 'busy' });
    expect(f.calls).toHaveLength(1);
  } finally {
    f.close();
  }
});

test('closing before the scheduled writer call prevents it; malformed requests never enter', async () => {
  const f = fixture();
  try {
    await expect(f.submit({ ...request(1), extra: true } as ChatSubmitRequest)).rejects.toThrow(
      'Invalid structured chat frame',
    );
    const pending = f.submit(request(1));
    f.sequence.close();
    expect(await pending).toMatchObject({ outcome: 'refused', code: 'unavailable' });
    expect(f.calls).toHaveLength(0);
    expect(await f.submit(request(2))).toMatchObject({ outcome: 'refused', code: 'unavailable' });
  } finally {
    f.close();
  }
});
