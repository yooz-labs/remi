/** Real production WebSocketServer/Connection refusal and silence paths; no Codex admission fixture. */
import { expect, test } from 'bun:test';
import { type ChatSubmitRequest, createHello, generateId } from '@remi/shared';
import { WebSocketServer } from '../../../daemon/src/server/websocket-server';
import { findTestPort, pollUntil } from '../../../daemon/tests/integration/hub-test-utils';
import { deduplicateMessage, replaceTranscriptMessage } from '../../src/lib/message-dedup';
import { mergeResyncSurvivors, selectResyncSurvivors } from '../../src/lib/message-resync';
import { StructuredChatController, chatSubmissionLabel } from '../../src/lib/structured-chat';
import { WebSocketClient } from '../../src/lib/websocket-client';
import type { UIMessage } from '../../src/types';

async function fixture(silent = false, multiple = false) {
  const port = await findTestPort();
  const server = new WebSocketServer(
    { host: '127.0.0.1', port },
    silent ? { onStructuredChat: () => {} } : {},
  );
  const sessionId = generateId();
  let threadId = generateId();
  const other = { sessionId: generateId(), threadId: generateId() };
  const sent: ChatSubmitRequest[] = [];
  const client = new WebSocketClient(
    { url: `ws://127.0.0.1:${port}/ws`, autoReconnect: false, heartbeatInterval: 0 },
    {
      onStatusChange: (status) => {
        if (status === 'authenticating') client.send(createHello(generateId(), 'test'));
        else if (status !== 'connected') controller?.disconnect();
      },
      onMessage: (message) => {
        if (message.type === 'hello_ack') client.setConnected();
      },
      onStructuredChatResult: (result) => controller?.receive(result),
    },
  );
  const controller = new StructuredChatController(
    {
      context: (target) => {
        const generation = client.imageUploadGeneration;
        if (multiple && target === other.sessionId)
          return generation ? { generation, ...other } : null;
        if (target !== sessionId) return null;
        return generation ? { generation, sessionId, threadId } : null;
      },
      send: (request) => {
        sent.push(request);
        return client.sendStructuredChat(request);
      },
    },
    60,
  );
  await server.start();
  client.connect();
  await pollUntil(() => client.isConnected, 3000, 'real WebSocket handshake');
  return {
    client,
    server,
    controller,
    sessionId,
    thread: () => threadId,
    sent,
    other,
    rotate: () => {
      threadId = generateId();
      controller?.disconnect();
    },
    close: async () => {
      controller?.dispose();
      client.disconnect();
      await server.stop();
    },
  };
}

