/**
 * Tests for the question_snapshot broadcast (#798 part 2).
 *
 * Reproduces the exact glue cli.ts wires into `SessionRegistry`'s
 * `onQuestionsChanged` (fired on every add/remove/clear -- shared with the
 * #786/#787 live-sessions mirror): broadcast a `createQuestionSnapshot` of the
 * live question-id set to every connected client. cli.ts itself is a CLI
 * composition root (parses argv, spins up the whole daemon) and is not
 * unit-testable directly, so this test exercises the same two collaborators
 * (`SessionRegistry` + `WebSocketServer`) it wires together, over a REAL
 * WebSocket connection -- no mocks of the thing under test.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  type ProtocolMessage,
  type QuestionSnapshotMessage,
  createHello,
  createQuestionSnapshot,
  generateId,
  serialize,
} from '@remi/shared';
import type { MessageAPI } from '../src/api/message-api.ts';
import type { PTYSession } from '../src/pty/pty-session.ts';
import { WebSocketServer } from '../src/server/websocket-server.ts';
import { SessionRegistry } from '../src/session/session-registry.ts';

function createMockPTY(): PTYSession {
  return {
    id: generateId(),
    close: mock(() => Promise.resolve()),
  } as unknown as PTYSession;
}

function createMockMessageAPI(): MessageAPI {
  return {
    bulletCount: 0,
    handleMessage: mock(() => {}),
    handleMessageUpdate: mock(() => {}),
    reset: mock(() => {}),
  } as unknown as MessageAPI;
}

function mkQuestion(id: string, agentId?: string) {
  return {
    id: id as ReturnType<typeof generateId>,
    text: `${id}?`,
    options: [],
    allowsFreeText: true,
    isAnswered: false,
    ...(agentId !== undefined && { agentId }),
  };
}

/** Waits for the next `question_snapshot` broadcast on `ws`. */
function nextSnapshot(ws: WebSocket): Promise<QuestionSnapshotMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for snapshot')), 5000);
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data.toString()) as ProtocolMessage;
      if (data.type === 'question_snapshot') {
        clearTimeout(timeout);
        resolve(data);
      }
    };
  });
}

describe('question_snapshot broadcast (#798)', () => {
  let server: WebSocketServer;
  let registry: SessionRegistry;
  const testPort = 9950;

  beforeEach(() => {
    server = new WebSocketServer({ port: testPort });
    // Mirrors cli.ts's onQuestionsChanged wiring exactly: broadcast the live
    // question-id set to every connected client on every add/remove/clear.
    registry = new SessionRegistry(
      { orphanTimeoutMs: 60_000 },
      {
        onQuestionsChanged: (sessionId, questions) => {
          server.broadcast(
            createQuestionSnapshot(
              sessionId,
              questions.map((q) => q.id),
            ),
          );
        },
      },
    );
  });

  afterEach(async () => {
    await registry.shutdown();
    if (server.running) {
      await server.stop();
    }
  });

  async function connectClient(): Promise<WebSocket> {
    await server.start();
    const ws = new WebSocket(`ws://localhost:${testPort}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => ws.send(serialize(createHello('test-client', '1.0.0')));
      ws.onmessage = (event) => {
        const data = JSON.parse(event.data.toString());
        if (data.type === 'hello_ack') resolve();
      };
      ws.onerror = () => reject(new Error('WebSocket error'));
      setTimeout(() => reject(new Error('Connection timeout')), 5000);
    });
    return ws;
  }

  test('addQuestion broadcasts a snapshot with the full live id set', async () => {
    const ws = await connectClient();
    const sid = generateId();
    registry.registerSession(sid, '/test/dir', createMockPTY(), createMockMessageAPI());

    const q1 = generateId();
    const snapshotPromise = nextSnapshot(ws);
    registry.addQuestion(sid, mkQuestion(q1));
    const snapshot = await snapshotPromise;

    expect(snapshot.sessionId).toBe(sid);
    expect(snapshot.questionIds).toEqual([q1]);

    ws.close();
  });

  test('a second addQuestion broadcasts BOTH ids (main + subagent)', async () => {
    const ws = await connectClient();
    const sid = generateId();
    registry.registerSession(sid, '/test/dir', createMockPTY(), createMockMessageAPI());

    const q1 = generateId();
    const q2 = generateId();
    registry.addQuestion(sid, mkQuestion(q1));
    await nextSnapshot(ws);

    const snapshotPromise = nextSnapshot(ws);
    registry.addQuestion(sid, mkQuestion(q2, 'sub-7'));
    const snapshot = await snapshotPromise;

    expect(snapshot.sessionId).toBe(sid);
    expect(new Set(snapshot.questionIds)).toEqual(new Set([q1, q2]));

    ws.close();
  });

  test('removeQuestion broadcasts the reduced set', async () => {
    const ws = await connectClient();
    const sid = generateId();
    registry.registerSession(sid, '/test/dir', createMockPTY(), createMockMessageAPI());

    const q1 = generateId();
    const q2 = generateId();
    registry.addQuestion(sid, mkQuestion(q1));
    await nextSnapshot(ws);
    registry.addQuestion(sid, mkQuestion(q2));
    await nextSnapshot(ws);

    const snapshotPromise = nextSnapshot(ws);
    registry.removeQuestion(sid, q1);
    const snapshot = await snapshotPromise;

    expect(snapshot.sessionId).toBe(sid);
    expect(snapshot.questionIds).toEqual([q2]);

    ws.close();
  });

  test('clearQuestions broadcasts an empty set', async () => {
    const ws = await connectClient();
    const sid = generateId();
    registry.registerSession(sid, '/test/dir', createMockPTY(), createMockMessageAPI());

    registry.addQuestion(sid, mkQuestion(generateId()));
    await nextSnapshot(ws);

    const snapshotPromise = nextSnapshot(ws);
    registry.clearQuestions(sid);
    const snapshot = await snapshotPromise;

    expect(snapshot.sessionId).toBe(sid);
    expect(snapshot.questionIds).toEqual([]);

    ws.close();
  });

  test('a connected client with no onQuestionsChanged consumer receives nothing (sanity: unrelated events do not broadcast)', async () => {
    const ws = await connectClient();
    const sid = generateId();
    registry.registerSession(sid, '/test/dir', createMockPTY(), createMockMessageAPI());

    let received = false;
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data.toString());
      if (data.type === 'question_snapshot') received = true;
    };

    // registerSession alone (no question activity) must not fire a snapshot.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(received).toBe(false);

    ws.close();
  });
});
