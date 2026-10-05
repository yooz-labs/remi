import { expect, test } from 'bun:test';
import * as shared from '../src/index.ts';
import { MESSAGE_DIRECTION, deserialize, serialize } from '../src/protocol.ts';

function builder(
  name: string,
): (...args: unknown[]) => shared.ProtocolMessage & Record<string, unknown> {
  const fn = (shared as unknown as Record<string, unknown>)[name];
  expect(typeof fn, `actual secure subscription factory ${name} must exist`).toBe('function');
  return fn as (...args: unknown[]) => shared.ProtocolMessage & Record<string, unknown>;
}
const registration = {
  token: 'ab'.repeat(32),
  environment: 'sandbox',
  pushPublicKey: 'synthetic-test-point',
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
