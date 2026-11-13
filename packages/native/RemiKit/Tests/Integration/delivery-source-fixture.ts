/** Owned source transport/input handlers and real inert cat PTY. No harness or provider runs. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createError, createHelloAck, createSessionListResponse, generateId } from '@remi/shared';
import { MessageAPI } from '../../../../daemon/src/api/message-api';
import { Authenticator } from '../../../../daemon/src/auth/authenticator';
import { IdentityStore } from '../../../../daemon/src/auth/identity-store';
import { createInputHandlers } from '../../../../daemon/src/cli/handlers/input-events';
import { createSessionHandlers } from '../../../../daemon/src/cli/handlers/session-events';
import { PTYSession } from '../../../../daemon/src/pty/pty-session';
import { WebSocketServer } from '../../../../daemon/src/server/websocket-server';
import { SessionBindingStore } from '../../../../daemon/src/session/session-binding-store';
import { SessionRegistry } from '../../../../daemon/src/session/session-registry';
import { SessionRegistryFile } from '../../../../daemon/src/session/session-registry-file';
import { SessionStore } from '../../../../daemon/src/session/session-store';
import { TranscriptDiscovery } from '../../../../daemon/src/transcript/transcript-discovery';

const mode = process.argv[2];
const publicKey = process.argv[3];
if (!['refuse', 'allow', 'partial'].includes(mode ?? '') || !publicKey)
  throw new Error('owned arguments required');
// Metadata only on stdout; source logger output stays in the retained stderr log.
console.log = (...args) => console.error(...args);
const directory = mkdtempSync(join(tmpdir(), 'remi-delivery-source-'));
const trust = new IdentityStore(directory);
await trust.generate();
await trust.addAuthorizedKey(publicKey, 'owned-delivery-test');
const identity = await trust.unlock();
const sessionId = generateId();
const registry = new SessionRegistry(
  {},
  { onSessionClosed: (session) => lifecycle?.resolveStopOnClose(session) },
);
let prompt = false;
let inputs = 0;
let outputBytes = 0;
const pty = new PTYSession(
  { command: '/bin/cat', cwd: directory, env: { HOME: directory, PATH: '/usr/bin:/bin' } },
  {
    onData: (data) => {
      outputBytes += Buffer.byteLength(data);
    },
    onStatusChange() {},
    onExit() {},
    onError: (error) => {
      throw error;
    },
  },
  {
    submitDelay: async () => {
      if (mode === 'partial') prompt = true;
      await Bun.sleep(50);
    },
  },
);
await pty.start();
registry.registerSession(sessionId, directory, pty, new MessageAPI({ sessionId }), true);
const binding = new SessionBindingStore(new SessionStore(join(directory, 'sessions.json')));
const handlers = createInputHandlers({
  sessionRegistry: registry,
  bindingStore: binding,
  send: (id, message) => {
    server.sendTo(id, message);
  },
  acceptsTypedChat: () => mode !== 'refuse',
  promptUp: () => (prompt ? 'held' : null),
});
const server = new WebSocketServer(
  {
    port: 0,
    host: '127.0.0.1',
    connection: {
      authenticator: new Authenticator({ identity, identityStore: trust }),
      skipHelloAck: true,
    },
  },
  {
    onClientConnect(connection) {
      registry.attachConnection(sessionId, connection.id);
      connection.send(createHelloAck('owned-delivery-test', sessionId));
    },
    onSessionListRequest(id, request) {
      server.sendTo(id, createSessionListResponse(registry.listSessions(), request));
    },
    async onUserInput(...args) {
      inputs++;
      await handlers.onUserInput(...args);
    },
    onKillSessionRequest: (...args) => lifecycle?.onKillSessionRequest(...args),
    onTranscriptLoadRequest(id, session) {
      server.sendTo(
        id,
        createError('SESSION_NOT_FOUND', 'Owned unrelated history refusal', { sessionId: session }),
      );
    },
  },
);
const lifecycle = createSessionHandlers({
  sessionRegistry: registry,
  bindingStore: binding,
  transcriptDiscovery: new TranscriptDiscovery({
    projectsDir: join(directory, 'owned-empty-projects'),
  }),
  // This inert PTY has no graceful agent exit command. Exercise the source forced-close path.
  harness: { gracefulExitInput: null, transcriptPath: () => null },
  liveSessionsRegistry: new SessionRegistryFile(join(directory, 'live')),
  currentPort: () => server.port,
  untrackConnection() {},
  onConnectionRemoved() {},
  send: (id, message) => {
    server.sendTo(id, message);
  },
});
await server.start();
process.stdout.write(`${JSON.stringify({ port: server.port, sessionId })}\n`);
for await (const line of createInterface({ input: process.stdin })) {
  if (line === 'stats') process.stdout.write(`${JSON.stringify({ inputs, outputBytes })}\n`);
  if (line === 'stop') break;
}
await server.stop();
await registry.shutdown();
// The owned profile and logs are deliberately retained for review; no user state is read.
