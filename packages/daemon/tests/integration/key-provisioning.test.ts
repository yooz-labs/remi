/**
 * Provisioning a client key on a machine, end to end (#1303), with no stand-ins: real hubs from
 * source with authentication on, the real `remi authorize` and `remi keys` commands over each
 * hub's own identity store, and a real WebSocket client with a real Ed25519 key answering the
 * challenge. Every key is made in the test; nothing real is read.
 *
 * What these pin is the contract a native app builds against (`docs/PROVISIONING.md`):
 * the three ways a client key reaches a machine's authorized keys (approve a pending key, import
 * its public-only JSON before it ever connects, pair by QR) end in the same record, the label
 * names the client, a revoked or rotated key needs approval again, and the grant is the machine's
 * (its hub and every session daemon the hub starts), not a connection's.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createAuthResponse,
  createCreateSessionRequest,
  createHello,
  createIdentity,
  createSessionListRequest,
  deserialize,
  fromBase64,
  serialize,
  sign,
  unlockIdentity,
} from '@remi/shared';
import type {
  AuthChallengeMessage,
  AuthResultMessage,
  CreateSessionResponseMessage,
  HelloAckMessage,
  ProtocolMessage,
  UnlockedIdentity,
} from '@remi/shared';
import { IdentityStore } from '../../src/auth/identity-store.ts';
import { DEFAULT_CONFIG } from '../../src/config/config.ts';
import { collect, installFakeAgents } from '../helpers/fake-agent-clis.ts';
import { reserveRange } from '../session/port-test-helpers.ts';

const CLI = path.resolve(import.meta.dir, '../../src/cli.ts');
const BIND = DEFAULT_CONFIG.daemon.bind;

interface Host {
  readonly dir: string;
  /** The machine's remi state directory: what `remi authorize` writes and every daemon reads. */
  readonly home: string;
  readonly env: Record<string, string>;
  hub?: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
  port?: number;
  readonly log: { text: string };
}

