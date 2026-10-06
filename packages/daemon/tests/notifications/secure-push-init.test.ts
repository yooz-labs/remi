import { expect, test } from 'bun:test';
import { initFailureClass } from '../../src/notifications/secure-push-service.ts';

test('an init failure is logged by class: a fixed code or a type name, never message text (#1200, B5)', () => {
  expect(initFailureClass(new Error('SECURE_PUSH_CAPACITY_CONFIG'))).toBe(
    'SECURE_PUSH_CAPACITY_CONFIG',
  );
  expect(initFailureClass(new TypeError('/Users/PRIVATE_PATH/key.pem is not a key'))).toBe(
    'TypeError',
  );
  expect(initFailureClass(new Error('PRIVATE sentence with spaces'))).toBe('UNKNOWN');
  expect(initFailureClass('PRIVATE_STRING_SENTINEL')).toBe('UNKNOWN');
  expect(initFailureClass(undefined)).toBe('UNKNOWN');
});
