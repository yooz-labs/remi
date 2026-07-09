import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createAgentOutput,
  createError,
  createHelloAck,
  createPing,
  createQuestion,
  createQuestionResolved,
  createReplayBatch,
  deserialize,
  generateId,
  now,
  serialize,
} from '@remi/shared';
import type { Message, Question, UUID } from '@remi/shared';
import { runAttachClient } from '../../src/cli/attach-client.ts';

const TEST_PORT = 9873;

function makeMessage(content: string): Message {
  return {
    id: generateId(),
    sessionId: generateId() as UUID,
    sender: 'agent',
    content,
    createdAt: now(),
    state: 'delivered',
    stateChangedAt: now(),
    isEditing: false,
  };
}

describe('runAttachClient', () => {
  let server: ReturnType<typeof Bun.serve> | null = null;
  let outputPath: string;
  let outputFd: number;
  let outputClosed: boolean;

  function setupOutput(): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-attach-test-'));
    outputPath = path.join(dir, 'output.txt');
    fs.writeFileSync(outputPath, '');
    outputFd = fs.openSync(outputPath, 'w');
    outputClosed = false;
  }

  function readOutput(): string {
    if (!outputClosed) {
      fs.closeSync(outputFd);
      outputClosed = true;
    }
    return fs.readFileSync(outputPath, 'utf-8');
  }

  afterEach(() => {
    if (server) {
      server.stop(true);
      server = null;
    }
    if (!outputClosed) {
      try {
        fs.closeSync(outputFd);
        outputClosed = true;
      } catch {
        // fd may be invalid if setupOutput was never called
      }
    }
  });

  test('sends hello with resumeSessionId', async () => {
    setupOutput();
    const targetSessionId = generateId();
    const receivedMessages: string[] = [];

    server = Bun.serve({
      port: TEST_PORT,
      fetch(req, srv) {
        if (srv.upgrade(req, { data: {} })) return;
        return new Response('Not found', { status: 404 });
      },
      websocket: {
        open() {},
        message(ws, data) {
          const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
          receivedMessages.push(text);
          const msg = deserialize(text);
          if (!msg) return;

          if (msg.type === 'hello') {
            // Verify resumeSessionId is set
            const hello = msg;
            expect(hello.resumeSessionId).toBe(targetSessionId);

            // Send hello_ack then close after a short delay
            ws.send(serialize(createHelloAck('1.0.0', targetSessionId as UUID)));
            setTimeout(() => ws.close(), 100);
          }
        },
        close() {},
      },
    });

    const result = await runAttachClient({
      host: 'localhost',
      port: TEST_PORT,
      sessionId: targetSessionId,
      timeout: 3000,
      outputFd,
    });

    const output = readOutput();
    expect(output).toContain('[attached to session');
    expect(result.reason).toBe('connection_closed');
  });

  test('suppresses agent_output in replay batch (raw PTY provides full view)', async () => {
    setupOutput();
    const targetSessionId = generateId();

    server = Bun.serve({
      port: TEST_PORT + 1,
      fetch(req, srv) {
        if (srv.upgrade(req, { data: {} })) return;
        return new Response('Not found', { status: 404 });
      },
      websocket: {
        open() {},
        message(ws, data) {
          const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
          const msg = deserialize(text);
          if (!msg) return;

          if (msg.type === 'hello') {
            ws.send(serialize(createHelloAck('1.0.0', targetSessionId as UUID)));

            // Send a replay batch with agent output
            const replayMsg = createAgentOutput(makeMessage('Hello from replay'));
            ws.send(serialize(createReplayBatch(targetSessionId as UUID, [replayMsg], true)));

            // Close after sending
            setTimeout(() => ws.close(), 200);
          }
        },
        close() {},
      },
    });

    await runAttachClient({
      host: 'localhost',
      port: TEST_PORT + 1,
      sessionId: targetSessionId,
      timeout: 3000,
      outputFd,
    });

    const output = readOutput();
    // agent_output is suppressed in terminal attach mode; raw PTY provides the view
    expect(output).not.toContain('Hello from replay');
  });

  test('returns error when server is not running', async () => {
    setupOutput();
    const unusedPort = 9875;
    const result = await runAttachClient({
      host: 'localhost',
      port: unusedPort,
      sessionId: generateId(),
      timeout: 1000,
      outputFd,
    });
    expect(result.exitCode).toBe(1);
    expect(result.reason).toBe('error');
  });

  test('handles SESSION_ENDED with clean exit', async () => {
    setupOutput();
    const targetSessionId = generateId();

    server = Bun.serve({
      port: TEST_PORT + 2,
      fetch(req, srv) {
        if (srv.upgrade(req, { data: {} })) return;
        return new Response('Not found', { status: 404 });
      },
      websocket: {
        open() {},
        message(ws, data) {
          const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
          const msg = deserialize(text);
          if (!msg) return;

          if (msg.type === 'hello') {
            ws.send(serialize(createHelloAck('1.0.0', targetSessionId as UUID)));
            setTimeout(() => {
              ws.send(serialize(createError('SESSION_ENDED', 'Session ended')));
            }, 50);
          }
        },
        close() {},
      },
    });

    const result = await runAttachClient({
      host: 'localhost',
      port: TEST_PORT + 2,
      sessionId: targetSessionId,
      timeout: 3000,
      outputFd,
    });

    const output = readOutput();
    expect(output).toContain('[session ended]');
    expect(result.exitCode).toBe(0);
    expect(result.reason).toBe('session_ended');
  });

  test('responds to ping with pong', async () => {
    setupOutput();
    const targetSessionId = generateId();
    const receivedMessages: string[] = [];

    server = Bun.serve({
      port: TEST_PORT + 3,
      fetch(req, srv) {
        if (srv.upgrade(req, { data: {} })) return;
        return new Response('Not found', { status: 404 });
      },
      websocket: {
        open() {},
        message(ws, data) {
          const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
          receivedMessages.push(text);
          const msg = deserialize(text);
          if (!msg) return;

          if (msg.type === 'hello') {
            ws.send(serialize(createHelloAck('1.0.0', targetSessionId as UUID)));
            // Send a ping after hello_ack
            setTimeout(() => {
              ws.send(serialize(createPing()));
            }, 50);
            // Close after giving time for pong
            setTimeout(() => ws.close(), 200);
          }
        },
        close() {},
      },
    });

    await runAttachClient({
      host: 'localhost',
      port: TEST_PORT + 3,
      sessionId: targetSessionId,
      timeout: 3000,
      outputFd,
    });

    // Find the pong response in received messages
    const pongMsg = receivedMessages.find((text) => {
      const msg = deserialize(text);
      return msg?.type === 'pong';
    });
    expect(pongMsg).toBeTruthy();
  });

  function makeQuestion(text: string): Question {
    return {
      id: generateId() as UUID,
      text,
      options: [
        { label: 'Yes', value: 'yes', isRecommended: true, isYes: true, isNo: false },
        { label: 'No', value: 'no', isRecommended: false, isYes: false, isNo: true },
      ],
      allowsFreeText: false,
      isAnswered: false,
    };
  }

  // #753: a HELD permission (Model B) blocks Claude inside the hook, so no
  // raw PTY bytes for the prompt ever exist — the LIVE question message is
  // the only signal an attached terminal gets, and it must render.
  test('renders a banner for a LIVE question (held prompts never paint the PTY)', async () => {
    setupOutput();
    const targetSessionId = generateId();
    const question = makeQuestion('Allow file edit?');

    server = Bun.serve({
      port: TEST_PORT + 4,
      fetch(req, srv) {
        if (srv.upgrade(req, { data: {} })) return;
        return new Response('Not found', { status: 404 });
      },
      websocket: {
        open() {},
        message(ws, data) {
          const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
          const msg = deserialize(text);
          if (!msg) return;

          if (msg.type === 'hello') {
            ws.send(serialize(createHelloAck('1.0.0', targetSessionId as UUID)));
            setTimeout(() => {
              // Duplicate delivery (daemon re-send + broadcast): renders once.
              ws.send(serialize(createQuestion(question, targetSessionId as UUID)));
              ws.send(serialize(createQuestion(question, targetSessionId as UUID)));
            }, 50);
            setTimeout(() => ws.close(), 200);
          }
        },
        close() {},
      },
    });

    await runAttachClient({
      host: 'localhost',
      port: TEST_PORT + 4,
      sessionId: targetSessionId,
      timeout: 3000,
      outputFd,
    });

    const output = readOutput();
    expect(output).toContain('[remi] pending question: Allow file edit?');
    expect(output).toContain('1) Yes  2) No');
    expect(output).toContain("run 'remi unstick'");
    // Bannered exactly once despite the duplicate delivery.
    expect(output.split('pending question: Allow file edit?').length).toBe(2);
  });

  test('suppresses questions inside a replay batch (history cannot prove pendingness)', async () => {
    setupOutput();
    const targetSessionId = generateId();
    const question = makeQuestion('Old replayed question?');

    server = Bun.serve({
      port: TEST_PORT + 5,
      fetch(req, srv) {
        if (srv.upgrade(req, { data: {} })) return;
        return new Response('Not found', { status: 404 });
      },
      websocket: {
        open() {},
        message(ws, data) {
          const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
          const msg = deserialize(text);
          if (!msg) return;

          if (msg.type === 'hello') {
            ws.send(serialize(createHelloAck('1.0.0', targetSessionId as UUID)));
            ws.send(
              serialize(
                createReplayBatch(
                  targetSessionId as UUID,
                  [createQuestion(question, targetSessionId as UUID)],
                  true,
                ),
              ),
            );
            setTimeout(() => ws.close(), 200);
          }
        },
        close() {},
      },
    });

    await runAttachClient({
      host: 'localhost',
      port: TEST_PORT + 5,
      sessionId: targetSessionId,
      timeout: 3000,
      outputFd,
    });

    const output = readOutput();
    // A replayed question may have been answered long ago (question_resolved
    // is never recorded into history), so no banner.
    expect(output).not.toContain('Old replayed question?');
  });

  test('acknowledges question_resolved only for questions it bannered', async () => {
    setupOutput();
    const targetSessionId = generateId();
    const question = makeQuestion('Allow push?');
    const unrelatedQuestionId = generateId() as UUID;

    server = Bun.serve({
      port: TEST_PORT + 6,
      fetch(req, srv) {
        if (srv.upgrade(req, { data: {} })) return;
        return new Response('Not found', { status: 404 });
      },
      websocket: {
        open() {},
        message(ws, data) {
          const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
          const msg = deserialize(text);
          if (!msg) return;

          if (msg.type === 'hello') {
            ws.send(serialize(createHelloAck('1.0.0', targetSessionId as UUID)));
            setTimeout(() => {
              // A resolved broadcast for a question never bannered: silent.
              ws.send(
                serialize(
                  createQuestionResolved(targetSessionId as UUID, unrelatedQuestionId, 'answered'),
                ),
              );
              ws.send(serialize(createQuestion(question, targetSessionId as UUID)));
              ws.send(
                serialize(createQuestionResolved(targetSessionId as UUID, question.id, 'answered')),
              );
            }, 50);
            setTimeout(() => ws.close(), 250);
          }
        },
        close() {},
      },
    });

    await runAttachClient({
      host: 'localhost',
      port: TEST_PORT + 6,
      sessionId: targetSessionId,
      timeout: 3000,
      outputFd,
    });

    const output = readOutput();
    expect(output).toContain('[remi] pending question: Allow push?');
    expect(output.split('[remi] question answered').length).toBe(2); // exactly once
  });
});
