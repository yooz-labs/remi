import { expect, test } from 'bun:test';
import * as shared from '../src/index.ts';
import { MESSAGE_DIRECTION, deserialize, isValidMessage, serialize } from '../src/protocol.ts';

function builder(
  name: string,
): (...args: unknown[]) => shared.ProtocolMessage & Record<string, unknown> {
  const fn = (shared as unknown as Record<string, unknown>)[name];
  expect(typeof fn, `actual secure subscription factory ${name} must exist`).toBe('function');
  return fn as (...args: unknown[]) => shared.ProtocolMessage & Record<string, unknown>;
}
// A real P-256 point: the shared validator checks the curve like the daemon's registration does.
const point = await shared.relayV2.generateEcPair();
const registration = {
  token: 'ab'.repeat(32),
  environment: 'sandbox',
  pushPublicKey: shared.relayV2.b64u(point.publicKey),
  keyVersion: 3,
  pushPrefs: { questions: true },
};

test('secure registration factories bind response request ID and omit caller identity selectors', () => {
  const request = builder('createSecurePushRegisterRequest')(registration);
  expect(request).toMatchObject({ type: 'secure_push_register_request', ...registration });
  expect(Object.keys(request).sort()).toEqual(
    [
      'type',
      'id',
      'timestamp',
      'token',
      'environment',
      'pushPublicKey',
      'keyVersion',
      'pushPrefs',
    ].sort(),
  );
  expect(typeof request.id).toBe('string');
  expect(new Date(request.timestamp as string).toISOString()).toBe(request.timestamp);
  const success = builder('createSecurePushRegisterResponse')(request.id, {
    success: true,
    keyVersion: 3,
  });
  expect(success).toMatchObject({
    type: 'secure_push_register_response',
    requestId: request.id,
    success: true,
    keyVersion: 3,
  });
  const failure = builder('createSecurePushRegisterResponse')(request.id, {
    success: false,
    error: 'NOT_ENROLLED',
  });
  expect(failure).toMatchObject({ requestId: request.id, success: false, error: 'NOT_ENROLLED' });
  expect(failure).not.toHaveProperty('keyVersion');
  for (const message of [request, success, failure])
    expect(deserialize(serialize(message as never))).toEqual(message);
});
test('secure unregister factory has no selectors and correlated idempotent typed result', () => {
  const request = builder('createSecurePushUnregisterRequest')();
  expect(Object.keys(request).sort()).toEqual(['id', 'timestamp', 'type']);
  expect(request.type).toBe('secure_push_unregister_request');
  const response = builder('createSecurePushUnregisterResponse')(request.id, { success: true });
  expect(response).toMatchObject({
    type: 'secure_push_unregister_response',
    requestId: request.id,
    success: true,
  });
  const failure = builder('createSecurePushUnregisterResponse')(request.id, {
    success: false,
    error: 'STORE_ERROR',
  });
  expect(failure).toMatchObject({ requestId: request.id, success: false, error: 'STORE_ERROR' });
  for (const message of [request, response, failure])
    expect(deserialize(serialize(message as never))).toEqual(message);
});
test('secure subscription direction registry routes only requests to daemon', () => {
  const directions = MESSAGE_DIRECTION as unknown as Record<string, string>;
  for (const op of ['register', 'unregister']) {
    expect(directions[`secure_push_${op}_request`]).toBe('c2d');
    expect(directions[`secure_push_${op}_response`]).toBe('d2c');
  }
});

