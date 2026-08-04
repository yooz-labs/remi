/**
 * Local capability token tests (#869).
 *
 * The unit half covers the file's own guarantees; the server half proves the
 * daemon actually distinguishes a token-bearing local client from a bare one,
 * over a real Bun.serve with real WebSocket upgrades. No mocks.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Authenticator } from '../../src/auth/authenticator.ts';
import {
  CAPABILITY_HEADER,
  capabilityTokenMatches,
  loadOrCreateCapabilityToken,
  readCapabilityToken,
} from '../../src/auth/capability-token.ts';
import { IdentityStore } from '../../src/auth/identity-store.ts';
import { shouldSkipAuthForPeer } from '../../src/server/peer-helpers.ts';
import { WebSocketServer } from '../../src/server/websocket-server.ts';
import { reserveRange } from '../session/port-test-helpers.ts';

describe('capability token file', () => {
  let dir: string;
  let tokenPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-cap-'));
    tokenPath = path.join(dir, 'nested', 'capability.key');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('creates the token 0600, creating parent directories', () => {
    const token = loadOrCreateCapabilityToken(tokenPath, () => {});
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600);
  });

  test('is stable across calls', () => {
    const first = loadOrCreateCapabilityToken(tokenPath, () => {});
    const second = loadOrCreateCapabilityToken(tokenPath, () => {});
    expect(second).toBe(first);
    expect(readCapabilityToken(tokenPath)).toBe(first);
  });

  test('tightens a loosened token and says so', () => {
    const token = loadOrCreateCapabilityToken(tokenPath, () => {});
    fs.chmodSync(tokenPath, 0o644);
    const warnings: string[] = [];
    const reread = loadOrCreateCapabilityToken(tokenPath, (m) => warnings.push(m));

    expect(reread).toBe(token);
    expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600);
    // Silently tightening would hide that the secret may already be known.
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('delete the file to rotate');
  });

  test('reading a missing token is null, not a thrown error or a new file', () => {
    expect(readCapabilityToken(tokenPath)).toBeNull();
    expect(fs.existsSync(tokenPath)).toBe(false);
  });

  test('an unwritable directory throws rather than returning a fake token', () => {
    // The daemon catches this and runs with no token, which fails CLOSED. A
    // silently-empty return here would look like a valid token to the caller.
    const ro = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-cap-ro-'));
    fs.chmodSync(ro, 0o555);
    try {
      expect(() =>
        loadOrCreateCapabilityToken(path.join(ro, 'capability.key'), () => {}),
      ).toThrow();
    } finally {
      fs.chmodSync(ro, 0o755);
      fs.rmSync(ro, { recursive: true, force: true });
    }
  });

  test('an empty expected token admits nobody', () => {
    // The state the daemon lands in when the file could not be written.
    expect(capabilityTokenMatches('anything', '')).toBe(false);
    expect(capabilityTokenMatches('', '')).toBe(false);
  });

  test('comparison rejects mismatches, empties and nulls', () => {
    const token = loadOrCreateCapabilityToken(tokenPath, () => {});
    expect(capabilityTokenMatches(token, token)).toBe(true);
    expect(capabilityTokenMatches(token, `${token}x`)).toBe(false);
    // A prefix must not pass: the comparison is over the whole value.
    expect(capabilityTokenMatches(token.slice(0, 32), token)).toBe(false);
    expect(capabilityTokenMatches('', token)).toBe(false);
    expect(capabilityTokenMatches(null, token)).toBe(false);
    expect(capabilityTokenMatches(token, null)).toBe(false);
    expect(capabilityTokenMatches(null, null)).toBe(false);
  });
});

describe('shouldSkipAuthForPeer with require_local_auth', () => {
  test('today: loopback is exempt, remote is not', () => {
    expect(shouldSkipAuthForPeer(true, '127.0.0.1')).toBe(true);
    expect(shouldSkipAuthForPeer(true, '192.168.1.5')).toBe(false);
  });

  test('with the exemption retired, loopback needs proof', () => {
    const opts = { requireLocalAuth: true };
    expect(shouldSkipAuthForPeer(true, '127.0.0.1', opts)).toBe(false);
    expect(shouldSkipAuthForPeer(true, '127.0.0.1', { ...opts, hasCapability: true })).toBe(true);
  });

  test('a capability token never admits a REMOTE peer', () => {
    // The token proves same-machine file access, so it is meaningless from
    // another host; a stolen one must not become a remote bypass.
    expect(
      shouldSkipAuthForPeer(true, '192.168.1.5', { requireLocalAuth: true, hasCapability: true }),
    ).toBe(false);
    expect(shouldSkipAuthForPeer(true, '192.168.1.5', { hasCapability: true })).toBe(false);
  });

  test('with no authenticator the question is moot', () => {
    expect(shouldSkipAuthForPeer(false, '127.0.0.1')).toBe(false);
    expect(shouldSkipAuthForPeer(false, '127.0.0.1', { requireLocalAuth: true })).toBe(false);
  });
});

describe('WebSocketServer honors the capability token', () => {
  let server: WebSocketServer | null = null;
  let port = 0;
  let dir: string;
  const TOKEN = 'a'.repeat(64);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-cap-srv-'));
  });

  afterEach(async () => {
    if (server?.running) await server.stop();
    server = null;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function startServer(requireLocalAuth: boolean): Promise<void> {
    port = await reserveRange(1);
    const store = new IdentityStore(path.join(dir, 'identity'));
    await store.generate('testpass');
    const identity = await store.unlock('testpass');
    server = new WebSocketServer({
      port,
      host: '127.0.0.1',
      capabilityToken: TOKEN,
      requireLocalAuth,
      connection: {
        authenticator: new Authenticator({ identity, identityStore: store }),
      },
      logFn: () => {},
    });
    await server.start();
  }

  /** Connect and report the first message type the daemon sends, if any. */
  function firstMessageType(token: string | null): Promise<string | null> {
    return new Promise((resolve) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/ws`,
        (token === null ? undefined : { headers: { [CAPABILITY_HEADER]: token } }) as never,
      );
      const done = (v: string | null) => {
        try {
          ws.close();
        } catch {
          // already closing
        }
        resolve(v);
      };
      ws.addEventListener('message', (ev) => {
        try {
          done(String(JSON.parse(String(ev.data)).type));
        } catch {
          done('unparsable');
        }
      });
      ws.addEventListener('error', () => resolve(null));
      // No challenge is itself the answer, so a quiet socket must resolve.
      ws.addEventListener('open', () => setTimeout(() => done('none'), 300));
    });
  }

  test('today a bare local client is still exempt (default off)', async () => {
    await startServer(false);
    expect(await firstMessageType(null)).toBe('none');
  });

  test('with the exemption retired a bare local client is challenged', async () => {
    await startServer(true);
    expect(await firstMessageType(null)).toBe('auth_challenge');
  });

  test('a valid token skips the challenge', async () => {
    await startServer(true);
    expect(await firstMessageType(TOKEN)).toBe('none');
  });

  test('a wrong token does not', async () => {
    await startServer(true);
    expect(await firstMessageType('b'.repeat(64))).toBe('auth_challenge');
    expect(await firstMessageType(TOKEN.slice(0, 32))).toBe('auth_challenge');
  });

  test('/auth-info reports what the WebSocket will actually do', async () => {
    // The probe and the upgrade must agree, or a client decides its handshake
    // from one and then gets the other.
    await startServer(true);
    const bare = await fetch(`http://127.0.0.1:${port}/auth-info`);
    expect(((await bare.json()) as { authRequired: boolean }).authRequired).toBe(true);

    const withToken = await fetch(`http://127.0.0.1:${port}/auth-info`, {
      headers: { [CAPABILITY_HEADER]: TOKEN },
    });
    expect(((await withToken.json()) as { authRequired: boolean }).authRequired).toBe(false);
  });
});
