/**
 * Raw-frame collection for the profile-launch privacy test (#1748).
 *
 * `hub-test-utils.ts` is pinned by `scripts/ci/remote-new-client-contract.json`,
 * so the raw frame log lives here instead of in `connectAndHello`.
 * Same handshake as `connectAndHello`, with every frame's text kept as received.
 */

import { createHello, deserialize, serialize } from '@remi/shared/protocol.ts';
import type { ProtocolMessage } from '@remi/shared/protocol.ts';

/** Open a WS, send hello, resolve once hello_ack arrives. `raw` holds every
 *  frame exactly as it arrived, so a test can assert on text that parsing drops. */
export async function connectAndHelloRaw(
  port: number,
): Promise<{ ws: WebSocket; received: ProtocolMessage[]; raw: string[] }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const received: ProtocolMessage[] = [];
  const raw: string[] = [];
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => ws.send(serialize(createHello('hub-test-client', '1.0.0')));
    ws.onmessage = (e) => {
      raw.push(e.data.toString());
      const msg = deserialize(e.data.toString());
      if (msg) received.push(msg);
      if (msg?.type === 'hello_ack') resolve();
    };
    ws.onerror = () => reject(new Error('WebSocket error'));
    setTimeout(() => reject(new Error('Timeout waiting for hello_ack')), 5000);
  });
  return { ws, received, raw };
}
