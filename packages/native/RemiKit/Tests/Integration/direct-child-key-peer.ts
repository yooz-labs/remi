/** Owned wire peers for #1724. Both use generated identities and loopback-only sockets. */
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from 'node:crypto';
import { renameSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const mode = process.argv[2];
const statsPath = process.argv[3];
if (
  ![
    'matching',
    'wrong',
    'held',
    'legacy',
    'rootheld',
    'rootheld-wrong',
    'manual-reconnect',
    'recovery',
    'recovery-wrong',
  ].includes(mode) ||
  !statsPath
)
  throw new Error('owned test arguments required');
const raw = (key: ReturnType<typeof generateKeyPairSync>['publicKey']) =>
  key.export({ type: 'spki', format: 'der' }).subarray(-32);
let parent = generateKeyPairSync('ed25519');
while (
  !raw(parent.publicKey).toString('base64').includes('+') ||
  !raw(parent.publicKey).toString('base64').includes('/')
) {
  parent = generateKeyPairSync('ed25519');
}
const child =
  mode.endsWith('wrong') || mode === 'manual-reconnect' ? generateKeyPairSync('ed25519') : parent;
const otherParent = generateKeyPairSync('ed25519');
const digest = (key: typeof parent.publicKey) =>
  createHash('sha256').update(raw(key)).digest('hex');
const frame = (type: string, fields = {}) =>
  JSON.stringify({ type, id: crypto.randomUUID(), timestamp: new Date().toISOString(), ...fields });
const fixtureDir = new URL('../../../../shared/tests/fixtures/protocol/', import.meta.url);
const hello = await Bun.file(new URL('hello_ack_legacy.json', fixtureDir)).json();
const sessionList = await Bun.file(new URL('session_list_response.json', fixtureDir)).json();
const stats = {
  rootAuth: 0,
  childOpens: 0,
  childAuth: 0,
  childPairing: 0,
  childHello: 0,
  child2Auth: 0,
  rootHelloHeld: 0,
  rootOpens: 0,
  rootLegacyHello: 0,
  rootHello: 0,
  rootWrongChallenges: 0,
  rootWrongHeld: 0,
  childUserInput: 0,
};
const publish = () => {
  writeFileSync(`${statsPath}.tmp`, JSON.stringify(stats));
  renameSync(`${statsPath}.tmp`, statsPath);
};
publish();
const heldChallenges: Array<() => void> = [];
const heldRootHellos: Array<() => void> = [];
const rootClosers = new Set<() => void>();
let reconnectLegacy = false;
let reconnectWrong = false;
type State = {
  role: 'root' | 'root2' | 'child' | 'child2';
  challenge: Buffer;
  admitted: boolean;
  key: typeof parent;
};
function listener(role: State['role']) {
  const defaultKey =
    role === 'root' ? parent : role === 'root2' || role === 'child2' ? otherParent : child;
  return Bun.serve<State>({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, server) {
      return server.upgrade(request, {
        data: {
          role,
          challenge: randomBytes(32),
          admitted: false,
          key: role === 'root' && reconnectWrong ? otherParent : defaultKey,
        },
      })
        ? undefined
        : new Response('upgrade required', { status: 400 });
    },
    websocket: {
      open(ws) {
        const key = ws.data.key;
        if (role === 'root') {
          stats.rootOpens++;
          rootClosers.add(() => ws.close());
          publish();
        }
        if (role === 'child') {
          stats.childOpens++;
          publish();
        }
        if (role === 'root' && (mode === 'legacy' || reconnectLegacy)) {
          ws.data.admitted = true;
          return;
        }
        const challenge = () =>
          ws.send(
            frame('auth_challenge', {
              challenge: ws.data.challenge.toString('base64'),
              serverPublicKey: raw(key.publicKey).toString('base64'),
              serverFingerprint: digest(key.publicKey).slice(0, 16),
            }),
          );
        if (role === 'root' && reconnectWrong) {
          stats.rootWrongHeld++;
          publish();
          heldChallenges.push(() => {
            stats.rootWrongChallenges++;
            publish();
            challenge();
          });
        } else if (role === 'child' && mode === 'held') heldChallenges.push(challenge);
        else challenge();
      },
      message(ws, bytes) {
        const key = ws.data.key;
        const message = JSON.parse(String(bytes));
        if (message.type === 'auth_response') {
          if (role === 'root' || role === 'root2') stats.rootAuth++;
          else if (role === 'child2') stats.child2Auth++;
          else {
            stats.childAuth++;
            if (message.pairingNonce != null || message.pairingLabel != null) stats.childPairing++;
          }
          publish();
          const clientRaw = Buffer.from(message.clientPublicKey, 'base64');
          const prefix = Buffer.from('302a300506032b6570032100', 'hex');
          const clientKey = createPublicKey({
            key: Buffer.concat([prefix, clientRaw]),
            format: 'der',
            type: 'spki',
          });
          if (
            !verify(null, ws.data.challenge, clientKey, Buffer.from(message.signature, 'base64'))
          ) {
            ws.close();
            return;
          }
          ws.data.admitted = true;
          ws.send(
            frame('auth_result', {
              success: true,
              serverSignature: sign(null, ws.data.challenge, key.privateKey).toString('base64'),
            }),
          );
        } else if (message.type === 'hello' && ws.data.admitted) {
          if (role === 'root') {
            stats.rootHello++;
            publish();
          }
          if (role === 'root' && reconnectLegacy) {
            stats.rootLegacyHello++;
            publish();
          }
          if (role === 'child') {
            stats.childHello++;
            publish();
          }
          if (
            role === 'root' &&
            (mode.startsWith('rootheld') || (mode === 'manual-reconnect' && reconnectLegacy))
          ) {
            stats.rootHelloHeld++;
            publish();
            heldRootHellos.push(() => ws.send(JSON.stringify(hello)));
          } else
            ws.send(
              JSON.stringify(
                role === 'root' && mode.startsWith('recovery')
                  ? { ...hello, sessionId: null }
                  : hello,
              ),
            );
        } else if (message.type === 'user_input' && role === 'child' && ws.data.admitted) {
          stats.childUserInput++;
          publish();
        } else if (message.type === 'session_list_request' && ws.data.admitted) {
          ws.send(
            JSON.stringify({
              ...sessionList,
              requestId: message.id,
              sessions: role === 'child' ? sessionList.sessions : [],
              daemonPorts: [],
            }),
          );
        }
      },
    },
  });
}
const root = listener('root');
const root2 = listener('root2');
const childServer = listener('child');
const child2Server = listener('child2');
const reserved = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('owned') });
const closedPort = reserved.port;
reserved.stop(true);
const deadline = setTimeout(() => process.exit(1), 30_000);
process.stdout.write(
  `${JSON.stringify({
    rootPort: root.port,
    root2Port: root2.port,
    childPort: childServer.port,
    child2Port: child2Server.port,
    closedPort,
    publicKey: raw(parent.publicKey).toString('base64'),
    machineID: digest(parent.publicKey).slice(0, 32),
    otherPublicKey: raw(otherParent.publicKey).toString('base64'),
    otherMachineID: digest(otherParent.publicKey).slice(0, 32),
  })}\n`,
);
try {
  for await (const line of createInterface({ input: process.stdin })) {
    if (line === 'release') for (const challenge of heldChallenges.splice(0)) challenge();
    if (line === 'release-root') for (const hello of heldRootHellos.splice(0)) hello();
    if (line === 'switch-legacy' || line === 'switch-valid' || line === 'switch-wrong') {
      reconnectLegacy = line === 'switch-legacy';
      reconnectWrong = line === 'switch-wrong';
      for (const close of rootClosers) close();
      rootClosers.clear();
    }
  }
} finally {
  clearTimeout(deadline);
  root.stop(true);
  root2.stop(true);
  childServer.stop(true);
  child2Server.stop(true);
}
