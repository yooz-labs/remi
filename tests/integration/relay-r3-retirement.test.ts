import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as shared from '@remi/shared';
import { createPing, createTerminalResize, deserialize, serialize } from '@remi/shared';
import { resumed } from './relay-r3-fixture.ts';

test('v1 room codes and payload encryption have no remaining daemon implementation or shared export', () => {
  for (const file of [
    'remote/relay-adapter.ts',
    'remote/signaling-client.ts',
    'remote/code-store.ts',
    'remote/relay-notices.ts',
    'cli/cmd-code.ts',
  ]) {
    expect(existsSync(join(import.meta.dir, '../../packages/daemon/src', file))).toBe(false);
  }
  for (const name of [
    'encryptRelayPayload',
    'decryptRelayPayload',
    'deriveRelaySessionKeys',
    'generateEphemeralKeyPair',
  ])
    expect(name in shared).toBe(false);
  expect(typeof shared.kexSigningInput).toBe('function');
});

test('actual encrypted relay contains a throwing application handler, replies and remains usable', async () => {
  const running = await resumed({
    onTerminalResize: () => {
      throw new Error('OWNED_HANDLER_FAILURE');
    },
  });
  try {
    await running.channel.send(new TextEncoder().encode(serialize(createTerminalResize(80, 24))));
    const read = async () => {
      for (let i = 0; i < 8; i++) {
        const bytes = await running.channel.receive(await running.socket.binary());
        const message = bytes ? deserialize(new TextDecoder().decode(bytes)) : null;
        if (message?.type !== 'ack') return message;
      }
      throw new Error('MISSING_APPLICATION_REPLY');
    };
    const reply = await read();
    expect(reply?.type).toBe('error');
    expect(reply && 'code' in reply ? reply.code : undefined).toBe('INTERNAL_ERROR');
    await running.channel.send(new TextEncoder().encode(serialize(createPing())));
    expect((await read())?.type).toBe('pong');
  } finally {
    await running.cleanup();
  }
}, 10000);
