import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInputHandlers } from '../../packages/daemon/src/cli/handlers/input-events.ts';
import { __resetLoggerForTests, configureLogger } from '../../packages/daemon/src/cli/logger.ts';
import { WebSocketServer } from '../../packages/daemon/src/server/websocket-server.ts';
import { SessionBindingStore } from '../../packages/daemon/src/session/session-binding-store.ts';
import { SessionRegistry } from '../../packages/daemon/src/session/session-registry.ts';
import { SessionStore } from '../../packages/daemon/src/session/session-store.ts';
import { reserveRange } from '../../packages/daemon/tests/session/port-test-helpers.ts';
import {
  createHello,
  createUserInput,
  deserialize,
  serialize,
} from '../../packages/shared/src/index.ts';
test('real WebSocket user input does not enter plaintext logs even when refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'remi-r3-log-state-'));
  chmodSync(dir, 0o700);
  const registry = new SessionRegistry();
  const store = new SessionStore(join(dir, 'sessions.json'));
  const logs: string[] = [];
  configureLogger({ writeLog: (m) => logs.push(m) });
  let server: WebSocketServer | undefined;
  let ws: WebSocket | undefined;
  try {
    const handlers = createInputHandlers({
      sessionRegistry: registry,
      bindingStore: new SessionBindingStore(store),
      send: (id, msg) => (server ? server.sendTo(id, msg) : false),
    });
    const port = await reserveRange(1);
    server = new WebSocketServer(
      { port, host: '127.0.0.1' },
      { onUserInput: handlers.onUserInput },
    );
    await server.start();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws = socket;
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => socket.send(serialize(createHello('owned', '2.0.0')));
      socket.onmessage = (e) => {
        if (deserialize(String(e.data))?.type === 'hello_ack') resolve();
      };
      socket.onerror = () => reject(Error('ws'));
    });
    ws.send(serialize(createUserInput('owned-session', 'OWNED_PRIVATE_INPUT_SENTINEL', false)));
    const deadline = Date.now() + 1000;
    while (!logs.some((m) => m.includes('User input'))) {
      if (Date.now() > deadline) throw Error('deadline');
      await Bun.sleep(5);
    }
    const exposed = logs.some((m) => m.includes('OWNED_PRIVATE_INPUT_SENTINEL'));
    expect(exposed).toBe(false);
  } finally {
    ws?.close();
    await server?.stop();
    await registry.shutdown();
    __resetLoggerForTests();
    rmSync(dir, { recursive: true, force: true });
  }
}, 3000);
