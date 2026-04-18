import { afterEach, describe, expect, test } from 'bun:test';
import type { UUID } from '@remi/shared';
import {
  __resetSessionStateForTests,
  getPrimarySessionId,
  setPrimarySessionId,
} from '../../src/cli/session-state.ts';

describe('session-state', () => {
  afterEach(() => {
    __resetSessionStateForTests();
  });

  test('defaults to null', () => {
    expect(getPrimarySessionId()).toBeNull();
  });

  test('setPrimarySessionId stores the id', () => {
    const id = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789' as UUID;
    setPrimarySessionId(id);
    expect(getPrimarySessionId()).toBe(id);
  });

  test('setPrimarySessionId(null) clears it', () => {
    setPrimarySessionId('deadbeef-0000-0000-0000-000000000000' as UUID);
    setPrimarySessionId(null);
    expect(getPrimarySessionId()).toBeNull();
  });

  test('later writes overwrite earlier values', () => {
    const first = '11111111-1111-1111-1111-111111111111' as UUID;
    const second = '22222222-2222-2222-2222-222222222222' as UUID;
    setPrimarySessionId(first);
    setPrimarySessionId(second);
    expect(getPrimarySessionId()).toBe(second);
  });

  test('module state survives across getter calls (singleton)', () => {
    const id = '33333333-3333-3333-3333-333333333333' as UUID;
    setPrimarySessionId(id);
    expect(getPrimarySessionId()).toBe(id);
    expect(getPrimarySessionId()).toBe(id);
  });
});