// #1200 A6: `isValidMessage` used to check only type, id and timestamp for these messages, so
// every consumer that trusts it (the replay path, the web client) saw unvalidated fields. It now
// holds them to the daemon's registration rules.
const field = (message: Record<string, unknown>, key: string, value: unknown) => ({
  ...message,
  [key]: value,
});
function without(message: Record<string, unknown>, key: string) {
  const { [key]: _removed, ...rest } = message;
  return rest;
}
test('shared validator accepts exactly the registration shapes the daemon accepts', () => {
  const request = builder('createSecurePushRegisterRequest')(registration);
  expect(isValidMessage(request)).toBe(true);
  expect(isValidMessage(without(request, 'pushPrefs'))).toBe(true);
  expect(isValidMessage(field(request, 'environment', 'production'))).toBe(true);
  expect(
    isValidMessage(field(request, 'pushPrefs', { turnFailed: false, harnessDenied: true })),
  ).toBe(true);
  expect(isValidMessage(field(request, 'token', 'ab'.repeat(256)))).toBe(true);
  const bad: [string, unknown][] = [
    ['token', ''],
    ['token', 'AB'.repeat(32)],
    ['token', 'abc'],
    ['token', 'ab'.repeat(257)],
    ['token', 7],
    ['environment', 'staging'],
    ['environment', undefined],
    ['pushPublicKey', 'synthetic-test-point'],
    ['pushPublicKey', shared.relayV2.b64u(new Uint8Array(65).fill(4))],
    ['pushPublicKey', shared.relayV2.b64u(new Uint8Array(33))],
    ['pushPublicKey', `${registration.pushPublicKey}=`],
    ['pushPublicKey', 9],
    ['keyVersion', 0],
    ['keyVersion', 1.5],
    ['keyVersion', Number.MAX_SAFE_INTEGER + 1],
    ['keyVersion', '3'],
    ['pushPrefs', { questions: 'yes' }],
    ['pushPrefs', { unknown: true }],
    ['pushPrefs', [true]],
    ['pushPrefs', null],
    ['devicePublicKey', 'caller-selected-identity'],
  ];
  for (const [key, value] of bad)
    expect(isValidMessage(field(request, key, value)), `${key}=${String(value)}`).toBe(false);
  for (const key of ['token', 'environment', 'pushPublicKey', 'keyVersion'])
    expect(isValidMessage(without(request, key)), `missing ${key}`).toBe(false);
  // A point off the curve in its canonical encoding (x = 1, y = 1) is refused like the daemon does.
  const offCurve = new Uint8Array(65);
  offCurve[0] = 4;
  offCurve[32] = 1;
  offCurve[64] = 1;
  expect(isValidMessage(field(request, 'pushPublicKey', shared.relayV2.b64u(offCurve)))).toBe(
    false,
  );
});
test('shared validator holds responses to a typed success or typed error and an exact shape', () => {
  const request = builder('createSecurePushRegisterRequest')(registration);
  const ok = builder('createSecurePushRegisterResponse')(request.id, {
    success: true,
    keyVersion: 3,
  });
  const refused = builder('createSecurePushRegisterResponse')(request.id, {
    success: false,
    error: 'STALE_KEY_VERSION',
  });
  const unregistered = builder('createSecurePushUnregisterResponse')(request.id, { success: true });
  const unregisterFailed = builder('createSecurePushUnregisterResponse')(request.id, {
    success: false,
    error: 'NOT_AUTHORIZED',
  });
  for (const message of [ok, refused, unregistered, unregisterFailed])
    expect(isValidMessage(message), String(message.type)).toBe(true);
  const bad: [Record<string, unknown>, string, unknown][] = [
    [ok, 'keyVersion', 0],
    [ok, 'keyVersion', '3'],
    [ok, 'success', 'true'],
    [ok, 'error', 'NOT_ENROLLED'],
    [refused, 'error', 'WHATEVER'],
    [refused, 'error', undefined],
    [refused, 'keyVersion', 3],
    [refused, 'success', 1],
    [ok, 'requestId', 7],
    [ok, 'requestId', undefined],
    [unregistered, 'keyVersion', 3],
    [unregistered, 'error', 'STORE_ERROR'],
    [unregisterFailed, 'error', 'nope'],
    [unregisterFailed, 'error', undefined],
    [unregisterFailed, 'requestId', undefined],
  ];
  for (const [message, key, value] of bad)
    expect(isValidMessage(field(message, key, value)), `${message.type} ${key}`).toBe(false);
  const unregisterRequest = builder('createSecurePushUnregisterRequest')();
  expect(isValidMessage(unregisterRequest)).toBe(true);
  expect(isValidMessage(field(unregisterRequest, 'devicePublicKey', 'x'))).toBe(false);
});
