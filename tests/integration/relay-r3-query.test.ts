import { expect, test } from 'bun:test';
import {
  createAnswer,
  createSessionListRequest,
  createSessionListResponse,
  deserialize,
  serialize,
} from '@remi/shared';
import { resumed } from './relay-r3-fixture.ts';
test('one held machine list cannot block actual answer refusal or grow an aggregate query map', async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  let calls = 0;
  const running = await resumed({
    onSessionListRequest: (cid, id) => {
      calls++;
      release = () => running.relay.sendRaw(cid, createSessionListResponse([], id));
      entered();
    },
  });
  try {
    const first = createSessionListRequest();
    await running.channel.send(new TextEncoder().encode(serialize(first)));
    await started;
    const answer = createAnswer('missing-session', 'missing-question', 'yes');
    await running.channel.send(new TextEncoder().encode(serialize(answer)));
    const data = await running.channel.receive(await running.socket.binary(1000));
    const result = data ? deserialize(new TextDecoder().decode(data)) : null;
    expect(result?.type).toBe('answer_result');
    expect(result?.type === 'answer_result' && result.requestId).toBe(answer.id);
    expect(result?.type === 'answer_result' && result.outcome).toBe('session-not-found');
    const second = createSessionListRequest();
    await running.channel.send(new TextEncoder().encode(serialize(second)));
    const busyData = await running.channel.receive(await running.socket.binary(1000));
    const busy = busyData ? deserialize(new TextDecoder().decode(busyData)) : null;
    expect(busy?.type === 'error' && busy.code).toBe('BUSY');
    expect(calls).toBe(1);
  } finally {
    release?.();
    await running.cleanup();
  }
}, 10000);
