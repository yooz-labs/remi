import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  endLogFileSession,
  getLogFd,
  setLogFileContext,
  startLogFileSession,
  writeToLog,
} from '../../src/cli/log-file.ts';

describe('log-file session', () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-log-'));
    // Tests share module state; make sure previous runs aren't leaking.
    endLogFileSession();
  });

  afterEach(() => {
    endLogFileSession();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  test('opens the primary log file and writes the session header', () => {
    const primary = path.join(sandbox, 'remi.log');
    const result = startLogFileSession(primary);
    expect(result.fd).not.toBeNull();
    expect(result.path).toBe(primary);
    expect(result.usedFallback).toBe(false);
    expect(fs.existsSync(primary)).toBe(true);
    const content = fs.readFileSync(primary, 'utf-8');
    expect(content).toMatch(/^\n--- Remi session started at /);
  });

  test('creates the primary log parent directory when absent', () => {
    const primary = path.join(sandbox, 'nested', 'dir', 'remi.log');
    const result = startLogFileSession(primary);
    expect(result.usedFallback).toBe(false);
    expect(fs.existsSync(primary)).toBe(true);
  });

  test('falls back to the fallback dir when primary parent cannot be created', () => {
    // Put a regular file where the primary parent needs to be — mkdirSync will fail.
    const blocker = path.join(sandbox, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');
    const primary = path.join(blocker, 'nested', 'remi.log');
    const result = startLogFileSession(primary, { dir: sandbox, pid: 99999 });
    expect(result.usedFallback).toBe(true);
    const expectedPath = path.join(sandbox, 'remi-99999.log');
    expect(result.path).toBe(expectedPath);
    expect(fs.existsSync(expectedPath)).toBe(true);
    const content = fs.readFileSync(expectedPath, 'utf-8');
    expect(content).toContain('[remi] Primary log file failed:');
  });

  test('returns null fd with no session if both primary and fallback fail', () => {
    const blocker = path.join(sandbox, 'blocker');
    fs.writeFileSync(blocker, 'not a dir');
    const primary = path.join(blocker, 'nested', 'x.log');
    const badFallbackDir = path.join(blocker, 'also-nested');
    const result = startLogFileSession(primary, { dir: badFallbackDir, pid: 1 });
    expect(result.fd).toBeNull();
    expect(result.path).toBeNull();
    expect(result.usedFallback).toBe(true);
    expect(getLogFd()).toBeNull();
  });

  test('writeToLog appends lines with trailing newline', () => {
    const primary = path.join(sandbox, 'remi.log');
    startLogFileSession(primary);
    writeToLog('hello');
    writeToLog('world');
    endLogFileSession();
    const content = fs.readFileSync(primary, 'utf-8');
    expect(content).toContain('\nhello\n');
    expect(content).toContain('\nworld\n');
    expect(content).not.toContain('[pid=');
  });

  test('prefixes lines after a complete context is set', () => {
    const primary = path.join(sandbox, 'remi.log');
    startLogFileSession(primary);
    const sessionId = '12345678-1234-4234-8234-123456789abc';
    setLogFileContext({ port: 18766, sessionId });
    writeToLog('hello');
    endLogFileSession();

    const content = fs.readFileSync(primary, 'utf-8');
    expect(content).toContain(`[pid=${process.pid} port=18766 session=12345678] hello\n`);
    expect(content).not.toContain(sessionId);
  });

  test('updates the port attribution after probing moves the port', () => {
    const primary = path.join(sandbox, 'remi.log');
    startLogFileSession(primary);
    const sessionId = 'abcdefgh-1234-4234-8234-123456789abc';
    setLogFileContext({ port: 18765, sessionId });
    writeToLog('before probe');
    setLogFileContext({ port: 18769, sessionId });
    writeToLog('after probe');
    endLogFileSession();

    const content = fs.readFileSync(primary, 'utf-8');
    expect(content).toContain(`[pid=${process.pid} port=18765 session=abcdefgh] before probe\n`);
    expect(content).toContain(`[pid=${process.pid} port=18769 session=abcdefgh] after probe\n`);
  });

  test('prefixes every line in a multi-line message', () => {
    const primary = path.join(sandbox, 'remi.log');
    startLogFileSession(primary);
    setLogFileContext({ port: 18766, sessionId: 'multiline-session-id' });
    writeToLog('first\nsecond\nthird');
    endLogFileSession();

    const prefix = `[pid=${process.pid} port=18766 session=multilin]`;
    const content = fs.readFileSync(primary, 'utf-8');
    expect(content).toContain(`${prefix} first\n${prefix} second\n${prefix} third\n`);
  });

  test('clears context when ending the log session', () => {
    const primary = path.join(sandbox, 'remi.log');
    startLogFileSession(primary);
    setLogFileContext({ port: 18766, sessionId: 'old-session-id' });
    writeToLog('old session');
    endLogFileSession();

    startLogFileSession(primary);
    writeToLog('new session');
    endLogFileSession();

    const content = fs.readFileSync(primary, 'utf-8');
    expect(content).toContain(`[pid=${process.pid} port=18766 session=old-sess] old session\n`);
    expect(content).toContain('\nnew session\n');
    expect(content).not.toContain(`[pid=${process.pid} port=18766 session=old-sess] new session`);
  });

  test('writeToLog is a silent no-op with no open session', () => {
    expect(() => writeToLog('nothing')).not.toThrow();
  });

  test('endLogFileSession is idempotent', () => {
    const primary = path.join(sandbox, 'remi.log');
    startLogFileSession(primary);
    endLogFileSession();
    endLogFileSession();
    expect(getLogFd()).toBeNull();
  });

  test('getLogFd returns the current fd or null', () => {
    const primary = path.join(sandbox, 'remi.log');
    expect(getLogFd()).toBeNull();
    const result = startLogFileSession(primary);
    expect(getLogFd()).toBe(result.fd);
  });

  test('rotates an oversized primary log before opening a fresh one', () => {
    const primary = path.join(sandbox, 'remi.log');
    // Genuinely exceed the default 10MB rotation threshold so the real
    // startLogFileSession -> rotateIfNeeded call (no override) fires.
    fs.writeFileSync(primary, Buffer.alloc(10 * 1024 * 1024 + 1, 'x'));

    const result = startLogFileSession(primary);
    expect(result.fd).not.toBeNull();
    expect(result.path).toBe(primary);

    // Old oversized content moved to the .1 backup.
    expect(fs.existsSync(`${primary}.1`)).toBe(true);
    expect(fs.statSync(`${primary}.1`).size).toBe(10 * 1024 * 1024 + 1);

    // Fresh primary only has the new session header, not the old bulk.
    const freshContent = fs.readFileSync(primary, 'utf-8');
    expect(freshContent).toMatch(/^\n--- Remi session started at /);
    expect(freshContent.length).toBeLessThan(1024);
  });

  test('startLogFileSession without fallback returns null fd on failure', () => {
    const blocker = path.join(sandbox, 'blocker2');
    fs.writeFileSync(blocker, 'not a dir');
    const primary = path.join(blocker, 'x.log');
    const result = startLogFileSession(primary);
    expect(result.fd).toBeNull();
    expect(result.usedFallback).toBe(false);
    expect(result.primaryError).toBeDefined();
  });
});
