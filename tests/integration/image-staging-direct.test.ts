/** Actual source hub -> signed child -> shipping web transport/controller. No model turns or owner state. */
import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { IdentityStore } from '../../packages/daemon/src/auth/identity-store.ts';
import { Reservations } from '../../packages/daemon/src/tunnel/reservations.ts';
import { installFakeAgents } from '../../packages/daemon/tests/helpers/fake-agent-clis.ts';
import {
  makeIsolatedDirs,
  pollUntil,
} from '../../packages/daemon/tests/integration/hub-test-utils.ts';
import { reserveRange } from '../../packages/daemon/tests/session/port-test-helpers.ts';
import {
  createAuthResponse,
  createCreateSessionRequest,
  createHello,
  createIdentity,
  createResumeSessionRequest,
  createSessionListRequest,
  fromBase64,
  importPublicKey,
  sign,
  unlockIdentity,
  verify,
} from '../../packages/shared/src/index.ts';
import type { HelloAckMessage, ProtocolMessage } from '../../packages/shared/src/protocol.ts';
import { ImageUploadController } from '../../packages/web/src/lib/image-upload.ts';
import { WebSocketClient } from '../../packages/web/src/lib/websocket-client.ts';

const compiledEntry = process.env['REMI_IMAGE_STAGING_TEST_ENTRY'];
const entry = compiledEntry ?? path.resolve(import.meta.dir, '../../packages/daemon/src/entry.ts');
const entryCommand = compiledEntry ? [entry] : [process.execPath, '--no-env-file', entry];
const fixtures = path.resolve(
  import.meta.dir,
  '../../packages/shared/tests/fixtures/image-staging',
);

