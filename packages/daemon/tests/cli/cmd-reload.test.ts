import { describe, expect, test } from 'bun:test';
import { runReloadCommand } from '../../src/cli/cmd-reload.ts';

function makeIO() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (msg: string) => out.push(msg), err: (msg: string) => err.push(msg) },
    out,
    err,
  };
}

function mkSession(name: string, pid: number, wsPort: number) {
  return { name, pid, wsPort };
}

describe('runReloadCommand', () => {
  test('exits 1 and logs an error when no daemons are running', () => {
    const { io, out, err } = makeIO();
    const code = runReloadCommand(io, { listLive: () => [], kill: () => {} });
    expect(code).toBe(1);
    expect(out).toHaveLength(0);
    expect(err).toEqual(['No running daemons found.']);
  });

  test('signals every live daemon and reports success count', () => {
    const killCalls: Array<[number, NodeJS.Signals]> = [];
    const { io, out, err } = makeIO();
    const code = runReloadCommand(io, {
      listLive: () => [mkSession('alpha', 100, 18765), mkSession('beta', 101, 18766)],
      kill: (pid, sig) => {
        killCalls.push([pid, sig]);
      },
    });
    expect(code).toBe(0);
    expect(killCalls).toEqual([
      [100, 'SIGUSR1'],
      [101, 'SIGUSR1'],
    ]);
    expect(out.some((m) => m.includes('Reloaded 2 daemon(s).'))).toBe(true);
    expect(err).toHaveLength(0);
  });

  test('handles ESRCH (stale pid) separately from other errors', () => {
    const { io, out, err } = makeIO();
    const kill = (pid: number) => {
      if (pid === 100) {
        const e = new Error('no such process') as NodeJS.ErrnoException;
        e.code = 'ESRCH';
        throw e;
      }
      // pid 101 succeeds
    };
    const code = runReloadCommand(io, {
      listLive: () => [mkSession('stale', 100, 18765), mkSession('live', 101, 18766)],
      kill,
    });
    expect(code).toBe(0); // at least one succeeded
    expect(err).toEqual(['Process 100 not found (stale session entry)']);
    expect(out.some((m) => m.includes('Sent reload signal to live'))).toBe(true);
    expect(out.some((m) => m.includes('Reloaded 1 daemon(s).'))).toBe(true);
  });

  test('exits 1 when all daemons are stale', () => {
    const { io, out, err } = makeIO();
    const kill = () => {
      const e = new Error('no such process') as NodeJS.ErrnoException;
      e.code = 'ESRCH';
      throw e;
    };
    const code = runReloadCommand(io, {
      listLive: () => [mkSession('stale', 100, 18765)],
      kill,
    });
    expect(code).toBe(1);
    expect(out).toHaveLength(0);
    expect(err.some((m) => m.includes('Failed to reload any daemons'))).toBe(true);
  });

  test('reports non-ESRCH errors with errorToString wrapping', () => {
    const { io, out, err } = makeIO();
    const kill = () => {
      throw new Error('permission denied');
    };
    const code = runReloadCommand(io, {
      listLive: () => [mkSession('locked', 100, 18765)],
      kill,
    });
    expect(code).toBe(1);
    expect(err.some((m) => m.includes('Failed to signal PID 100: permission denied'))).toBe(true);
    expect(out).toHaveLength(0);
  });
});
