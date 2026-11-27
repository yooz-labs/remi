import { expect, test } from 'bun:test';
import {
  type ProtocolMessage,
  createHello,
  createSessionProfilesRequest,
  deserialize,
  serialize,
} from '@remi/shared';
import { Connection } from '../../src/server/connection.ts';

test('an unwired profile-list request receives UNKNOWN_MESSAGE', () => {
  const sent: ProtocolMessage[] = [];
  const connection = new Connection(
    {
      readyState: WebSocket.OPEN,
      send: (raw) => {
        const message = deserialize(raw);
        if (message) sent.push(message);
      },
      close: () => {},
    },
    {},
  );
  try {
    connection.handleMessage(serialize(createHello('synthetic-client', '1.0.0')));
    connection.handleMessage(serialize(createSessionProfilesRequest('/tmp')));
    expect(sent).toContainEqual(
      expect.objectContaining({ type: 'error', code: 'UNKNOWN_MESSAGE' }),
    );
  } finally {
    connection.close('test cleanup');
  }
});
