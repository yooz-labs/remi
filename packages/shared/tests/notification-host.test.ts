import { expect, test } from 'bun:test';
import {
  createNotificationHostRequest,
  createNotificationHostResponse,
  deserialize,
  serialize,
} from '../src/index.ts';

test('direct notification bootstrap accepts only its action and envelope, never an identity or token', () => {
  const request = createNotificationHostRequest('enable');
  expect(deserialize(serialize(request))).toEqual(request);
  for (const extra of [
    { publicKey: 'not a selector' },
    { fingerprint: 'not a selector' },
    { token: 'must remain encrypted' },
    { action: 'unknown' },
  ]) {
    expect(deserialize(JSON.stringify({ ...request, ...extra }))).toBeNull();
  }
});

test('notification host responses require correlated typed state and a canonical WSS origin', () => {
  const request = createNotificationHostRequest('status');
  const response = createNotificationHostResponse(request.id, {
    success: true,
    state: 'renewal_required',
    relayUrl: 'wss://relay.example',
    expiresAt: '2026-10-26T12:00:00.000Z',
  });
  expect(deserialize(serialize(response))).toEqual(response);
  for (const relayUrl of [
    'ws://relay.example',
    'https://relay.example',
    'wss://u:p@relay.example',
    'wss://relay.example/other',
    'wss://relay.example?q=1',
    'wss://relay.example/',
  ]) {
    expect(deserialize(JSON.stringify({ ...response, relayUrl }))).toBeNull();
  }
  expect(deserialize(JSON.stringify({ ...response, expiresAt: 'not a timestamp' }))).toBeNull();
  expect(deserialize(JSON.stringify({ ...response, requestId: '' }))).toBeNull();
  expect(deserialize(JSON.stringify({ ...response, state: 'revoked' }))).toBeNull();
});
