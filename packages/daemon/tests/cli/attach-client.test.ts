import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createAgentOutput,
  createHelloAck,
  createReplayBatch,
  deserialize,
  generateId,
  now,
  serialize,
} from '@remi/shared';
import type { Message, UUID } from '@remi/shared';
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
  };
}

describe('runAttachClient', () => {
  let server: ReturnType<typeof Bun.serve> | null = null;
  let outputPath: string;
  let outputFd: number;

  function setupOutput(): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-attach-test-'));
    outputPath = path.join(dir, 'output.txt');
    fs.writeFileSync(outputPath, '');
    outputFd = fs.openSync(outputPath, 'w');
  }

  function readOutput(): string {
    // Flush and re-read
    fs.closeSync(outputFd);
    return fs.readFileSync(outputPath, 'utf-8');
  }

  afterEach(() => {
    if (server) {
      server.stop(true);
      server = null;
    }
    try {
      fs.closeSync(outputFd);
    } catch {
      // may already be closed
    }
  });

  test('sends hello with resumeSessionId', async () => {
    setupOutput();
    const targetSessionId = generateId();
    const receivedMessages: string[] = [];

    server = Bun.serve({
      port: TEST_PORT,
      fetch(req, srv) {
        if (srv.upgrade(req)) return;
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

  test('renders replay batch messages', async () => {
    setupOutput();
    const targetSessionId = generateId();

    server = Bun.serve({
      port: TEST_PORT + 1,
      fetch(req, srv) {
        if (srv.upgrade(req)) return;
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
    expect(output).toContain('Hello from replay');
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
});