test('real hub child advertises staging only for the signed attached web caller', async () => {
  const dirs = makeIsolatedDirs();
  const state = path.join(dirs.home, '.remi');
  fs.mkdirSync(state, { mode: 0o700 });
  const store = new IdentityStore(state);
  const machine = await store.generate();
  const phone = await createIdentity();
  const unlocked = await unlockIdentity(phone);
  await store.addAuthorizedKey(phone.publicKey, 'owned web acceptance');
  const agents = installFakeAgents(dirs.home, { claude: true });
  const port = await reserveRange(20, 50, '127.0.0.1');
  const proc = Bun.spawn(
    [
      ...entryCommand,
      'serve',
      '--port',
      String(port),
      '--auth',
      '--no-relay',
      '--no-mdns',
      '--no-telegram',
    ],
    {
      cwd: dirs.work,
      env: {
        ...agents.env,
        HOME: dirs.home,
        REMI_HOME: state,
        TMPDIR: process.env['TMPDIR'],
        LANG: 'en_US.UTF-8',
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const output = new Response(proc.stdout).text();
  const errors = new Response(proc.stderr).text();
  const clients: WebSocketClient[] = [];
  let controller: ImageUploadController | undefined;
  let childPid: number | undefined;
  try {
    await pollUntil(
      () => fs.existsSync(path.join(state, 'daemon-status.json')) || proc.exitCode !== null,
      10000,
      'owned hub ready',
    );
    if (proc.exitCode !== null) throw new Error(`Owned hub failed: ${await errors}`);
    async function connect(targetPort: number, query = false) {
      const received: ProtocolMessage[] = [];
      let ack: HelloAckMessage | undefined;
      let challenge: string | undefined;
      let failed: Error | undefined;
      const client = new WebSocketClient(
        { url: `ws://127.0.0.1:${targetPort}/ws`, autoReconnect: false },
        {
          onMessage(message) {
            received.push(message);
            void (async () => {
              if (message.type === 'auth_challenge') {
                if (message.serverPublicKey !== machine.publicKey)
                  throw new Error('Unexpected owned machine identity');
                challenge = message.challenge;
                const signature = await sign(unlocked.privateKey, fromBase64(challenge));
                client.send(createAuthResponse(phone.publicKey, signature, phone.fingerprint));
              } else if (message.type === 'auth_result') {
                if (!message.success || !message.serverSignature || !challenge)
                  throw new Error('Owned client authentication failed');
                const key = await importPublicKey(fromBase64(machine.publicKey));
                if (!(await verify(key, fromBase64(challenge), message.serverSignature)))
                  throw new Error('Owned machine proof failed');
                client.setConnected();
                client.send(
                  createHello(
                    crypto.randomUUID(),
                    'owned staging acceptance',
                    query ? { mode: 'query' } : {},
                  ),
                );
              } else if (message.type === 'hello_ack') {
                ack = message;
              }
            })().catch((error) => {
              failed = error instanceof Error ? error : new Error('Owned auth failed');
            });
          },
          onImageStagingMessage(message) {
            controller?.receive(message);
          },
          onError(error) {
            failed = error;
          },
        },
      );
      clients.push(client);
      client.connect();
      await pollUntil(() => Boolean(ack || failed), 10000, 'owned signed hello');
      if (failed) throw failed;
      if (!ack) throw new Error('Missing actual hello');
      return { client, received, ack };
    }
    const hub = await connect(port);
    expect(hub.ack.sessionId).toBeNull();
    expect(hub.ack.capabilities).not.toContain('image_staging');
    const create = createCreateSessionRequest(dirs.work, { harness: 'claude' });
    hub.client.send(create);
    await pollUntil(
      () =>
        hub.received.some(
          (message) =>
            message.type === 'create_session_response' && message.requestId === create.id,
        ),
      20000,
      'owned hub child start',
    );
    const response = hub.received.find(
      (message) => message.type === 'create_session_response' && message.requestId === create.id,
    );
    if (
      response?.type !== 'create_session_response' ||
      !response.success ||
      !response.port ||
      !response.sessionId
    )
      throw new Error('Actual child start failed');
    const records = fs
      .readdirSync(path.join(state, 'live-sessions'))
      .map((name) => JSON.parse(fs.readFileSync(path.join(state, 'live-sessions', name), 'utf8')));
    const record = records.find((item) => item.sessionId === response.sessionId);
    if (!record || !Number.isInteger(record.pid) || record.pid <= 1 || record.pid === proc.pid)
      throw new Error('Invalid owned child pid');
    childPid = record.pid;
    const list = createSessionListRequest();
    hub.client.send(list);
    await pollUntil(
      () =>
        hub.received.some(
          (message) => message.type === 'session_list_response' && message.requestId === list.id,
        ),
      10000,
      'hub child discovery',
    );
    const discovered = hub.received.find(
      (message) => message.type === 'session_list_response' && message.requestId === list.id,
    );
    expect(discovered?.type).toBe('session_list_response');
    if (discovered?.type === 'session_list_response')
      expect(discovered.daemonPorts?.includes(response.port)).toBe(true);
    const query = await connect(response.port, true);
    expect(query.ack.capabilities).not.toContain('image_staging');
    const child = await connect(response.port);
    expect(child.ack.sessionId).toBe(response.sessionId);
    expect(child.ack.attachState).toBe('attached');
    expect(child.ack.harness).toBe('claude');
    expect(child.ack.capabilities).toContain('image_staging');
    expect(child.ack.harnessSessionId).toBeTruthy();
    const resume = createResumeSessionRequest(response.sessionId);
    query.client.send(resume);
    await pollUntil(
      () =>
        query.received.some(
          (message) =>
            message.type === 'resume_session_response' && message.requestId === resume.id,
        ),
      10000,
      'owned direct reattachment',
    );
    const resumed = query.received
      .filter((message): message is HelloAckMessage => message.type === 'hello_ack')
      .at(-1);
    expect(resumed?.attachState).toBe('attached');
    expect(resumed?.harnessSessionId).toBe(child.ack.harnessSessionId);
    expect(resumed?.claudeSessionId).toBe(child.ack.claudeSessionId);
    expect(resumed?.capabilities).toContain('image_staging');

    const phases: string[] = [];
    controller = new ImageUploadController(
      {
        send: (request) => child.client.sendImageStaging(request),
        context: () => {
          const generation = child.client.imageUploadGeneration;
          if (!generation || !child.ack.sessionId || !child.ack.harnessSessionId) return null;
          return {
            transport: 'direct',
            connection: child.client,
            generation,
            sessionId: child.ack.sessionId,
            binding: { harness: 'claude', harnessSessionId: child.ack.harnessSessionId },
            capabilities: child.ack.capabilities ?? [],
          };
        },
      },
      (value) => {
        phases.push(value.phase);
      },
    );
    for (const [filename, type] of [
      ['fixture.png', 'image/png'],
      ['fixture.jpg', 'image/jpeg'],
    ] as const) {
      const bytes = fs.readFileSync(path.join(fixtures, filename));
      await controller.upload(new File([bytes], filename, { type }));
      expect(phases.at(-1)).toBe('staged');
    }
    expect(
      new Reservations(path.join(state, 'image-staging', 'ledger'))
        .inspect()
        .filter((row) => row.state === 'staged'),
    ).toHaveLength(2);
    expect(phases).toContain('uploading');
    expect(phases).toContain('checking');
    // Upload completion stages storage; the inert harness still has its untouched empty transcript.
    const transcript = child.ack.transcriptPath;
    expect(transcript).toBeTruthy();
    if (transcript) expect(fs.statSync(transcript).size).toBe(0);
  } finally {
    controller?.dispose();
    for (const client of clients) client.disconnect();
    fs.writeFileSync(path.join(agents.claudeDir, 'release'), '');
    if (childPid) {
      try {
        process.kill(childPid, 'SIGTERM');
      } catch {
        /* Already exited. */
      }
      await pollUntil(
        () => {
          try {
            process.kill(childPid as number, 0);
            return false;
          } catch {
            return true;
          }
        },
        10000,
        'owned child exit',
      );
    }
    if (proc.exitCode === null) proc.kill('SIGTERM');
    await proc.exited;
    await Promise.all([output, errors]);
    const diagnostics = path.join(state, 'daemon.log');
    if (fs.existsSync(diagnostics))
      console.error('Owned daemon diagnostics:', fs.readFileSync(diagnostics, 'utf8'));
    fs.rmSync(dirs.work, { recursive: true, force: true });
    fs.rmSync(dirs.home, { recursive: true, force: true });
  }
}, 60000);
