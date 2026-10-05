import { expect, test } from 'bun:test';
import { relayV2 } from '@remi/shared';
import { WorkerControl } from '../../packages/daemon/src/remote/worker-control.ts';
import { startWorker } from '../../packages/signaling/tests/e2e/harness.ts';

test('ACK deadline poisons the whole actual control generation; late same-op ACK cannot settle queued commands', async () => {
  const worker = await startWorker();
  const identity = await relayV2.generateIdentity();
  const rid = await relayV2.ridOf(identity.signer.publicKey);
  const commands: string[] = [];
  let late: (() => void) | undefined;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const upstreams: WebSocket[] = [];
  const bridge = Bun.serve<{ up?: WebSocket; path: string }>({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, server) {
      if (server.upgrade(req, { data: { path: new URL(req.url).pathname } })) return;
      return new Response('no', { status: 400 });
    },
    websocket: {
      open(ws) {
        const up = new WebSocket(worker.wsUrl + ws.data.path);
        ws.data.up = up;
        upstreams.push(up);
        up.onmessage = (event) => {
          const text = String(event.data);
          if (text === 'pong') {
            ws.send(text);
            return;
          }
          const value = JSON.parse(text);
          if (value.t === 'ack') {
            late = () => {
              ws.send(text);
            };
            entered();
          } else ws.send(text);
        };
        up.onclose = () => ws.close();
      },
      message(ws, message) {
        if (typeof message === 'string' && message.startsWith('{'))
          commands.push(JSON.parse(message).t);
        ws.data.up?.send(message);
      },
      close(ws) {
        ws.data.up?.close();
      },
    },
  });
  const control = new WorkerControl(
    `ws://127.0.0.1:${bridge.port}/v2/host/${Buffer.from(rid).toString('hex')}`,
    identity.signer,
    rid,
    () => {},
    () => {},
    () => {},
  );
  try {
    await control.start();
    const device = await relayV2.generateIdentity();
    const first = control.command({ t: 'enroll', key: device.signer.publicKey });
    const firstRejected = expect(first).rejects.toThrow('RELAY_ACK_UNCERTAIN');
    await held;
    const queued = control.command({ t: 'enroll', key: device.signer.publicKey });
    const queuedRejected = expect(queued).rejects.toThrow('RELAY_CONTROL_UNAVAILABLE');
    await Promise.all([firstRejected, queuedRejected]);
    late?.();
    await expect(control.command({ t: 'enroll', key: device.signer.publicKey })).rejects.toThrow(
      'RELAY_CONTROL_UNAVAILABLE',
    );
    expect(commands.filter((command) => command === 'enroll')).toHaveLength(1);
  } finally {
    control.stop();
    for (const up of upstreams) up.close();
    bridge.stop(true);
    await worker.stop();
  }
}, 15000);
