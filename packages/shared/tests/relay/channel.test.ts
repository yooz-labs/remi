import { describe, expect, test } from 'bun:test';
import { encodeDataFrame } from '../../src/relay/envelope.ts';
import * as r from '../../src/relay/internal.ts';
import { type SealFn, aeadKey, aeadSeal } from '../../src/relay/primitives.ts';
import { codeOf, data, hex, seed, seededRandom, text } from './helpers.ts';
import { type Recorder, recorder } from './recorder.ts';

const K_C2H = seed('channel key c2h');
const K_H2C = seed('channel key h2c');
const FAILURE = { code: r.CLOSE_CODE, reason: r.CLOSE_REASON };

interface Pair {
  client: r.Channel;
  host: r.Channel;
  clientIo: Recorder;
  hostIo: Recorder;
}

async function pair(
  extra: { client?: Partial<r.ChannelInit>; host?: Partial<r.ChannelInit> } = {},
): Promise<Pair> {
  const clientIo = recorder();
  const hostIo = recorder();
  const client = await r.Channel.create({
    sendKey: K_C2H.slice(),
    recvKey: K_H2C.slice(),
    direction: r.DIR_C2H,
    io: clientIo.io,
    ...extra.client,
  });
  const host = await r.Channel.create({
    sendKey: K_H2C.slice(),
    recvKey: K_C2H.slice(),
    direction: r.DIR_H2C,
    io: hostIo.io,
    ...extra.host,
  });
  return { client, host, clientIo, hostIo };
}

const counterOf = (frame: Uint8Array): number =>
  Number(new DataView(frame.buffer, frame.byteOffset).getBigUint64(1));

/** Send `n` messages from `from` and return the emitted frames. */
async function sendMany(from: r.Channel, io: Recorder, n: number): Promise<Uint8Array[]> {
  for (let i = 1; i <= n; i++) await from.send(text(`message ${i}`));
  return io.frames.slice();
}

