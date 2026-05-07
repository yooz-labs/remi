import { afterEach, describe, expect, test } from 'bun:test';
import {
  __resetWrapperStateForTests,
  getPtyStdoutFd,
  isWrapperDetached,
  setPtyStdoutFd,
  setWrapperDetached,
} from '../../src/cli/wrapper-state.ts';

describe('wrapper-state', () => {
  afterEach(() => {
    __resetWrapperStateForTests();
  });

  test('defaults: stdout fd is null, detached is false', () => {
    expect(getPtyStdoutFd()).toBeNull();
    expect(isWrapperDetached()).toBe(false);
  });

  test('setPtyStdoutFd round-trips a fd and can be cleared', () => {
    setPtyStdoutFd(1);
    expect(getPtyStdoutFd()).toBe(1);
    setPtyStdoutFd(null);
    expect(getPtyStdoutFd()).toBeNull();
  });

  test('setWrapperDetached flips the flag both ways', () => {
    setWrapperDetached(true);
    expect(isWrapperDetached()).toBe(true);
    setWrapperDetached(false);
    expect(isWrapperDetached()).toBe(false);
  });

  test('state is shared across getter invocations (singleton)', () => {
    setPtyStdoutFd(2);
    setWrapperDetached(true);
    expect(getPtyStdoutFd()).toBe(2);
    expect(getPtyStdoutFd()).toBe(2);
    expect(isWrapperDetached()).toBe(true);
    expect(isWrapperDetached()).toBe(true);
  });
});
