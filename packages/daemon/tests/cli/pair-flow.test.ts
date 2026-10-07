/**
 * `remi pair` (#1275, ADR 0037): the flow that shows a pairing code, waits for a phone's claim, and
 * asks the person at the terminal; and the checks before it. The store and the authenticator are
 * real, over an isolated directory; the phone's claim goes through the real `verifyResponse`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createAuthResponse,
  createIdentity,
  decodePairingLink,
  fromBase64,
  sign,
  unlockIdentity,
} from '@remi/shared';
import { Authenticator } from '../../src/auth/authenticator.ts';
import { IdentityStore } from '../../src/auth/identity-store.ts';
import { pairFlow, pairPreconditions, pairingHosts } from '../../src/cli/cmd-pair.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-pair-flow-'));
  dirs.push(dir);
  const store = new IdentityStore(dir);
  const machine = await store.generate();
  const auth = new Authenticator({
    identity: await unlockIdentity(machine),
    identityStore: store,
    pairingWaitMs: 200,
  });
  const phone = await createIdentity();
  const phoneKey = await unlockIdentity(phone);
  const out: string[] = [];
  /** The phone: answers a challenge with the scanned link's nonce, as the app does. */
  async function phoneConnects(link: string, label = 'Sam phone') {
    const decoded = decodePairingLink(link);
    if (!decoded.ok) throw new Error(`link refused: ${decoded.error}`);
    const id = `c-${Math.random()}`;
    const challenge = auth.createChallenge(id);
    // The app checks the machine's whole key against the link before it signs anything.
    expect(challenge.serverPublicKey).toBe(decoded.code.key);
    const signature = await sign(phoneKey.privateKey, fromBase64(challenge.challenge));
    return auth.verifyResponse(
      id,
      createAuthResponse(phone.publicKey, signature, phone.fingerprint, undefined, {
        nonce: decoded.code.nonce,
        label,
      }),
    );
  }
  const linkOf = () => {
    const line = out
      .join('')
      .split('\n')
      .find((l) => l.includes('remi://pair#'));
    return line?.slice(line.indexOf('remi://pair#')).trim() ?? '';
  };
  return { dir, store, machine, phone, out, phoneConnects, linkOf };
}

function deps(
  env: Awaited<ReturnType<typeof setup>>,
  ask: (question: string) => Promise<string | null>,
  extra: Partial<Parameters<typeof pairFlow>[0]> = {},
): Parameters<typeof pairFlow>[0] {
  return {
    store: env.store,
    machineKey: env.machine.publicKey,
    machineFingerprint: env.machine.fingerprint,
    name: 'test-mac',
    host: '192.168.1.23',
    port: 18765,
    write: (text) => env.out.push(text),
    ask,
    pollMs: 20,
    ...extra,
  };
}

