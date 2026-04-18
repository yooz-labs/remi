import { afterEach, describe, expect, test } from 'bun:test';
import {
  __resetLoggerForTests,
  configureLogger,
  isWrapperMode,
  log,
  logError,
  setWrapperMode,
} from '../../src/cli/logger.ts';

describe('logger', () => {
  afterEach(() => {
    __resetLoggerForTests();
  });

  test('defaults to wrapper mode', () => {
    expect(isWrapperMode()).toBe(true);
  });

  test('setWrapperMode toggles state', () => {
    setWrapperMode(false);
    expect(isWrapperMode()).toBe(false);
    setWrapperMode(true);
    expect(isWrapperMode()).toBe(true);
  });

  test('log writes to injected writer in wrapper mode', () => {
    const captured: string[] = [];
    configureLogger({ writeLog: (msg) => captured.push(msg) });
    log('hello', 'world', 42);
    expect(captured).toEqual(['hello world 42']);
  });

  test('logError prefixes [error] in wrapper mode', () => {
    const captured: string[] = [];
    configureLogger({ writeLog: (msg) => captured.push(msg) });
    logError('something', 'failed');
    expect(captured).toEqual(['[error] something failed']);
  });

  test('log routes to console when not wrapper mode', () => {
    const logCalls: unknown[][] = [];
    const errCalls: unknown[][] = [];
    configureLogger({
      writeLog: () => {
        throw new Error('writer should not be called when wrapperMode=false');
      },
      consoleLog: (...args) => logCalls.push(args),
      consoleError: (...args) => errCalls.push(args),
    });
    setWrapperMode(false);

    log('a', 'b');
    logError('boom');

    expect(logCalls).toEqual([['a', 'b']]);
    expect(errCalls).toEqual([['boom']]);
  });

  test('stringifies non-string args in wrapper mode', () => {
    const captured: string[] = [];
    configureLogger({ writeLog: (msg) => captured.push(msg) });
    log({ a: 1 }, null, undefined, 3.14);
    expect(captured[0]).toBe('[object Object] null undefined 3.14');
  });
});
