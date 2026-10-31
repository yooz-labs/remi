/** Owned WSS source adapter, actual image staging service and an inert cat PTY. */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createHelloAck, generateId } from '@remi/shared';
import { WebSocketAdapter } from '../../../../daemon/src/adapters/websocket-adapter';
import { MessageAPI } from '../../../../daemon/src/api/message-api';
import { Authenticator } from '../../../../daemon/src/auth/authenticator';
import { IdentityStore } from '../../../../daemon/src/auth/identity-store';
import { createImageInsertionHandlers } from '../../../../daemon/src/cli/handlers/image-insertion-events';
import { PTYSession } from '../../../../daemon/src/pty/pty-session';
import { SessionBindingStore } from '../../../../daemon/src/session/session-binding-store';
import { SessionRegistry } from '../../../../daemon/src/session/session-registry';
import { SessionStore } from '../../../../daemon/src/session/session-store';
import { ImageInsertionCoordinator } from '../../../../daemon/src/tunnel/image-insertion-coordinator';
import { ImageStagingService } from '../../../../daemon/src/tunnel/image-staging-service';

const clientKey = process.argv[2];
if (!clientKey) throw new Error('owned client public key required');
console.log = (...args) => console.error(...args);
const home = mkdtempSync(join(realpathSync(tmpdir()), 'remi-image-source-'));
const auth = new IdentityStore(join(home, 'auth'));
await auth.generate();
await auth.addAuthorizedKey(clientKey, 'owned-image-test');
const identity = await auth.unlock();
const sessionId = generateId();
const bindingId = generateId();
const configPath = join(home, 'openssl.cnf');
const keyPath = join(home, 'tls-key.pem');
const certPath = join(home, 'tls-cert.pem');
writeFileSync(
  configPath,
  '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=owned-image-staging\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyCertSign\nextendedKeyUsage=serverAuth\n',
  { mode: 0o600 },
);
execFileSync(
  '/usr/bin/openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-config',
    configPath,
  ],
  { stdio: 'ignore' },
);
chmodSync(keyPath, 0o600);
const port = await new Promise<number>((resolve, reject) => {
  const probe = createServer();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const address = probe.address();
    if (!address || typeof address === 'string') return reject(new Error('owned port unavailable'));
    probe.close((error) => (error ? reject(error) : resolve(address.port)));
  });
});
const registry = new SessionRegistry();
const bindings = new SessionBindingStore(new SessionStore(join(home, 'sessions.json')));
let output = '';
const pty = new PTYSession(
  { command: '/bin/cat', cwd: home, size: { cols: 500, rows: 40 } },
  {
    onData(data) {
      output = (output + data).slice(0, 4096);
    },
  },
);
await pty.start();
registry.registerSession(sessionId, home, pty, new MessageAPI({ sessionId }), true);
bindings.preAssign({
  remiSessionId: sessionId,
  claudeSessionId: bindingId,
  projectPath: home,
  port,
  pid: process.pid,
  startedAt: new Date().toISOString(),
  exitedAt: null,
  exitCode: null,
});
let begins = 0;
let chunks = 0;
let completes = 0;
let staged = 0;
let insertions = 0;
let dropInsertionResult = false;
let droppedInsertionResults = 0;
const adapter = new WebSocketAdapter(
  {
    host: '127.0.0.1',
    port,
    authenticator: new Authenticator({ identity, identityStore: auth }),
    tls: { key: readFileSync(keyPath, 'utf8'), cert: readFileSync(certPath, 'utf8') },
  },
  {
    onConnect(id) {
      if (!registry.attachConnection(sessionId, id).success)
        throw new Error('owned attachment failed');
      adapter.sendRaw(
        id,
        createHelloAck('owned-image-test', sessionId, {
          capabilities: ['image_staging', 'image_insertion'],
          binding: {
            identity: { harness: 'claude', harnessSessionId: bindingId },
            transcriptPath: null,
          },
        }),
      );
    },
    onDisconnect(id) {
      registry.detachConnection(id);
      void service?.invalidateConnection(id);
      coordinator?.invalidateConnection(id);
    },
    async onImageUpload(id, ingress) {
      if (!service) throw new Error('owned staging unavailable');
      if (ingress.kind === 'request') {
        if (ingress.request.type === 'image_upload_begin') begins++;
        if (ingress.request.type === 'image_upload_chunk') chunks++;
        if (ingress.request.type === 'image_upload_complete') completes++;
        await service.handle(id, ingress.request, (message) => {
          if (message.type === 'image_upload_result' && message.outcome === 'staged') staged++;
          adapter.sendRaw(id, message);
        });
      } else {
        service.refuseMalformed(id, ingress.correlation, (message) => adapter.sendRaw(id, message));
      }
    },
    async onImageInsert(id, ingress) {
      insertions++;
      await insertionHandlers.onImageInsert(id, ingress);
    },
  },
);
const service = await ImageStagingService.open({
  home,
  identityStore: auth,
  sessionRegistry: registry,
  bindingStore: bindings,
  directAdapter: () => adapter,
});
const coordinator = new ImageInsertionCoordinator(service, () => false);
const insertionHandlers = createImageInsertionHandlers({
  service: () => service,
  coordinator: () => coordinator,
  send: (id, response) => {
    if (dropInsertionResult) {
      dropInsertionResult = false;
      droppedInsertionResults++;
    } else adapter.sendRaw(id, response);
  },
});
await adapter.start();
process.stdout.write(
  `${JSON.stringify({ port, sessionId, bindingId, publicKey: identity.publicKeyRaw, certPath })}\n`,
);
for await (const line of createInterface({ input: process.stdin })) {
  if (line === 'rotate-binding') {
    bindings.update(sessionId, generateId());
    process.stdout.write(`${JSON.stringify({ rotated: true })}\n`);
  }
  if (line === 'drop-insertion-result') {
    dropInsertionResult = true;
    process.stdout.write(`${JSON.stringify({ dropArmed: true })}\n`);
  }
  if (line === 'stats')
    process.stdout.write(
      `${JSON.stringify({
        begins,
        chunks,
        completes,
        staged,
        insertions,
        droppedInsertionResults,
        outputBytes: Buffer.byteLength(output),
        containsNewline: /[\r\n]/u.test(output),
        referenceOnly: /^ @"[^"\r\n]+" $/u.test(output),
      })}\n`,
    );
  if (line === 'stop') break;
}
coordinator.close();
const clean = await service.close();
await adapter.stop();
await pty.close();
if (!clean) throw new Error('owned staging cleanup incomplete');
