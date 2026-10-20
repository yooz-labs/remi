/**
 * `remi pair` in a real terminal (#1275, #1281 review): the CLI from source in a pseudo-terminal, over
 * a real identity store. The hub's status file names this test's own process as the hub, bound to a
 * documentation address (192.0.2.10), so the command shows a code without a listener; the phone's
 * claim is the store call the authenticator makes once a signature verifies.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createIdentity, decodePairingLink } from '@remi/shared';
import { IdentityStore } from '../../src/auth/identity-store.ts';

const CLI = path.resolve(import.meta.dir, '../../src/cli.ts');
const dirs: string[] = [];
const procs: Bun.Subprocess[] = [];
afterEach(async () => {
  for (const proc of procs.splice(0)) {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    await proc.exited;
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function waitFor(check: () => boolean, what: string, ms = 15000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

async function setup(status: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-pair-tty-'));
  dirs.push(dir);
  const remiHome = path.join(dir, '.remi');
  const store = new IdentityStore(remiHome);
  await store.generate();
  fs.writeFileSync(
    path.join(remiHome, 'daemon-status.json'),
    JSON.stringify({
      pid: process.pid,
      mode: 'hub',
      wsPort: 18999,
      bind: '192.0.2.10',
      auth: true,
      ...status,
    }),
  );
  const env = { HOME: dir, REMI_HOME: remiHome, PATH: '/usr/bin:/bin', NODE_ENV: 'test' };
  return { dir, remiHome, store, env };
}

/** `remi pair` in a pseudo-terminal; `screen()` is everything it has drawn. */
function runInTerminal(env: Record<string, string>) {
  let output = '';
  const decoder = new TextDecoder();
  const proc = Bun.spawn([process.execPath, CLI, 'pair'], {
    env,
    terminal: {
      cols: 400,
      rows: 60,
      data(_terminal, chunk) {
        output += decoder.decode(chunk);
      },
    },
  });
  procs.push(proc);
  const nonce = () => {
    const link = output.match(/remi:\/\/pair#[A-Za-z0-9_-]+/)?.[0];
    if (link === undefined) throw new Error('no link shown');
    const decoded = decodePairingLink(link);
    if (!decoded.ok) throw new Error(`link refused: ${decoded.error}`);
    return decoded.code.nonce;
  };
  return {
    proc,
    screen: () => output,
    type: (text: string) => proc.terminal?.write(text),
    nonce,
  };
}

describe('remi pair in a terminal (#1275)', () => {
  test('without a terminal it refuses with exit 2 and shows no code', async () => {
    const { env } = await setup();
    const proc = Bun.spawn([process.execPath, CLI, 'pair'], {
      env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    procs.push(proc);
    expect(await proc.exited).toBe(2);
    expect(await new Response(proc.stdout).text()).not.toContain('remi://pair#');
    expect(await new Response(proc.stderr).text()).toContain(
      'remi pair needs an interactive terminal',
    );
  });

  test('--relay reaches relay pairing rather than direct QR pairing', async () => {
    const { env } = await setup();
    const proc = Bun.spawn([process.execPath, CLI, 'pair', '--relay'], {
      env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    procs.push(proc);
    expect(await proc.exited).toBe(1);
    expect(await new Response(proc.stderr).text()).toContain(
      'Run remi pair --relay in an interactive terminal to compare fingerprints and confirm.',
    );
    expect(await new Response(proc.stdout).text()).not.toContain('remi://pair#');
  });

  test('contradictory relay selectors are refused before either pairing flow', async () => {
    const { env } = await setup();
    const proc = Bun.spawn([process.execPath, CLI, 'pair', '--relay', '--no-relay'], {
      env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    procs.push(proc);
    expect(await proc.exited).toBe(1);
    expect(await new Response(proc.stderr).text()).toContain(
      'do not combine --relay and --no-relay',
    );
    expect(await new Response(proc.stdout).text()).not.toContain('remi://pair#');
  });

  test('an answer typed after the question approves the phone that claimed the code', async () => {
    const { env, store } = await setup();
    const t = runInTerminal(env);
    await waitFor(() => t.screen().includes('Waiting for the phone'), 'the code');
    const phone = await createIdentity();
    const nonce = t.nonce();
    expect(await store.claimPairing(nonce, phone.publicKey, 'Sam phone')).toBe('CLAIMED');
    await waitFor(() => t.screen().includes('Approve this device?'), 'the question');
    t.type(`${phone.fingerprint.slice(0, 4)}\r`);
    expect(await t.proc.exited).toBe(0);
    expect(store.isAuthorized(phone.publicKey, phone.fingerprint)).toBe(true);
    expect(store.listAuthorizedKeys()[0]?.label).toBe('Sam phone');
  }, 30000);

  for (const [name, enter] of [
    ['the approval typed while waiting, without Enter', ''],
    ['a whole approval line typed while waiting', '\r'],
  ] as const) {
    test(`${name} does not answer the question: Enter after it rejects`, async () => {
      const { env, store } = await setup();
      const t = runInTerminal(env);
      await waitFor(() => t.screen().includes('Waiting for the phone'), 'the code');
      // The phone shows its own fingerprint, so a person could type the approval ahead.
      const phone = await createIdentity();
      t.type(`${phone.fingerprint.slice(0, 4)}${enter}`);
      await Bun.sleep(100);
      const nonce = t.nonce();
      await store.claimPairing(nonce, phone.publicKey, 'x');
      await waitFor(() => t.screen().includes('Approve this device?'), 'the question');
      t.type('\r');
      expect(await t.proc.exited).toBe(1);
      expect(store.isAuthorized(phone.publicKey, phone.fingerprint)).toBe(false);
      expect(store.readPairing(nonce)?.state).toBe('rejected');
    }, 30000);
  }

  test('Ctrl-C while waiting cancels the code and exits 130', async () => {
    const { env, store } = await setup();
    const t = runInTerminal(env);
    await waitFor(() => t.screen().includes('Waiting for the phone'), 'the code');
    const nonce = t.nonce();
    t.type('\x03');
    expect(await t.proc.exited).toBe(130);
    expect(store.readPairing(nonce)?.state).toBe('cancelled');
  }, 30000);

  for (const [signal, code] of [
    ['SIGTERM', 143],
    ['SIGHUP', 129],
  ] as const) {
    test(`${signal} while waiting cancels the code and exits ${code}`, async () => {
      const { env, store } = await setup();
      const t = runInTerminal(env);
      await waitFor(() => t.screen().includes('Waiting for the phone'), 'the code');
      const nonce = t.nonce();
      t.proc.kill(signal);
      expect(await t.proc.exited).toBe(code);
      expect(store.readPairing(nonce)?.state).toBe('cancelled');
    }, 30000);
  }

  test('Ctrl-C at the question rejects the phone and exits 130', async () => {
    const { env, store } = await setup();
    const t = runInTerminal(env);
    await waitFor(() => t.screen().includes('Waiting for the phone'), 'the code');
    const phone = await createIdentity();
    const nonce = t.nonce();
    await store.claimPairing(nonce, phone.publicKey, 'x');
    await waitFor(() => t.screen().includes('Approve this device?'), 'the question');
    t.type('\x03');
    expect(await t.proc.exited).toBe(130);
    expect(store.readPairing(nonce)?.state).toBe('rejected');
    expect(store.listPendingKeys()).toHaveLength(0);
  }, 30000);

  test('Ctrl-C while the terminal is drained before the question still rejects, exit 130', async () => {
    const { env, store } = await setup();
    const t = runInTerminal(env);
    await waitFor(() => t.screen().includes('Waiting for the phone'), 'the code');
    const phone = await createIdentity();
    const nonce = t.nonce();
    await store.claimPairing(nonce, phone.publicKey, 'x');
    await waitFor(() => t.screen().includes('A device wants to pair'), 'the claim');
    t.type('\x03');
    expect(await t.proc.exited).toBe(130);
    expect(t.screen()).not.toContain('Approve this device?');
    expect(store.readPairing(nonce)?.state).toBe('rejected');
  }, 30000);

  test('a damaged pairings file is named, with what to do, and no stack trace', async () => {
    const { env, remiHome } = await setup();
    fs.writeFileSync(path.join(remiHome, 'pairings.json'), '{"version":1,"pairings":[7]}');
    const t = runInTerminal(env);
    expect(await t.proc.exited).toBe(1);
    expect(t.screen()).toContain('pairings.json');
    expect(t.screen()).toContain('To start over, delete');
    expect(t.screen()).not.toMatch(/\n\s+at /);
  }, 30000);

  test('the main help lists remi pair', async () => {
    const { env } = await setup();
    const proc = Bun.spawn([process.execPath, CLI, '--help'], { env, stdout: 'pipe' });
    procs.push(proc);
    await proc.exited;
    expect(await new Response(proc.stdout).text()).toContain('remi pair');
  });
});