describe('data channel', () => {
  test('messages flow both ways, framed as type, counter, ciphertext', async () => {
    const { client, host, clientIo, hostIo } = await pair();
    await client.send(text('to host'));
    await host.send(text('to client'));
    const [toHost] = clientIo.frames;
    const [toClient] = hostIo.frames;
    expect(toHost?.[0]).toBe(r.TYPE_DATA);
    expect(counterOf(toHost as Uint8Array)).toBe(1);
    expect((toHost as Uint8Array).length).toBe(9 + 'to host'.length + 16);
    expect(hex(data(await host.receive(toHost as Uint8Array)))).toBe(hex(text('to host')));
    expect(hex(data(await client.receive(toClient as Uint8Array)))).toBe(hex(text('to client')));
  });

  test('a caller that reuses its buffer after send cannot change what is sent or received', async () => {
    const { client, host, clientIo } = await pair();
    const buffer = text('original message');
    const sent = client.send(buffer);
    buffer.fill(0x58);
    await sent;
    const frame = (clientIo.frames[0] as Uint8Array).slice();
    const opening = host.receive(frame);
    frame.fill(0);
    expect(hex(data(await opening))).toBe(hex(text('original message')));
  });

  test('counters start at 1 and rise by one per frame, per direction', async () => {
    const { client, host, clientIo, hostIo } = await pair();
    await sendMany(client, clientIo, 3);
    await sendMany(host, hostIo, 2);
    expect(clientIo.frames.map(counterOf)).toEqual([1, 2, 3]);
    expect(hostIo.frames.map(counterOf)).toEqual([1, 2]);
  });

  test('the key material the caller passed is overwritten once imported', async () => {
    const sendKey = K_C2H.slice();
    const recvKey = K_H2C.slice();
    await r.Channel.create({ sendKey, recvKey, direction: r.DIR_C2H, io: recorder().io });
    expect(hex(sendKey)).toBe('00'.repeat(32));
    expect(hex(recvKey)).toBe('00'.repeat(32));
  });

  test('a replayed frame is refused and closes the channel for good', async () => {
    const { client, host, clientIo, hostIo } = await pair();
    await sendMany(client, clientIo, 2);
    await host.receive(clientIo.frames[0] as Uint8Array);
    expect(await codeOf(host.receive(clientIo.frames[0] as Uint8Array))).toBe('COUNTER');
    expect(hostIo.closes).toEqual([FAILURE]);
    expect(host.closed).toBe(true);
    // The next legitimate frame is no longer accepted: the channel is gone.
    expect(await codeOf(host.receive(clientIo.frames[1] as Uint8Array))).toBe('CLOSED');
    expect(client.closed).toBe(false);
  });

  test('a reordered pair of frames is refused', async () => {
    const { client, host, clientIo } = await pair();
    await sendMany(client, clientIo, 2);
    expect(await codeOf(host.receive(clientIo.frames[1] as Uint8Array))).toBe('COUNTER');
  });

  test('a dropped frame (a gap) is refused', async () => {
    const { client, host, clientIo } = await pair();
    await sendMany(client, clientIo, 3);
    await host.receive(clientIo.frames[0] as Uint8Array);
    expect(await codeOf(host.receive(clientIo.frames[2] as Uint8Array))).toBe('COUNTER');
  });

  test('a frame reusing a consumed counter with other content is refused', async () => {
    const { client, host, clientIo } = await pair();
    await sendMany(client, clientIo, 1);
    await host.receive(clientIo.frames[0] as Uint8Array);
    const other = recorder();
    const c2 = await r.Channel.create({
      sendKey: K_C2H.slice(),
      recvKey: K_H2C.slice(),
      direction: r.DIR_C2H,
      io: other.io,
    });
    await c2.send(text('a different first message'));
    expect(await codeOf(host.receive(other.frames[0] as Uint8Array))).toBe('COUNTER');
  });

  test('counter 0, the number the handshake already used, is refused', async () => {
    const { host } = await pair();
    const key = await aeadKey(K_C2H);
    const ct = await aeadSeal(key, r.TYPE_DATA, r.DIR_C2H, 0, text('replayed handshake counter'));
    expect(await codeOf(host.receive(encodeDataFrame(0, ct)))).toBe('COUNTER');
  });

  test('a truncated frame is refused, by the tag if long enough and by length if not', async () => {
    const { client, host, clientIo } = await pair();
    await sendMany(client, clientIo, 1);
    const frame = clientIo.frames[0] as Uint8Array;
    expect(await codeOf(host.receive(frame.slice(0, frame.length - 1)))).toBe('DECRYPT');
    const second = await pair();
    expect(await codeOf(second.host.receive(frame.slice(0, r.MIN_FRAME - 1)))).toBe('MALFORMED');
  });

  test('every bit of a frame is covered: a flip in the type, counter, ciphertext or tag is refused', async () => {
    const { client, clientIo } = await pair();
    await sendMany(client, clientIo, 1);
    const frame = clientIo.frames[0] as Uint8Array;
    // Byte 0 is the type; bytes 1 to 8 the counter (1 to 3 are its top bytes, so a flip
    // there lands above the maximum counter); everything after is ciphertext and tag.
    const expected = (i: number): r.RelayErrorCode =>
      i === 0 ? 'TYPE' : i <= 3 ? 'COUNTER_LIMIT' : i <= 8 ? 'COUNTER' : 'DECRYPT';
    for (let i = 0; i < frame.length; i++) {
      const fresh = await pair();
      const bad = frame.slice();
      bad[i] = (bad[i] ?? 0) ^ 0x01;
      expect(await codeOf(fresh.host.receive(bad))).toBe(expected(i));
    }
  });

  test('a frame sealed under another key is refused', async () => {
    const wrong = recorder();
    const sender = await r.Channel.create({
      sendKey: seed('some other key'),
      recvKey: K_H2C.slice(),
      direction: r.DIR_C2H,
      io: wrong.io,
    });
    await sender.send(text('forged'));
    const { host } = await pair();
    expect(await codeOf(host.receive(wrong.frames[0] as Uint8Array))).toBe('DECRYPT');
  });

  test('a frame reflected back to its sender is refused', async () => {
    const { client, clientIo } = await pair();
    await sendMany(client, clientIo, 1);
    expect(await codeOf(client.receive(clientIo.frames[0] as Uint8Array))).toBe('DECRYPT');
  });

  test('a reflected frame is refused even when both directions share one key: the direction is authenticated', async () => {
    // A misconfigured pair, on purpose: only the direction byte can tell these apart.
    const io = recorder();
    const same = (): Promise<r.Channel> =>
      r.Channel.create({
        sendKey: K_C2H.slice(),
        recvKey: K_C2H.slice(),
        direction: r.DIR_C2H,
        io: io.io,
      });
    const a = await same();
    await a.send(text('echo me'));
    const b = await same();
    expect(await codeOf(b.receive(io.frames[0] as Uint8Array))).toBe('DECRYPT');
  });

  test('a text frame after the handshake is refused and closes: there is no plaintext fallback', async () => {
    const { host, hostIo } = await pair();
    expect(
      await codeOf(host.receive(r.encodeHello('pair', new Uint8Array(65), new Uint8Array(32)))),
    ).toBe('TYPE');
    expect(hostIo.closes).toEqual([FAILURE]);
    expect(host.closed).toBe(true);
  });

  test('every failure closes with the same code and reason, once, and nothing else is emitted', async () => {
    const scenarios: ((p: Pair) => Promise<unknown>)[] = [
      (p) => p.host.receive('text'),
      (p) => p.host.receive(new Uint8Array(3)),
      (p) => p.host.receive(new Uint8Array(r.MAX_FRAME + 1)),
      (p) => p.host.receive(Uint8Array.from({ length: 40 }, (_, i) => (i === 0 ? r.TYPE_DATA : 0))),
      (p) => p.host.receive(Uint8Array.from({ length: 40 }, (_, i) => (i === 0 ? 9 : 0))),
      (p) => p.host.receive(encodeDataFrame(r.MAX_COUNTER + 1, new Uint8Array(17))),
      (p) => p.host.receive(encodeDataFrame(1, new Uint8Array(17))),
    ];
    for (const scenario of scenarios) {
      const p = await pair();
      await scenario(p).then(
        () => {
          throw new Error('expected a failure');
        },
        () => undefined,
      );
      expect(p.hostIo.closes).toEqual([FAILURE]);
      expect(p.hostIo.frames).toEqual([]);
    }
  });

  test('every RelayError code maps to the one wire close', () => {
    const codes: r.RelayErrorCode[] = [
      'MALFORMED',
      'VERSION',
      'TYPE',
      'MODE',
      'MODE_MISMATCH',
      'OVERSIZE',
      'BAD_SIGNATURE',
      'DECRYPT',
      'COUNTER',
      'COUNTER_LIMIT',
      'UNKNOWN_DEVICE',
      'PAIRING',
      'EXPIRED',
      'STATE',
      'NAME',
      'TOKEN',
      'QUEUE_FULL',
      'CLOSED',
      'IO',
    ];
    for (const code of codes) {
      const closeFrame = new r.RelayError(code).close;
      expect(closeFrame).toEqual({ code: 4400, reason: 'closed' });
    }
  });
});

