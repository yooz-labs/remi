import { describe, expect, test } from 'bun:test';
import { runUnstickCommand } from '../../src/cli/cmd-unstick.ts';

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

describe('runUnstickCommand (#617)', () => {
  test('exits 1 and logs an error when no daemons are running', () => {
    const { io, out, err } = makeIO();
    const code = runUnstickCommand(undefined, io, { listLive: () => [], kill: () => {} });
    expect(code).toBe(1);
    expect(out).toHaveLength(0);
    expect(err).toEqual(['No running daemons found.']);
  });

  test('SIGUSR2s every live daemon when no port is given', () => {
    const killCalls: Array<[number, NodeJS.Signals]> = [];
    const { io, out, err } = makeIO();
    const code = runUnstickCommand(undefined, io, {
      listLive: () => [mkSession('alpha', 100, 18765), mkSession('beta', 101, 18766)],
      kill: (pid, sig) => {
        killCalls.push([pid, sig]);
      },
    });
    expect(code).toBe(0);
    expect(killCalls).toEqual([
      [100, 'SIGUSR2'],
      [101, 'SIGUSR2'],
    ]);
    expect(
      out.some((m) => m.includes('Unstuck 1 daemon(s)') || m.includes('Unstuck 2 daemon(s)')),
    ).toBe(true);
    expect(err).toHaveLength(0);
  });

  test('targets only the daemon on the given port', () => {
    const killCalls: number[] = [];
    const { io, out } = makeIO();
    const code = runUnstickCommand(18766, io, {
      listLive: () => [mkSession('alpha', 100, 18765), mkSession('beta', 101, 18766)],
      kill: (pid) => {
        killCalls.push(pid);
      },
    });
    expect(code).toBe(0);
    expect(killCalls).toEqual([101]); // only the 18766 daemon
    expect(out.some((m) => m.includes('port 18766'))).toBe(true);
  });

  test('exits 1 with a port-specific message when no daemon matches the port', () => {
    const { io, err } = makeIO();
    const code = runUnstickCommand(19999, io, {
      listLive: () => [mkSession('alpha', 100, 18765)],
      kill: () => {},
    });
    expect(code).toBe(1);
    expect(err).toEqual(['No running daemon found on port 19999.']);
  });

  test('handles ESRCH (stale pid) separately from other errors', () => {
    const { io, err } = makeIO();
    const kill = (pid: number) => {
      if (pid === 100) {
        const e = new Error('no such process') as NodeJS.ErrnoException;
        e.code = 'ESRCH';
        throw e;
      }
    };
    const code = runUnstickCommand(undefined, io, {
      listLive: () => [mkSession('stale', 100, 18765), mkSession('live', 101, 18766)],
      kill,
    });
    expect(code).toBe(0); // at least one succeeded
    expect(err).toEqual(['Process 100 not found (stale session entry)']);
  });

  test('exits 1 when every matching daemon is stale', () => {
    const { io, err } = makeIO();
    const kill = () => {
      const e = new Error('no such process') as NodeJS.ErrnoException;
      e.code = 'ESRCH';
      throw e;
    };
    const code = runUnstickCommand(undefined, io, {
      listLive: () => [mkSession('stale', 100, 18765)],
      kill,
    });
    expect(code).toBe(1);
    expect(err.some((m) => m.includes('Failed to unstick any daemons'))).toBe(true);
  });
});
