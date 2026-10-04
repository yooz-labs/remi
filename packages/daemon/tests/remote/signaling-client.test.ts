import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { SignalingClient } from '../../src/remote/signaling-client.ts';
import { type FakeWorker, startFakeWorker, until } from './fake-worker.ts';

describe('SignalingClient', () => {
  test('connectionCode is null before connect', () => {
    const client = new SignalingClient('wss://example.com/connect');
    expect(client.connectionCode).toBeNull();
    expect(client.isConnected).toBe(false);
  });

  test('connect with provided code uses that code', () => {
    const client = new SignalingClient('wss://example.com/connect');
    // connect() will try to create a WebSocket which will fail in test,
    // but we can verify the code is set before the WebSocket is created
    try {
      client.connect('WXYZ-5678');
    } catch {
      // WebSocket creation may fail in test environment
    }
    expect(client.connectionCode).toBe('WXYZ-5678');
    client.close();
  });

  test('connect without code generates one', () => {
    const client = new SignalingClient('wss://example.com/connect');
    try {
      client.connect();
    } catch {
      // WebSocket creation may fail in test environment
    }
    const code = client.connectionCode;
    expect(code).not.toBeNull();
    expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789]{4}$/);
    client.close();
  });

  test('close sets isConnected to false', () => {
    const client = new SignalingClient('wss://example.com/connect');
    client.close();
    expect(client.isConnected).toBe(false);
  });
});

// #1193 review: against a local Worker stand-in (loopback only), the client
// must hand the Worker's `role` to its listeners, and must not let a socket
// that never joined flood the log with one line per frame.
describe('SignalingClient frames from the Worker', () => {
  let worker: FakeWorker | null = null;
  let client: SignalingClient | null = null;

  afterEach(() => {
    client?.close();
    worker?.stop();
    client = null;
    worker = null;
  });

  /** Connect a client; the Worker runs `script` once the client registers. */
  async function connect(script: (w: FakeWorker) => void): Promise<SignalingClient> {
    worker = startFakeWorker((frame, w) => {
      if (frame['type'] === 'register') script(w);
    });
    client = new SignalingClient(worker.url, { rotateOnReconnect: false });
    client.connect('ABCD-2345');
    return client;
  }

  test('peer-connected and peer-disconnected carry the Worker role through', async () => {
    const connected: unknown[] = [];
    const disconnected: unknown[] = [];
    let barrier = false;
    const c = await connect((w) => {
      w.send({ type: 'registered', code: 'ABCD-2345', expiresAt: new Date().toISOString() });
      w.send({ type: 'peer-connected', role: 'client' });
      w.send({ type: 'peer-disconnected', role: 'pending' });
      w.send({ type: 'peer-disconnected' });
      w.send({ type: 'peer-disconnected', role: 'client' });
      w.send({ type: 'error', code: 'BARRIER', message: 'frames above are processed' });
    });
    c.on('peer-connected', (role?: string) => connected.push(role));
    c.on('peer-disconnected', (role?: string) => disconnected.push(role));
    c.on('error', () => {
      barrier = true;
    });
    await until(() => barrier, 'the barrier frame');

    expect(connected).toEqual(['client']);
    expect(disconnected).toEqual(['pending', undefined, 'client']);
  });

  test('an unknown frame type is logged once per type, however often it arrives', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let relayed = false;
      const c = await connect((w) => {
        // The Worker forwards these three from a socket that never joined.
        for (let i = 0; i < 4; i++) {
          for (const type of ['offer', 'answer', 'ice-candidate']) w.send({ type, n: i });
        }
        w.send({ type: 'relay', payload: 'done' });
      });
      c.on('relay', () => {
        relayed = true;
      });
      await until(() => relayed, 'the trailing relay frame');

      const lines = warn.mock.calls.map((args) => args.map(String).join(' '));
      const unknown = lines.filter((line) => line.includes('Unknown signaling message type'));
      expect(unknown).toHaveLength(3);
      for (const type of ['offer', 'answer', 'ice-candidate']) {
        expect(unknown.filter((line) => line.endsWith(`: ${type}`))).toHaveLength(1);
      }
    } finally {
      warn.mockRestore();
    }
  });

  test('the set of types it remembers is bounded, so many distinct types cannot grow it or the log', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let relayed = false;
      const c = await connect((w) => {
        for (let i = 0; i < 100; i++) w.send({ type: `made-up-${i}` });
        w.send({ type: 'relay', payload: 'done' });
      });
      c.on('relay', () => {
        relayed = true;
      });
      await until(() => relayed, 'the trailing relay frame');

      const unknown = warn.mock.calls
        .map((args) => args.map(String).join(' '))
        .filter((line) => line.includes('Unknown signaling message type'));
      expect(unknown.length).toBeGreaterThan(0);
      expect(unknown.length).toBeLessThanOrEqual(16);
    } finally {
      warn.mockRestore();
    }
  });
});