describe('counter and size limits', () => {
  test('the sender stops at the maximum counter and closes', async () => {
    const { client, host, clientIo } = await pair({
      client: { nextSend: r.MAX_COUNTER },
      host: { nextRecv: r.MAX_COUNTER },
    });
    await client.send(text('last'));
    expect(counterOf(clientIo.frames[0] as Uint8Array)).toBe(r.MAX_COUNTER);
    expect(hex(data(await host.receive(clientIo.frames[0] as Uint8Array)))).toBe(hex(text('last')));
    expect(await codeOf(client.send(text('one too many')))).toBe('COUNTER_LIMIT');
    expect(clientIo.closes).toEqual([FAILURE]);
    expect(clientIo.frames.length).toBe(1);
  });

  test('the receiver accepts the maximum counter and refuses the next one even with a valid tag', async () => {
    const { host } = await pair({ host: { nextRecv: r.MAX_COUNTER } });
    const key = await aeadKey(K_C2H);
    const last = await aeadSeal(key, r.TYPE_DATA, r.DIR_C2H, r.MAX_COUNTER, text('last'));
    expect(hex(data(await host.receive(encodeDataFrame(r.MAX_COUNTER, last))))).toBe(
      hex(text('last')),
    );
    const beyond = await aeadSeal(key, r.TYPE_DATA, r.DIR_C2H, r.MAX_COUNTER + 1, text('beyond'));
    expect(await codeOf(host.receive(encodeDataFrame(r.MAX_COUNTER + 1, beyond)))).toBe(
      'COUNTER_LIMIT',
    );
  });

  test('the largest plaintext is sent, one byte more is refused without consuming a counter', async () => {
    const { client, host, clientIo } = await pair();
    await expect(client.send(new Uint8Array(r.MAX_PLAINTEXT + 1))).rejects.toMatchObject({
      code: 'OVERSIZE',
    });
    expect(client.closed).toBe(false);
    await client.send(new Uint8Array(r.MAX_PLAINTEXT).fill(7));
    expect(clientIo.frames.length).toBe(1);
    expect((clientIo.frames[0] as Uint8Array).length).toBe(r.MAX_FRAME);
    expect(counterOf(clientIo.frames[0] as Uint8Array)).toBe(1);
    expect(data(await host.receive(clientIo.frames[0] as Uint8Array)).length).toBe(r.MAX_PLAINTEXT);
  });

  test('an empty message is refused without consuming a counter', async () => {
    const { client, clientIo } = await pair();
    expect(await codeOf(client.send(new Uint8Array(0)))).toBe('MALFORMED');
    await client.send(text('x'));
    expect(counterOf(clientIo.frames[0] as Uint8Array)).toBe(1);
  });

  test('an oversized incoming frame is refused', async () => {
    const { host, hostIo } = await pair();
    const frame = new Uint8Array(r.MAX_FRAME + 1);
    frame[0] = r.TYPE_DATA;
    frame[8] = 1;
    expect(await codeOf(host.receive(frame))).toBe('OVERSIZE');
    expect(hostIo.closes).toEqual([FAILURE]);
  });
});

