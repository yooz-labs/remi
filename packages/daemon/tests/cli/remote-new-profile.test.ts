import { expect, test } from 'bun:test';
import { type UUID, createCreateSessionResponse, createHelloAck, hubSupport } from '@remi/shared';
import { WebSocketAdapter } from '../../src/adapters/websocket-adapter.ts';
import { createRemoteSession } from '../../src/cli/remote-new-client.ts';
import type { CreateSessionExtra } from '../../src/server/client-message-events.ts';
import { reserveRange } from '../session/port-test-helpers.ts';

test('remote profile selection checks the capability before sending', async () => {
  const port = await reserveRange(1);
  const session = '55555555-5555-4555-8555-555555555555' as UUID;
  let capabilities: string[] = [];
  const requests: (CreateSessionExtra | undefined)[] = [];
  const adapter = new WebSocketAdapter(
    { port },
    {
      onConnect: (id) => adapter.sendRaw(id, createHelloAck('1.0.0', null, { capabilities })),
      onCreateSessionRequest: (id, _directory, requestId, extra) => {
        requests.push(extra);
        adapter.sendRaw(id, createCreateSessionResponse(true, requestId, session, undefined, port));
      },
    },
  );
  await adapter.start();
  try {
    const unsupported = hubSupport(createHelloAck('1.0.0', null, { capabilities }), [
      'session_profiles',
    ]);
    if (unsupported.supported) throw new Error('expected an unsupported capability');
    await expect(
      createRemoteSession('localhost', port, '/work', 5000, undefined, [], 'work'),
    ).rejects.toThrow(unsupported.message);
    expect(requests).toEqual([]);
    capabilities = ['session_profiles'];
    await createRemoteSession('localhost', port, '/work', 5000, undefined, [], 'work');
    await createRemoteSession('localhost', port, '/work', 5000);
    expect(requests).toEqual([{ profile: 'work' }, undefined]);
  } finally {
    await adapter.stop();
  }
});