test('actual unavailable host refuses, preserves sequence on binding change, and malformed text emits no frame', async () => {
  const f = await fixture();
  try {
    for (const text of ['', '  ', 'a\0b', '\ud800', 'a'.repeat(16385)])
      expect(await f.controller.submit(f.sessionId, f.thread(), text)).toEqual({
        outcome: 'refused',
        code: 'malformed',
      });
    expect(f.sent).toEqual([]);
    expect(await f.controller.submit(f.sessionId, f.thread(), 'Continue.')).toMatchObject({
      outcome: 'refused',
      code: 'unavailable',
    });
    f.rotate();
    expect(await f.controller.submit(f.sessionId, f.thread(), '\uFEFFContinue.')).toMatchObject({
      outcome: 'refused',
      code: 'unavailable',
    });
    expect(f.sent.map((request) => request.seq)).toEqual([1, 2]);
    expect(f.sent[1]?.content).toBe('\uFEFFContinue.');
    f.client.disconnect();
    expect(await f.controller.submit(f.sessionId, f.thread(), 'No connection.')).toEqual({
      outcome: 'refused',
      code: 'unavailable',
    });
    expect(f.sent).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test('actual transport keeps separate child sequences and only invalidates the affected pending session', async () => {
  const f = await fixture(false, true);
  try {
    expect(await f.controller.submit(f.sessionId, f.thread(), 'First child.')).toMatchObject({
      outcome: 'refused',
    });
    expect(
      await f.controller.submit(f.other.sessionId, f.other.threadId, 'Second child.'),
    ).toMatchObject({ outcome: 'refused' });
    expect(await f.controller.submit(f.sessionId, f.thread(), 'First child again.')).toMatchObject({
      outcome: 'refused',
    });
    expect(f.sent.map((value) => [value.sessionId, value.seq])).toEqual([
      [f.sessionId, 1],
      [f.other.sessionId, 1],
      [f.sessionId, 2],
    ]);
  } finally {
    await f.close();
  }
  const silent = await fixture(true, true);
  try {
    let finished = false;
    const pending = silent.controller
      .submit(silent.sessionId, silent.thread(), 'Pending first child.')
      .then((value) => {
        finished = true;
        return value;
      });
    silent.controller.invalidateSession(silent.other.sessionId);
    await Bun.sleep(10);
    expect(finished).toBe(false);
    silent.controller.invalidateSession(silent.sessionId);
    expect(await pending).toMatchObject({ outcome: 'uncertain' });
    expect(silent.sent).toHaveLength(1);
  } finally {
    await silent.close();
  }
});

test('silence becomes uncertainty with no replay, new socket restarts sequence, and detach preserves uncertainty', async () => {
  const f = await fixture(true);
  try {
    const pending = f.controller.submit(f.sessionId, f.thread(), 'A single explicit intent.');
    expect(await f.controller.submit(f.sessionId, f.thread(), 'Concurrent.')).toEqual({
      outcome: 'refused',
      code: 'busy',
    });
    expect(await pending).toEqual({ outcome: 'uncertain', code: 'delivery_unknown' });
    expect(await f.controller.submit(f.sessionId, f.thread(), 'No blind follow-up.')).toEqual({
      outcome: 'refused',
      code: 'busy',
    });
    await Bun.sleep(100);
    expect(f.sent).toHaveLength(1);
    f.client.reconnectWithUrl(`ws://127.0.0.1:${f.server.port}/ws`);
    await pollUntil(() => f.client.isConnected, 3000, 'new concrete socket');
    const next = f.controller.submit(f.sessionId, f.thread(), 'Fresh explicit intent.');
    f.rotate();
    expect(await next).toEqual({ outcome: 'uncertain', code: 'delivery_unknown' });
    expect(f.sent.map((request) => request.seq)).toEqual([1, 1]);
    expect(f.sent[0]?.id).not.toBe(f.sent[1]?.id);
  } finally {
    await f.close();
  }
});

test('a similar transcript cannot silently erase uncertain structured input', () => {
  const uncertain: UIMessage = {
    id: generateId(),
    sessionId: generateId(),
    sender: 'user',
    content: 'Continue.',
    timestamp: new Date().toISOString(),
    state: 'failed',
    isEditing: false,
    chatSubmission: {
      outcome: 'uncertain',
      label: chatSubmissionLabel({ outcome: 'uncertain', code: 'delivery_unknown' }),
    },
  };
  const { chatSubmission: _submission, ...confirmed } = uncertain;
  const reloaded = { ...confirmed, id: generateId(), state: 'delivered' as const };
  const survivors = selectResyncSurvivors([uncertain], uncertain.sessionId);
  expect(survivors).toEqual([uncertain]);
  expect(mergeResyncSurvivors([reloaded], survivors)).toContain(uncertain);
  expect(
    deduplicateMessage([{ ...uncertain, source: 'optimistic' }], {
      ...reloaded,
      source: 'transcript',
      entryUuid: reloaded.id,
    }),
  ).toMatchObject({ action: 'replace' });
  expect(
    deduplicateMessage(
      [
        {
          ...uncertain,
          source: 'optimistic',
          chatSubmission: { outcome: 'refused', label: 'Not sent' },
        },
      ],
      { ...reloaded, source: 'transcript', entryUuid: reloaded.id },
    ),
  ).toEqual({ action: 'add' });
  expect(
    deduplicateMessage([{ ...uncertain, source: 'optimistic' }], {
      ...reloaded,
      source: 'transcript',
      entryUuid: uncertain.id,
    }),
  ).toMatchObject({ action: 'replace' });
  expect(replaceTranscriptMessage(uncertain, reloaded).chatSubmission).toEqual(
    uncertain.chatSubmission,
  );
  expect(replaceTranscriptMessage(uncertain, reloaded).state).toBe('failed');
  expect(
    chatSubmissionLabel({ outcome: 'accepted', method: 'turn/start', turnId: generateId() }),
  ).toBe('Accepted by Codex');
  expect(chatSubmissionLabel({ outcome: 'refused', code: 'prompt_up' })).toContain(
    'Answer the pending prompt',
  );
});