const hosts: Host[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  for (const host of hosts.splice(0)) {
    // A hub's children are detached: end them (and their fake agents) before the sandbox goes.
    const liveDir = path.join(host.home, 'live-sessions');
    if (fs.existsSync(liveDir)) {
      for (const file of fs.readdirSync(liveDir)) {
        try {
          const entry = JSON.parse(fs.readFileSync(path.join(liveDir, file), 'utf-8')) as {
            pid: number;
          };
          process.kill(entry.pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }
    if (host.hub !== undefined && host.hub.exitCode === null) {
      host.hub.kill('SIGTERM');
      await host.hub.exited;
    }
    fs.rmSync(host.dir, { recursive: true, force: true });
  }
});

async function wait(check: () => boolean, what: string, ms = 15000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

/** A machine: its own home, with no real agent on its PATH (a launch would exit 88). */
function makeHost(extraEnv: Record<string, string> = {}): Host {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-provision-'));
  fs.mkdirSync(path.join(dir, 'bin'));
  for (const agent of ['claude', 'codex'])
    fs.writeFileSync(path.join(dir, 'bin', agent), '#!/bin/sh\nexit 88\n', { mode: 0o700 });
  // `remi` as a script would find it on PATH: the CLI under test, run by the runtime under test.
  fs.writeFileSync(
    path.join(dir, 'bin', 'remi'),
    `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`,
    { mode: 0o700 },
  );
  const home = path.join(dir, '.remi');
  const host: Host = {
    dir,
    home,
    env: {
      HOME: dir,
      REMI_HOME: home,
      PATH: `${path.join(dir, 'bin')}:/usr/bin:/bin`,
      NODE_ENV: 'test',
      ...extraEnv,
    },
    log: { text: '' },
  };
  hosts.push(host);
  return host;
}

/** A real `remi <args>` process on the host, as a person or a bootstrap script would run it. */
async function remi(host: Host, args: string[]) {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    env: host.env,
    cwd: host.dir,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

/**
 * Start the host's hub (`remi serve`) with authentication on, and wait until it says how it is
 * bound. `children` reserves the run of ports the hub's session daemons take.
 */
async function startHub(host: Host, children = false): Promise<number> {
  const port = await reserveRange(children ? 20 : 1, 50, BIND);
  const proc = Bun.spawn(
    [
      process.execPath,
      CLI,
      'serve',
      '--port',
      String(port),
      '--no-mdns',
      '--no-relay',
      '--no-telegram',
    ],
    {
      env: children ? { ...host.env, REMI_PORT: String(port) } : host.env,
      cwd: host.dir,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  host.hub = proc;
  host.port = port;
  collect(proc.stdout, host.log);
  collect(proc.stderr, host.log);
  const statusFile = path.join(host.home, 'daemon-status.json');
  await wait(() => {
    if (proc.exitCode !== null) throw new Error(`the hub exited early:\n${host.log.text}`);
    try {
      return JSON.parse(fs.readFileSync(statusFile, 'utf-8')).bind !== undefined;
    } catch {
      return false;
    }
  }, 'the hub');
  return port;
}

interface Client {
  readonly identity: UnlockedIdentity;
  readonly fingerprint: string;
  /** What a device exports to be provisioned: the public key and nothing else. */
  readonly publicJson: string;
  readonly publicKey: string;
}

/** A device's identity, made in the test; only its public half ever leaves this function's result. */
async function newClient(): Promise<Client> {
  const made = await createIdentity();
  return {
    identity: await unlockIdentity(made),
    fingerprint: made.fingerprint,
    publicKey: made.publicKey,
    publicJson: JSON.stringify({ publicKey: made.publicKey }),
  };
}

interface Attempt {
  readonly ws: WebSocket;
  readonly messages: ProtocolMessage[];
  readonly challenge: AuthChallengeMessage;
  readonly result: AuthResultMessage;
}

/**
 * One fresh authentication: connect, answer the challenge as `who`, and wait for the verdict. On
 * success the hello follows, and the attempt is returned once the ack arrives.
 */
async function authenticate(
  port: number,
  who: UnlockedIdentity,
  claimedFingerprint: string = who.fingerprint,
): Promise<Attempt> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  sockets.push(ws);
  const messages: ProtocolMessage[] = [];
  ws.addEventListener('message', async (event) => {
    const message = deserialize(String(event.data));
    if (!message) return;
    messages.push(message);
    if (message.type === 'auth_challenge') {
      ws.send(
        serialize(
          createAuthResponse(
            who.publicKeyRaw,
            await sign(who.privateKey, fromBase64(message.challenge)),
            claimedFingerprint,
          ),
        ),
      );
    }
    if (message.type === 'auth_result' && message.success)
      ws.send(serialize(createHello('provisioning-test', '1.0.0')));
  });
  const verdict = (): AuthResultMessage | undefined =>
    messages.find((m): m is AuthResultMessage => m.type === 'auth_result');
  await wait(() => verdict() !== undefined, 'the auth_result');
  const result = verdict() as AuthResultMessage;
  if (result.success) await wait(() => messages.some((m) => m.type === 'hello_ack'), 'hello_ack');
  const challenge = messages.find(
    (m): m is AuthChallengeMessage => m.type === 'auth_challenge',
  ) as AuthChallengeMessage;
  return { ws, messages, challenge, result };
}

const refused = (code: string) => ({ success: false, error: code });

describe('provisioning a client key (#1303)', () => {
  test('a key imported from its public-only JSON before the hub first starts connects and was never pending', async () => {
    const host = makeHost();
    const client = await newClient();
    // The bootstrap step: the machine has no hub yet, and no identity of its own.
    const authorize = await remi(host, ['authorize', client.publicJson, '--label', 'Test iPhone']);
    expect(authorize.code).toBe(0);
    expect(authorize.stdout).toContain(client.fingerprint);
    expect(fs.existsSync(path.join(host.home, 'identity.json'))).toBe(false);

    const port = await startHub(host);
    const attempt = await authenticate(port, client.identity);
    expect(attempt.result.success).toBe(true);
    expect(attempt.messages.some((m) => m.type === 'hello_ack')).toBe(true);

    const store = new IdentityStore(host.home);
    // The grant survived the hub making its own identity, and the hub signed with that identity.
    expect(store.listAuthorizedKeys()).toMatchObject([
      { fingerprint: client.fingerprint, publicKey: client.publicKey, label: 'Test iPhone' },
    ]);
    expect(attempt.challenge.serverFingerprint).toBe(store.load()?.fingerprint as string);
    // A key that was authorized first is never a candidate.
    expect(store.listPendingKeys()).toHaveLength(0);
    expect(fs.existsSync(path.join(host.home, 'pending_keys.json'))).toBe(false);

    // A bootstrap script run twice: the second run says so, exits 1, and leaves one record.
    const again = await remi(host, ['authorize', client.publicJson, '--label', 'Test iPhone']);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('already authorized');
    expect(store.listAuthorizedKeys()).toHaveLength(1);
  }, 60000);

  test('only the public key in the JSON counts; a fingerprint field cannot name another key', async () => {
    const host = makeHost();
    const client = await newClient();
    // The web client exports `{publicKey, fingerprint}`; the fingerprint is display only.
    const withClaim = JSON.stringify({
      publicKey: client.publicKey,
      fingerprint: 'ffffffffffffffff',
    });
    const authorize = await remi(host, ['authorize', withClaim, '--label', 'Test iPad']);
    expect(authorize.code).toBe(0);
    const [stored] = new IdentityStore(host.home).listAuthorizedKeys();
    expect(stored?.fingerprint).toBe(client.fingerprint);
    expect(stored?.fingerprint).not.toBe('ffffffffffffffff');
    // A JSON file works the way inline JSON does, as a cloud-init `write_files` entry would leave it.
    const other = await newClient();
    const file = path.join(host.dir, 'device.json');
    fs.writeFileSync(file, other.publicJson);
    expect((await remi(host, ['authorize', file, '--label', 'Test Mac'])).code).toBe(0);
    expect(
      new IdentityStore(host.home)
        .listAuthorizedKeys()
        .map((k) => k.fingerprint)
        .sort(),
    ).toEqual([client.fingerprint, other.fingerprint].sort());
  });

  test('an unknown key is pending, the exact command approves it, and the next fresh authentication succeeds', async () => {
    const host = makeHost();
    const port = await startHub(host);
    const client = await newClient();

    const first = await authenticate(port, client.identity);
    expect(first.result).toMatchObject(refused('UNKNOWN_KEY'));
    await wait(() => first.ws.readyState === WebSocket.CLOSED, 'the refused connection to close');

    // What `remi keys` shows the person, and what the app must tell them to run.
    const listed = await remi(host, ['keys']);
    expect(listed.stdout).toContain(`remi authorize ${client.fingerprint} --label device-name`);
    const store = new IdentityStore(host.home);
    const [pending] = store.listPendingKeys();
    expect(pending?.fingerprint).toBe(client.fingerprint);
    // The candidate lives ten minutes from the first attempt, and a retry does not extend it.
    expect(
      Date.parse(pending?.expiresAt as string) - Date.parse(pending?.firstSeenAt as string),
    ).toBe(600_000);

    const approved = await remi(host, [
      'authorize',
      client.fingerprint,
      '--label',
      "Test device's label",
    ]);
    expect(approved.code).toBe(0);
    const retry = await authenticate(port, client.identity);
    expect(retry.result.success).toBe(true);
    expect(store.listAuthorizedKeys()).toMatchObject([
      { fingerprint: client.fingerprint, label: "Test device's label" },
    ]);
    expect(store.listPendingKeys()).toHaveLength(0);
  }, 60000);

  test('a different private key with the same label stays unauthorized', async () => {
    const host = makeHost();
    const port = await startHub(host);
    const real = await newClient();
    const impostor = await newClient();
    expect((await remi(host, ['authorize', real.publicJson, '--label', 'Test iPhone'])).code).toBe(
      0,
    );

    // Another device that calls itself the same name is just another unknown key.
    const attempt = await authenticate(port, impostor.identity);
    expect(attempt.result).toMatchObject(refused('UNKNOWN_KEY'));
    // Claiming the real device's fingerprint with its own key is refused before anything is stored.
    const spoof = await authenticate(port, impostor.identity, real.fingerprint);
    expect(spoof.result).toMatchObject(refused('FINGERPRINT_MISMATCH'));

    const store = new IdentityStore(host.home);
    expect(store.listAuthorizedKeys().map((k) => k.fingerprint)).toEqual([real.fingerprint]);
    expect(store.listPendingKeys().map((k) => k.fingerprint)).toEqual([impostor.fingerprint]);
    expect((await authenticate(port, real.identity)).result.success).toBe(true);
  }, 60000);

  test('removing a key makes its next fresh authentication need approval again', async () => {
    const host = makeHost();
    const port = await startHub(host);
    const client = await newClient();
    // Provisioned while the hub runs: it reads the store at every authentication, no restart.
    expect(
      (await remi(host, ['authorize', client.publicJson, '--label', 'Test iPhone'])).code,
    ).toBe(0);
    const open = await authenticate(port, client.identity);
    expect(open.result.success).toBe(true);

    const removed = await remi(host, ['authorize', '--remove', client.fingerprint]);
    expect(removed.code).toBe(0);
    expect(removed.stdout).toContain(client.fingerprint);

    const fresh = await authenticate(port, client.identity);
    expect(fresh.result).toMatchObject(refused('UNKNOWN_KEY'));
    const store = new IdentityStore(host.home);
    expect(store.listAuthorizedKeys()).toHaveLength(0);
    // It can ask again: the revoked key is a candidate like any unknown one, not a banned one.
    expect(store.listPendingKeys().map((k) => k.fingerprint)).toEqual([client.fingerprint]);

    // The connection that was already open is not closed by the removal.
    const stillServed = open.messages.length;
    open.ws.send(serialize(createSessionListRequest(false)));
    await wait(() => open.messages.length > stillServed, 'a reply on the open connection');
    expect(open.messages.some((m) => m.type === 'session_list_response')).toBe(true);

    // Approving it again restores access; a removed key has no memory.
    expect(
      (await remi(host, ['authorize', client.fingerprint, '--label', 'Test iPhone'])).code,
    ).toBe(0);
    expect((await authenticate(port, client.identity)).result.success).toBe(true);
    expect((await remi(host, ['authorize', '--remove', '0000000000000000'])).code).toBe(1);
  }, 60000);

  test('a reset device is a new key: the old grant stays until it is removed', async () => {
    const host = makeHost();
    const port = await startHub(host);
    const before = await newClient();
    const after = await newClient();
    expect(
      (await remi(host, ['authorize', before.publicJson, '--label', 'Test iPhone'])).code,
    ).toBe(0);

    // The reset device presents a key the machine has never seen; the stale grant does not carry over.
    expect((await authenticate(port, after.identity)).result).toMatchObject(refused('UNKNOWN_KEY'));
    expect((await authenticate(port, before.identity)).result.success).toBe(true);

    expect(
      (await remi(host, ['authorize', after.fingerprint, '--label', 'Test iPhone'])).code,
    ).toBe(0);
    expect((await remi(host, ['authorize', '--remove', before.fingerprint])).code).toBe(0);
    expect((await authenticate(port, after.identity)).result.success).toBe(true);
    expect((await authenticate(port, before.identity)).result).toMatchObject(
      refused('UNKNOWN_KEY'),
    );
  }, 60000);

  test('one device identity connects to two independently provisioned machines', async () => {
    const first = makeHost();
    const second = makeHost();
    const portFirst = await startHub(first);
    const portSecond = await startHub(second);
    const client = await newClient();

    // The first machine was provisioned before the device ever connected; the second is approved.
    expect(
      (await remi(first, ['authorize', client.publicJson, '--label', 'Test iPhone'])).code,
    ).toBe(0);
    const onFirst = await authenticate(portFirst, client.identity);
    expect(onFirst.result.success).toBe(true);
    expect((await authenticate(portSecond, client.identity)).result).toMatchObject(
      refused('UNKNOWN_KEY'),
    );
    expect(
      (await remi(second, ['authorize', client.fingerprint, '--label', 'Test iPhone'])).code,
    ).toBe(0);
    const onSecond = await authenticate(portSecond, client.identity);
    expect(onSecond.result.success).toBe(true);

    // Two machines, two identities: the device can tell them apart by the key each one signs with.
    const firstMachine = new IdentityStore(first.home).load()?.fingerprint;
    const secondMachine = new IdentityStore(second.home).load()?.fingerprint;
    expect(onFirst.challenge.serverFingerprint).toBe(firstMachine as string);
    expect(onSecond.challenge.serverFingerprint).toBe(secondMachine as string);
    expect(firstMachine).not.toBe(secondMachine);

    // A grant is one machine's: removing it on the first leaves the second alone.
    expect((await remi(first, ['authorize', '--remove', client.fingerprint])).code).toBe(0);
    expect((await authenticate(portFirst, client.identity)).result).toMatchObject(
      refused('UNKNOWN_KEY'),
    );
    expect((await authenticate(portSecond, client.identity)).result.success).toBe(true);
  }, 90000);

  test('the provisioning script in the docs authorizes a directory of devices, twice, and says what failed', async () => {
    const doc = fs.readFileSync(
      path.resolve(import.meta.dir, '../../../../docs/PROVISIONING.md'),
      'utf-8',
    );
    const script = /```sh\n(#!\/bin\/sh\n# provision-devices\.sh[\s\S]*?)```/.exec(doc)?.[1];
    if (script === undefined)
      throw new Error('the provisioning script is not in docs/PROVISIONING.md');
    const host = makeHost();
    const phone = await newClient();
    const mac = await newClient();
    const devices = path.join(host.dir, 'devices');
    fs.mkdirSync(devices);
    fs.writeFileSync(path.join(devices, 'work-iphone.json'), phone.publicJson);
    fs.writeFileSync(path.join(devices, 'work-mac.json'), mac.publicJson);
    const scriptFile = path.join(host.dir, 'provision-devices.sh');
    fs.writeFileSync(scriptFile, script, { mode: 0o700 });
    const run = async () => {
      const proc = Bun.spawn(['sh', scriptFile, devices], {
        env: host.env,
        cwd: host.dir,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { stdout, stderr, code };
    };

    const first = await run();
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('authorized work-iphone');
    expect(first.stdout).toContain('authorized work-mac');
    // Run again by a bootstrap that restarts: nothing changes and nothing fails.
    const second = await run();
    expect(second.code).toBe(0);
    expect(second.stdout).toContain('already authorized: work-iphone');
    expect(
      new IdentityStore(host.home)
        .listAuthorizedKeys()
        .map((k) => [k.label, k.fingerprint])
        .sort(),
    ).toEqual(
      [
        ['work-iphone', phone.fingerprint],
        ['work-mac', mac.fingerprint],
      ].sort(),
    );
    // A file that is not a device key is named, fails the run, and does not stop the others.
    fs.writeFileSync(path.join(devices, 'broken.json'), 'not json');
    const later = await newClient();
    fs.writeFileSync(path.join(devices, 'zz-later.json'), later.publicJson);
    const third = await run();
    expect(third.code).toBe(1);
    expect(third.stderr).toContain('could not authorize broken');
    expect(third.stdout).toContain('authorized zz-later');

    // The grants made before the hub existed let the devices in.
    const port = await startHub(host);
    expect((await authenticate(port, phone.identity)).result.success).toBe(true);
    expect((await authenticate(port, later.identity)).result.success).toBe(true);
  }, 90000);

  test('the command an app shows, with the label single-quoted, stores the label as the person typed it', async () => {
    const host = makeHost();
    const client = await newClient();
    // The rule in the docs: wrap in single quotes, and write each ' in the label as '\''.
    const quote = (label: string) => `'${label.replaceAll("'", "'\\''")}'`;
    const label = `Work iPhone's "second" $HOME; echo gone`;
    // The key must be pending for the exact fingerprint to be approvable.
    await new IdentityStore(host.home).registerPendingKey(client.publicKey);
    const proc = Bun.spawn(
      ['sh', '-c', `remi authorize ${client.fingerprint} --label ${quote(label)}`],
      { env: host.env, cwd: host.dir, stdout: 'pipe', stderr: 'pipe' },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code, `${stdout}${stderr}`).toBe(0);
    expect(new IdentityStore(host.home).listAuthorizedKeys()).toMatchObject([
      { fingerprint: client.fingerprint, label },
    ]);
  });

  test("the session daemons a hub starts accept the machine's keys and share its approvals", async () => {
    const host = makeHost();
    const agents = installFakeAgents(host.dir, { claude: true });
    // The hub's children inherit this environment: the fake `claude` on PATH, and the same home.
    Object.assign(host.env, agents.env);
    const hubPort = await startHub(host, true);
    const granted = await newClient();
    const unknown = await newClient();
    expect(
      (await remi(host, ['authorize', granted.publicJson, '--label', 'Test iPhone'])).code,
    ).toBe(0);

    // Ask the hub (authenticated) for a session: it starts a daemon of its own on another port.
    const viaHub = await authenticate(hubPort, granted.identity);
    expect(viaHub.result.success).toBe(true);
    const request = createCreateSessionRequest(host.dir);
    viaHub.ws.send(serialize(request));
    const isResponse = (m: ProtocolMessage): m is CreateSessionResponseMessage =>
      m.type === 'create_session_response' && m.requestId === request.id;
    await wait(() => viaHub.messages.some(isResponse), 'the create_session_response', 30000);
    const created = viaHub.messages.find(isResponse) as CreateSessionResponseMessage;
    expect(created.success, `${created.error}\n${host.log.text}`).toBe(true);
    const childPort = created.port as number;
    expect(childPort).not.toBe(hubPort);

    // The child authenticates with the same grant, and signs with the machine's own identity.
    const onChild = await authenticate(childPort, granted.identity);
    expect(onChild.result.success).toBe(true);
    expect(onChild.challenge.serverFingerprint).toBe(viaHub.challenge.serverFingerprint);
    const ack = onChild.messages.find((m): m is HelloAckMessage => m.type === 'hello_ack');
    expect(ack?.sessionId).toBe(created.sessionId as string);

    // An unknown key is refused by the child, and becomes a candidate in the machine's one store.
    const refusedByChild = await authenticate(childPort, unknown.identity);
    expect(refusedByChild.result).toMatchObject(refused('UNKNOWN_KEY'));
    expect(new IdentityStore(host.home).listPendingKeys().map((k) => k.fingerprint)).toEqual([
      unknown.fingerprint,
    ]);
    expect((await remi(host, ['keys'])).stdout).toContain(
      `remi authorize ${unknown.fingerprint} --label device-name`,
    );

    // One approval on the machine admits the key at the child and at the hub.
    expect(
      (await remi(host, ['authorize', unknown.fingerprint, '--label', 'Test iPad'])).code,
    ).toBe(0);
    expect((await authenticate(childPort, unknown.identity)).result.success).toBe(true);
    expect((await authenticate(hubPort, unknown.identity)).result.success).toBe(true);

    // And one removal takes it away from both.
    expect((await remi(host, ['authorize', '--remove', unknown.fingerprint])).code).toBe(0);
    expect((await authenticate(childPort, unknown.identity)).result).toMatchObject(
      refused('UNKNOWN_KEY'),
    );
    expect((await authenticate(hubPort, unknown.identity)).result).toMatchObject(
      refused('UNKNOWN_KEY'),
    );
    fs.writeFileSync(path.join(agents.claudeDir, 'release'), '');
  }, 120000);
});
