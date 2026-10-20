import { expect, test } from 'bun:test';
import { createSessionListRequest, createSessionListResponse, serialize } from '@remi/shared';
import { resumed } from './relay-r3-fixture.ts';

type DrainPeer = {
  ws: WebSocket;
  channel: import('@remi/shared').relayV2.Channel;
  receiveTail: Promise<void>;
  ending?: Promise<void>;
};

/** Observe real wrapper enqueue and transport completion; crypto still judges BYE. */
function queuedHostBye(running: Awaited<ReturnType<typeof resumed>>) {
  const peers = (running.relay as unknown as { peers: Map<string, DrainPeer> }).peers;
  const peer = [...peers.values()][0];
  if (!peer) throw new Error('ready peer missing');
  const onmessage = peer.ws.onmessage;
  const onclose = peer.ws.onclose;
  if (!onmessage || !onclose) throw new Error('host wrapper handler missing');
  let queued = 0;
  let resolve!: () => void;
  const enqueued = new Promise<void>((done) => {
    resolve = done;
  });
  let closeObserved!: () => void;
  const closed = new Promise<void>((done) => {
    closeObserved = done;
  });
  let ending: Promise<void> | undefined;
  const observeMessage = (event: MessageEvent) => {
    const before = peer.receiveTail;
    onmessage.call(peer.ws, event);
    if (event.data instanceof ArrayBuffer && peer.receiveTail !== before && ++queued === 2)
      resolve();
  };
  const observeClose = (event: CloseEvent) => {
    onclose.call(peer.ws, event);
    ending = peer.ending;
    if (!ending) throw new Error('actual host transport ending promise missing');
    closeObserved();
  };
  peer.ws.onmessage = observeMessage;
  peer.ws.onclose = observeClose;
  return {
    peer,
    enqueued,
    closed,
    get ending() {
      if (!ending) throw new Error('actual host close not observed');
      return ending;
    },
    restore() {
      if (peer.ws.onmessage === observeMessage) peer.ws.onmessage = onmessage;
      if (peer.ws.onclose === observeClose) peer.ws.onclose = onclose;
    },
  };
}

test('transport close drains wrapper-queued authenticated BYE behind an application wait', async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const running = await resumed({
    onSessionListRequest: (cid, id) => {
      release = () => running.relay.sendRaw(cid, createSessionListResponse([], id));
      entered();
    },
  });
  let observation: ReturnType<typeof queuedHostBye> | undefined;
  try {
    observation = queuedHostBye(running);
    await running.channel.send(new TextEncoder().encode(serialize(createSessionListRequest())));
    await started;
    await running.channel.bye();
    await observation.enqueued;
    running.socket.close();
    await observation.closed;
    await running.socket.closed;
    release();
    await observation.ending;
    expect(running.logs.some((message) => message.includes('Relay delivery uncertain'))).toBe(
      false,
    );
  } finally {
    release?.();
    observation?.restore();
    await running.cleanup();
  }
}, 10000);

test('close drains real crypto wrapper tail and never applies queued post-close input', async () => {
  let calls = 0;
  const running = await resumed({
    onSessionListRequest: () => {
      calls++;
    },
  });
  const observation = queuedHostBye(running);
  const { peer } = observation;
  const receive = peer.channel.receive.bind(peer.channel);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let first = true;
  // Delay the adapter's call into the real crypto, never replace its result or checks.
  peer.channel.receive = async (frame) => {
    if (first) {
      first = false;
      enter();
      await gate;
    }
    return receive(frame);
  };
  try {
    await running.channel.send(new TextEncoder().encode(serialize(createSessionListRequest())));
    await entered;
    await running.channel.bye();
    await observation.enqueued;
    running.socket.close();
    await observation.closed;
    await running.socket.closed;
    release();
    await observation.ending;
    expect(calls).toBe(0);
    expect(running.logs.some((message) => message.includes('Relay delivery uncertain'))).toBe(
      false,
    );
  } finally {
    release();
    observation.restore();
    await running.cleanup();
  }
}, 10000);