describe('pairFlow (#1275)', () => {
  test('shows a QR and a link that decodes to this machine, then approves the phone that claims it', async () => {
    const env = await setup();
    let asked = '';
    const flow = pairFlow(
      deps(env, async (question) => {
        asked = question;
        return 'y';
      }),
    );
    while (env.linkOf() === '') await Bun.sleep(10);
    const decoded = decodePairingLink(env.linkOf());
    expect(decoded).toMatchObject({
      ok: true,
      code: { name: 'test-mac', host: '192.168.1.23', port: 18765, key: env.machine.publicKey },
    });
    const text = env.out.join('');
    expect(text).toContain('▀'); // half-block QR rows
    expect(text).toMatch(/[0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4}/);
    // The phone's first try waits for the decision; the person says yes while it waits.
    const first = await env.phoneConnects(env.linkOf());
    expect(['PAIRING_PENDING', undefined]).toContain(first.result.error);
    expect(await flow).toBe(0);
    expect(asked).toContain('Approve');
    const shown = env.out.join('');
    expect(shown).toContain('Sam phone');
    expect(shown).toContain(env.phone.fingerprint.slice(0, 4));
    expect(env.store.isAuthorized(env.phone.publicKey, env.phone.fingerprint)).toBe(true);
    expect(env.store.listAuthorizedKeys()[0]?.label).toBe('Sam phone');
    expect((await env.phoneConnects(env.linkOf())).result.success).toBe(true);
  });

  test('anything but yes rejects: the phone is told, and its key is not pending', async () => {
    for (const answer of ['n', '', 'no', 'maybe', null]) {
      const env = await setup();
      const flow = pairFlow(deps(env, async () => answer));
      while (env.linkOf() === '') await Bun.sleep(10);
      void env.phoneConnects(env.linkOf());
      expect(await flow, String(answer)).toBe(1);
      expect(env.store.listPendingKeys(), String(answer)).toHaveLength(0);
      expect((await env.phoneConnects(env.linkOf())).result.error, String(answer)).toBe(
        'PAIRING_REJECTED',
      );
    }
  });

  test('a code nobody claims expires: it is cancelled and the run says so', async () => {
    const env = await setup();
    let clock = Date.now();
    const flow = pairFlow(deps(env, async () => 'y', { now: () => clock }));
    while (env.linkOf() === '') await Bun.sleep(10);
    clock += 301_000;
    expect(await flow).toBe(1);
    expect(env.out.join('')).toContain('expired');
    expect((await env.phoneConnects(env.linkOf())).result.error).toBe('PAIRING_CANCELLED');
  });

  test('Ctrl-C while waiting cancels the code', async () => {
    const env = await setup();
    const controller = new AbortController();
    const flow = pairFlow(deps(env, async () => 'y', { signal: controller.signal }));
    while (env.linkOf() === '') await Bun.sleep(10);
    controller.abort();
    expect(await flow).toBe(130);
    expect((await env.phoneConnects(env.linkOf())).result.error).toBe('PAIRING_CANCELLED');
  });

  test('a label the phone chose is shown escaped at the terminal', async () => {
    const env = await setup();
    const flow = pairFlow(deps(env, async () => 'n'));
    while (env.linkOf() === '') await Bun.sleep(10);
    // A label with a bidi character is refused before it is ever shown (PAIRING_MALFORMED).
    expect((await env.phoneConnects(env.linkOf(), 'a‮b')).result.error).toBe('PAIRING_MALFORMED');
    void env.phoneConnects(env.linkOf(), 'Plain name');
    expect(await flow).toBe(1);
    expect(env.out.join('')).toContain('Plain name');
  });

  test('when four codes are already open, the run says so instead of showing one', async () => {
    const env = await setup();
    for (let i = 0; i < 4; i++) env.store.createPairing();
    expect(await pairFlow(deps(env, async () => 'y'))).toBe(1);
    expect(env.out.join('')).toContain('open');
    expect(env.linkOf()).toBe('');
  });
});

describe('pairingHosts and pairPreconditions (#1275)', () => {
  const interfaces = {
    lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    en0: [
      { address: 'fe80::1', family: 'IPv6', internal: false },
      { address: '192.168.1.23', family: 'IPv4', internal: false },
    ],
    utun4: [{ address: '100.101.102.103', family: 'IPv4', internal: false }],
    bridge0: [{ address: '203.0.113.9', family: 'IPv4', internal: false }],
  } as never;

  test('a wildcard bind offers every external address, LAN first, then Tailscale, then the rest; never loopback or link-local', () => {
    expect(pairingHosts('0.0.0.0', interfaces)).toEqual([
      '192.168.1.23',
      '100.101.102.103',
      '203.0.113.9',
    ]);
  });

  test('a specific bind offers that address alone', () => {
    expect(pairingHosts('100.101.102.103', interfaces)).toEqual(['100.101.102.103']);
  });

  test('no hub, a loopback bind, auth off, or a hub too old to say are each refused with what to do', () => {
    const refuse = (status: Parameters<typeof pairPreconditions>[0], host?: string) => {
      const result = pairPreconditions(status, host, interfaces);
      if (result.ok) throw new Error(`accepted: ${result.host}`);
      return result.message;
    };
    expect(refuse(null)).toContain('remi start');
    expect(refuse({ port: 18765, bind: '127.0.0.1', auth: true })).toContain('daemon.bind');
    expect(refuse({ port: 18765, bind: '::1', auth: true })).toContain('daemon.bind');
    expect(refuse({ port: 18765, bind: '0.0.0.0', auth: false })).toContain('authentication');
    expect(refuse({ port: 18765 })).toContain('restart');
    expect(refuse({ port: 18765, bind: '0.0.0.0', auth: true }, 'not a host!')).toContain('--host');
  });

  test('a reachable hub with auth on gives the first address, or the one asked for, and the rest', () => {
    expect(
      pairPreconditions({ port: 18765, bind: '0.0.0.0', auth: true }, undefined, interfaces),
    ).toEqual({
      ok: true,
      host: '192.168.1.23',
      port: 18765,
      others: ['100.101.102.103', '203.0.113.9'],
    });
    expect(
      pairPreconditions(
        { port: 18765, bind: '0.0.0.0', auth: true },
        '100.101.102.103',
        interfaces,
      ),
    ).toEqual({
      ok: true,
      host: '100.101.102.103',
      port: 18765,
      others: ['192.168.1.23', '203.0.113.9'],
    });
  });
});