/** A seal that really encrypts but holds frame 1 until released. */
function gatedSeal(): { seal: SealFn; release: () => void; started: number[] } {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((res) => {
    release = res;
  });
  const started: number[] = [];
  return {
    release,
    started,
    seal: async (key, type, dir, counter, plaintext) => {
      started.push(counter);
      if (counter === 1) await gate;
      return aeadSeal(key, type, dir, counter, plaintext);
    },
  };
}

describe('ordered sending', () => {
  test('a slow encryption of frame 1 cannot let frame 2 leave first', async () => {
    const g = gatedSeal();
    const { client, clientIo } = await pair({ client: { seal: g.seal } });
    const first = client.send(text('first, slow'));
    const second = client.send(text('second, fast'));
    // Give a faulty implementation every chance to emit frame 2 while frame 1 is held.
    for (let i = 0; i < 40 && clientIo.frames.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(clientIo.frames.map(counterOf)).toEqual([]);
    g.release();
    await Promise.all([first, second]);
    expect(clientIo.frames.map(counterOf)).toEqual([1, 2]);
  });

  test('counters follow call order even when calls are not awaited', async () => {
    const { client, host, clientIo } = await pair();
    await Promise.all(Array.from({ length: 20 }, (_, i) => client.send(text(`m${i}`))));
    expect(clientIo.frames.map(counterOf)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    for (let i = 0; i < 20; i++) {
      expect(hex(data(await host.receive(clientIo.frames[i] as Uint8Array)))).toBe(
        hex(text(`m${i}`)),
      );
    }
  });

  test('a full queue refuses the next message without consuming a counter', async () => {
    const g = gatedSeal();
    const { client, clientIo } = await pair({ client: { seal: g.seal } });
    const pending = Array.from({ length: r.MAX_PENDING_SENDS }, (_, i) =>
      client.send(text(`m${i}`)),
    );
    expect(await codeOf(client.send(text('one too many')))).toBe('QUEUE_FULL');
    expect(client.closed).toBe(false);
    g.release();
    await Promise.all(pending);
    expect(clientIo.frames.map(counterOf)).toEqual(
      Array.from({ length: r.MAX_PENDING_SENDS }, (_, i) => i + 1),
    );
    await client.send(text('after'));
    expect(counterOf(clientIo.frames[r.MAX_PENDING_SENDS] as Uint8Array)).toBe(
      r.MAX_PENDING_SENDS + 1,
    );
  });

  test('a frame that cannot be sent is never skipped: the channel closes and later frames do not leave', async () => {
    const clientIo = recorder();
    let calls = 0;
    const io: r.ChannelIO = {
      emit: (frame) => {
        calls++;
        if (calls === 2) throw new Error('socket went away');
        clientIo.io.emit(frame);
      },
      close: clientIo.io.close,
    };
    const client = await r.Channel.create({
      sendKey: K_C2H.slice(),
      recvKey: K_H2C.slice(),
      direction: r.DIR_C2H,
      io,
    });
    const sends = [1, 2, 3].map((i) => client.send(text(`m${i}`)));
    const outcomes = await Promise.allSettled(sends);
    expect(outcomes.map((o) => o.status)).toEqual(['fulfilled', 'rejected', 'rejected']);
    expect((outcomes[1] as PromiseRejectedResult).reason.code).toBe('IO');
    expect((outcomes[2] as PromiseRejectedResult).reason.code).toBe('CLOSED');
    expect(clientIo.frames.map(counterOf)).toEqual([1]);
    expect(clientIo.closes).toEqual([FAILURE]);
  });

  test('an encryption failure closes the channel the same way', async () => {
    const clientIo = recorder();
    const client = await r.Channel.create({
      sendKey: K_C2H.slice(),
      recvKey: K_H2C.slice(),
      direction: r.DIR_C2H,
      io: clientIo.io,
      seal: async () => {
        throw new Error('engine failure');
      },
    });
    expect(await codeOf(client.send(text('x')))).toBe('IO');
    expect(clientIo.closes).toEqual([FAILURE]);
    expect(await codeOf(client.send(text('y')))).toBe('CLOSED');
  });

  test('received frames are processed in arrival order, and a bad one poisons the rest', async () => {
    const { client, host, clientIo } = await pair();
    await sendMany(client, clientIo, 3);
    const bad = (clientIo.frames[1] as Uint8Array).slice();
    bad[bad.length - 1] = (bad[bad.length - 1] ?? 0) ^ 0xff;
    const results = await Promise.allSettled([
      host.receive(clientIo.frames[0] as Uint8Array),
      host.receive(bad),
      host.receive(clientIo.frames[2] as Uint8Array),
    ]);
    expect(results.map((x) => x.status)).toEqual(['fulfilled', 'rejected', 'rejected']);
    expect((results[1] as PromiseRejectedResult).reason.code).toBe('DECRYPT');
    expect((results[2] as PromiseRejectedResult).reason.code).toBe('CLOSED');
  });
});

describe('closing', () => {
  test('a deliberate close is not a failure, is idempotent, and ends the channel', async () => {
    const { client, clientIo } = await pair();
    client.close();
    client.close();
    expect(clientIo.closes).toEqual([{ code: r.CLOSE_NORMAL, reason: 'closed' }]);
    expect(client.closed).toBe(true);
    expect(await codeOf(client.send(text('late')))).toBe('CLOSED');
    expect(await codeOf(client.receive(new Uint8Array(40)))).toBe('CLOSED');
  });
});

describe('authenticated end of stream (BYE)', () => {
  const typeOf = (frame: Uint8Array): number => frame[0] as number;

  test('bye is the next counter, type 4, an empty plaintext: 25 bytes, after the data it follows', async () => {
    const { client, clientIo } = await pair();
    await client.send(text('one'));
    await client.send(text('two'));
    await client.bye();
    expect(clientIo.frames.map(counterOf)).toEqual([1, 2, 3]);
    expect(clientIo.frames.map(typeOf)).toEqual([r.TYPE_DATA, r.TYPE_DATA, r.TYPE_BYE]);
    expect((clientIo.frames[2] as Uint8Array).length).toBe(r.BYE_FRAME);
    expect(r.BYE_FRAME).toBe(25);
  });

  test('the receiver gets the marker, not data, and the transport close that follows is clean', async () => {
    const { client, host, clientIo } = await pair();
    await client.send(text('last words'));
    await client.bye();
    expect(hex(data(await host.receive(clientIo.frames[0] as Uint8Array)))).toBe(
      hex(text('last words')),
    );
    expect(host.peerEnded).toBe(false);
    expect(await host.receive(clientIo.frames[1] as Uint8Array)).toBeNull();
    expect(host.peerEnded).toBe(true);
    expect(host.closed).toBe(false);
    expect(host.transportClosed()).toBe('clean');
  });

  test('a close with no BYE is unclean: the tail may be truncated', async () => {
    const { client, host, clientIo } = await pair();
    await sendMany(client, clientIo, 2);
    await host.receive(clientIo.frames[0] as Uint8Array);
    expect(host.transportClosed()).toBe('unclean');
    expect(host.closed).toBe(true);
  });

  test('a tail dropped together with its BYE is an unclean close, never a clean one', async () => {
    const { client, host, clientIo } = await pair();
    await client.send(text('1'));
    await client.send(text('2'));
    await client.send(text('3'));
    await client.bye();
    await host.receive(clientIo.frames[0] as Uint8Array); // frames 2, 3 and the BYE are dropped
    expect(host.transportClosed()).toBe('unclean');
  });

  test('a dropped frame before a delivered BYE is a counter gap, caught as before', async () => {
    const { client, host, clientIo } = await pair();
    await client.send(text('1'));
    await client.send(text('2'));
    await client.bye();
    await host.receive(clientIo.frames[0] as Uint8Array);
    expect(await codeOf(host.receive(clientIo.frames[2] as Uint8Array))).toBe('COUNTER');
    expect(host.transportClosed()).toBe('failed');
  });

  test('after bye the sender sends nothing: send and a second bye are ENDED, and the channel still reads', async () => {
    const { client, host, clientIo, hostIo } = await pair();
    await client.bye();
    expect(await codeOf(client.send(text('late')))).toBe('ENDED');
    expect(await codeOf(client.bye())).toBe('ENDED');
    expect(clientIo.frames.length).toBe(1);
    expect(client.closed).toBe(false);
    expect(clientIo.closes).toEqual([]);
    await host.send(text('reply after the peer said bye'));
    expect(hex(data(await client.receive(hostIo.frames[0] as Uint8Array)))).toBe(
      hex(text('reply after the peer said bye')),
    );
  });

  test('sends queued before bye leave before it, in order', async () => {
    const { client, clientIo } = await pair();
    const sends = [client.send(text('a')), client.send(text('b')), client.bye()];
    await Promise.all(sends);
    expect(clientIo.frames.map((f) => [typeOf(f), counterOf(f)])).toEqual([
      [r.TYPE_DATA, 1],
      [r.TYPE_DATA, 2],
      [r.TYPE_BYE, 3],
    ]);
  });

  test("a frame after the peer's BYE is refused, a data frame or a second BYE alike", async () => {
    for (const second of ['data', 'bye'] as const) {
      const { client, host, clientIo, hostIo } = await pair();
      await client.bye();
      expect(await host.receive(clientIo.frames[0] as Uint8Array)).toBeNull();
      const key = await aeadKey(K_C2H);
      const frame =
        second === 'data'
          ? encodeDataFrame(2, await aeadSeal(key, r.TYPE_DATA, r.DIR_C2H, 2, text('after bye')))
          : encodeDataFrame(
              2,
              await aeadSeal(key, r.TYPE_BYE, r.DIR_C2H, 2, new Uint8Array(0)),
              r.TYPE_BYE,
            );
      expect([second, await codeOf(host.receive(frame))]).toEqual([second, 'ENDED']);
      expect(hostIo.closes).toEqual([FAILURE]);
    }
  });

  test('a replayed BYE is a counter failure, not a second end', async () => {
    const { client, host, clientIo } = await pair();
    await client.bye();
    await host.receive(clientIo.frames[0] as Uint8Array);
    expect(await codeOf(host.receive(clientIo.frames[0] as Uint8Array))).toBe('ENDED');
    const second = await pair();
    await second.client.send(text('x'));
    await second.client.bye();
    await second.host.receive(second.clientIo.frames[0] as Uint8Array);
    // The replay arrives before the BYE it copies has been consumed: a repeated counter.
    expect(await codeOf(second.host.receive(second.clientIo.frames[0] as Uint8Array))).toBe(
      'COUNTER',
    );
  });

  test('a BYE cannot be forged: another key, another direction and a data frame dressed as BYE all fail', async () => {
    const wrongKey = await aeadKey(seed('forger key'));
    const rightKey = await aeadKey(K_C2H);
    const empty = new Uint8Array(0);
    const forged: [string, Uint8Array][] = [
      [
        'another key',
        encodeDataFrame(1, await aeadSeal(wrongKey, r.TYPE_BYE, r.DIR_C2H, 1, empty), r.TYPE_BYE),
      ],
      [
        'the other direction',
        encodeDataFrame(1, await aeadSeal(rightKey, r.TYPE_BYE, r.DIR_H2C, 1, empty), r.TYPE_BYE),
      ],
      [
        'sealed as data',
        encodeDataFrame(1, await aeadSeal(rightKey, r.TYPE_DATA, r.DIR_C2H, 1, empty), r.TYPE_BYE),
      ],
      [
        'counter 0',
        encodeDataFrame(0, await aeadSeal(rightKey, r.TYPE_BYE, r.DIR_C2H, 0, empty), r.TYPE_BYE),
      ],
    ];
    for (const [name, frame] of forged) {
      const { host, hostIo } = await pair();
      const code = await codeOf(host.receive(frame));
      expect([name, code]).toEqual([name, name === 'counter 0' ? 'COUNTER' : 'DECRYPT']);
      expect(host.peerEnded).toBe(false);
      expect(hostIo.closes).toEqual([FAILURE]);
    }
  });

  test('a data frame sealed as BYE (type byte 3, BYE header) does not open as data either', async () => {
    const { host } = await pair();
    const key = await aeadKey(K_C2H);
    const frame = encodeDataFrame(1, await aeadSeal(key, r.TYPE_BYE, r.DIR_C2H, 1, text('x')));
    expect(await codeOf(host.receive(frame))).toBe('DECRYPT');
  });

  test('a BYE that carries a payload or is cut short is refused by length', async () => {
    const key = await aeadKey(K_C2H);
    const withPayload = encodeDataFrame(
      1,
      await aeadSeal(key, r.TYPE_BYE, r.DIR_C2H, 1, text('x')),
      r.TYPE_BYE,
    );
    expect(withPayload.length).toBe(26);
    expect(await codeOf((await pair()).host.receive(withPayload))).toBe('MALFORMED');
    const real = encodeDataFrame(
      1,
      await aeadSeal(key, r.TYPE_BYE, r.DIR_C2H, 1, new Uint8Array(0)),
      r.TYPE_BYE,
    );
    expect(await codeOf((await pair()).host.receive(real.slice(0, 24)))).toBe('MALFORMED');
    expect(await (await pair()).host.receive(real)).toBeNull();
  });

  test('both directions end independently, each clean on its own BYE', async () => {
    const { client, host, clientIo, hostIo } = await pair();
    await client.bye();
    await host.bye();
    expect(await host.receive(clientIo.frames[0] as Uint8Array)).toBeNull();
    expect(await client.receive(hostIo.frames[0] as Uint8Array)).toBeNull();
    expect(host.transportClosed()).toBe('clean');
    expect(client.transportClosed()).toBe('clean');
  });

  test('bye takes a counter, so it respects the counter limit and the queue limit', async () => {
    const a = await pair({ client: { nextSend: r.MAX_COUNTER } });
    await a.client.bye();
    expect(counterOf(a.clientIo.frames[0] as Uint8Array)).toBe(r.MAX_COUNTER);
    const b = await pair({ client: { nextSend: r.MAX_COUNTER + 1 } });
    expect(await codeOf(b.client.bye())).toBe('COUNTER_LIMIT');
    expect(b.clientIo.closes).toEqual([FAILURE]);
  });

  test('a refused bye does not end the sending side', async () => {
    const g = gatedSeal();
    const { client, clientIo } = await pair({ client: { seal: g.seal } });
    const pending = Array.from({ length: r.MAX_PENDING_SENDS }, (_, i) =>
      client.send(text(`m${i}`)),
    );
    expect(await codeOf(client.bye())).toBe('QUEUE_FULL');
    g.release();
    await Promise.all(pending);
    await client.send(text('still open for sending'));
    await client.bye();
    expect(clientIo.frames.map(typeOf).at(-1)).toBe(r.TYPE_BYE);
  });

  test('transportClosed is idempotent, and a local close with no peer BYE is unclean too', async () => {
    const { host } = await pair();
    host.close();
    expect(host.transportClosed()).toBe('unclean');
    expect(host.transportClosed()).toBe('unclean');
  });

  test('a failed channel reports failed, whatever else happened', async () => {
    const { host } = await pair();
    await codeOf(host.receive(new Uint8Array(40)));
    expect(host.transportClosed()).toBe('failed');
  });
});

describe('limits of the channel, stated by tests so they cannot be forgotten', () => {
  test('a tail dropped WITHOUT a close is invisible to the library: only the application can notice silence', async () => {
    // Frames 1 and 2 arrive, frame 3 and the BYE are withheld, and the socket stays open.
    // Counters cannot see an absent frame and no BYE has arrived: the channel is simply open.
    // Detecting that is a liveness question for the application (acks, deadlines), ADR 0034 section 15.2.
    const { client, host, clientIo, hostIo } = await pair();
    await client.send(text('1'));
    await client.send(text('2'));
    await client.send(text('3'));
    await client.bye();
    await host.receive(clientIo.frames[0] as Uint8Array);
    await host.receive(clientIo.frames[1] as Uint8Array);
    expect(host.closed).toBe(false);
    expect(host.peerEnded).toBe(false);
    expect(hostIo.closes).toEqual([]);
  });

  test('BYE proves nothing about delivery in the other direction: the sender learns nothing from sending it', async () => {
    const { client, clientIo } = await pair();
    await client.bye();
    // The sender's promise resolves when the frame is emitted, not when it is received.
    expect(clientIo.frames.length).toBe(1);
    expect(client.peerEnded).toBe(false);
  });
});

describe('property tests: no mutation of a valid frame, and no random frame, ever opens', () => {
  const rng = seededRandom('channel properties');
  const pick = (n: number): number => (rng(4).reduce((acc, b) => acc * 256 + b, 0) >>> 0) % n;

  test('300 mutated valid frames are all refused', async () => {
    for (let i = 0; i < 300; i++) {
      const { client, host, clientIo } = await pair();
      const plaintext = rng(1 + pick(300));
      await client.send(plaintext);
      const frame = clientIo.frames[0] as Uint8Array;
      let bad = frame.slice();
      switch (pick(6)) {
        case 0:
          bad[pick(bad.length)] = (bad[pick(bad.length)] ?? 0) ^ (1 + pick(255));
          break;
        case 1:
          bad = bad.slice(0, 1 + pick(bad.length - 1));
          break;
        case 2:
          bad = new Uint8Array([...bad, ...rng(1 + pick(40))]);
          break;
        case 3:
          bad[0] = pick(256);
          break;
        case 4:
          bad.fill(0, 9);
          break;
        default:
          bad[1 + pick(8)] = pick(256);
      }
      if (hex(bad) === hex(frame)) continue;
      await expect(host.receive(bad)).rejects.toBeInstanceOf(r.RelayError);
      expect(host.closed).toBe(true);
    }
  });

  test('300 random frames shaped like data frames are all refused', async () => {
    for (let i = 0; i < 300; i++) {
      const { host } = await pair();
      const frame = rng(r.MIN_FRAME + pick(200));
      frame[0] = r.TYPE_DATA;
      frame.fill(0, 1, 8);
      frame[8] = 1;
      expect(await codeOf(host.receive(frame))).toBe('DECRYPT');
    }
  });
});
