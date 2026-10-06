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
// the web client saw unvalidated response fields. Responses now need a typed success or error.
const field = (message: Record<string, unknown>, key: string, value: unknown) => ({
  ...message,
  [key]: value,
});
function without(message: Record<string, unknown>, key: string) {
  const { [key]: _removed, ...rest } = message;
  return rest;
}
test('shared validator accepts the registration and unregister requests the daemon accepts', () => {
  // The requests are validated by the daemon's normalizeSecureRegistration, which answers a typed
  // INVALID_SUBSCRIPTION; `isValidMessage` stays envelope-level for them on purpose (#1200).
  const request = builder('createSecurePushRegisterRequest')(registration);
  expect(isValidMessage(request)).toBe(true);
  expect(isValidMessage(without(request, 'pushPrefs'))).toBe(true);
  expect(isValidMessage(builder('createSecurePushUnregisterRequest')())).toBe(true);
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
    expect(isValidMessage(message), String(message['type'])).toBe(true);
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
    expect(isValidMessage(field(message, key, value)), `${String(message['type'])} ${key}`).toBe(
      false,
    );
});
