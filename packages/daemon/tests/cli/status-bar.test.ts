import { describe, expect, test } from 'bun:test';
import {
  MAX_RENDER_ERRORS,
  MIN_ROWS_FOR_BAR,
  StatusBar,
  type StatusBarDeps,
  buildBarSequence,
  buildClearSequence,
  childRows,
  formatStatusBar,
} from '../../src/cli/status-bar.ts';
import type { RemiStatus } from '../../src/cli/status-writer.ts';

const NOW_MS = 1_000_000_000; // fixed clock; NOW_MS/1000 = 1_000_000 s
const NOW_S = Math.floor(NOW_MS / 1000);

function mkStatus(overrides: Partial<RemiStatus> = {}): RemiStatus {
  return {
    pid: 123,
    connections: 0,
    sessionStatus: 'idle',
    adapters: [],
    wsPort: 19924,
    sessionId: null,
    repo: 'remi',
    branch: 'develop',
    autoApprove: { inFlight: 0, sinceS: 0, lastVerdict: 'none', lastVerdictAtS: 0 },
    ...overrides,
  };
}

describe('childRows', () => {
  test('reserves one row when reserve is on and there is room', () => {
    expect(childRows(40, true)).toBe(39);
    expect(childRows(MIN_ROWS_FOR_BAR, true)).toBe(MIN_ROWS_FOR_BAR - 1);
  });

  test('gives every row to the child when reserve is off', () => {
    expect(childRows(40, false)).toBe(40);
  });

  test('does not reserve when the terminal is too short', () => {
    expect(childRows(1, true)).toBe(1);
    expect(childRows(0, true)).toBe(0);
  });
});

describe('formatStatusBar', () => {
  test('idle shows the session status as the state', () => {
    const out = formatStatusBar(mkStatus({ sessionStatus: 'thinking' }), NOW_MS);
    expect(out).toBe('remi:19924 remi:develop | no clients | thinking');
  });

  test('client count pluralizes', () => {
    expect(formatStatusBar(mkStatus({ connections: 2 }), NOW_MS)).toContain('| 2 client(s) |');
    expect(formatStatusBar(mkStatus({ connections: 0 }), NOW_MS)).toContain('| no clients |');
  });

  test('in-flight eval shows evaluating with elapsed seconds', () => {
    const status = mkStatus({
      autoApprove: { inFlight: 1, sinceS: NOW_S - 3, lastVerdict: 'none', lastVerdictAtS: 0 },
    });
    expect(formatStatusBar(status, NOW_MS)).toContain('| evaluating 3s');
  });

  test('a stuck eval past the cap falls back to the session status', () => {
    const status = mkStatus({
      sessionStatus: 'idle',
      autoApprove: { inFlight: 1, sinceS: NOW_S - 601, lastVerdict: 'none', lastVerdictAtS: 0 },
    });
    expect(formatStatusBar(status, NOW_MS)).toContain('| idle');
    expect(formatStatusBar(status, NOW_MS)).not.toContain('evaluating');
  });

  test('a fresh escalate shows needs you', () => {
    const status = mkStatus({
      autoApprove: { inFlight: 0, sinceS: 0, lastVerdict: 'escalated', lastVerdictAtS: NOW_S - 10 },
    });
    expect(formatStatusBar(status, NOW_MS)).toContain('| needs you');
  });

  test('an escalate older than the fresh window decays to the session status', () => {
    const status = mkStatus({
      sessionStatus: 'idle',
      autoApprove: { inFlight: 0, sinceS: 0, lastVerdict: 'escalated', lastVerdictAtS: NOW_S - 61 },
    });
    expect(formatStatusBar(status, NOW_MS)).not.toContain('needs you');
    expect(formatStatusBar(status, NOW_MS)).toContain('| idle');
  });

  test('a fresh approve shows approved, then fades', () => {
    const fresh = mkStatus({
      autoApprove: { inFlight: 0, sinceS: 0, lastVerdict: 'approved', lastVerdictAtS: NOW_S - 2 },
    });
    expect(formatStatusBar(fresh, NOW_MS)).toContain('| approved');
    const faded = mkStatus({
      sessionStatus: 'idle',
      autoApprove: { inFlight: 0, sinceS: 0, lastVerdict: 'approved', lastVerdictAtS: NOW_S - 6 },
    });
    expect(formatStatusBar(faded, NOW_MS)).not.toContain('approved');
  });

  test('omits the repo:branch chunk when repo is empty', () => {
    const out = formatStatusBar(mkStatus({ repo: '', branch: '' }), NOW_MS);
    expect(out).toBe('remi:19924 | no clients | idle');
  });

  test('in-flight wins over a stale verdict', () => {
    const status = mkStatus({
      autoApprove: {
        inFlight: 1,
        sinceS: NOW_S - 1,
        lastVerdict: 'escalated',
        lastVerdictAtS: NOW_S - 5,
      },
    });
    expect(formatStatusBar(status, NOW_MS)).toContain('evaluating 1s');
    expect(formatStatusBar(status, NOW_MS)).not.toContain('needs you');
  });
});

describe('buildBarSequence', () => {
  test('brackets the draw with save/restore and positions the reserved row', () => {
    const seq = buildBarSequence(40, 20, 'hi');
    expect(seq.startsWith('\x1b7')).toBe(true); // DECSC
    expect(seq.endsWith('\x1b8')).toBe(true); // DECRC
    expect(seq).toContain('\x1b[?6l'); // origin mode off
    expect(seq).toContain('\x1b[1;39r'); // DECSTBM: scroll region rows 1..39
    expect(seq).toContain('\x1b[40;1H'); // CUP to row 40
    expect(seq).toContain('\x1b[2K'); // erase line
    expect(seq).toContain('\x1b[7m'); // reverse video
    expect(seq).toContain('\x1b[0m'); // reset
  });

  test('sets the scroll region to exclude exactly the bar row', () => {
    // 24-row terminal -> region 1..23, bar on row 24.
    expect(buildBarSequence(24, 80, 'x')).toContain('\x1b[1;23r');
  });

  test('pads the content to the full width', () => {
    const seq = buildBarSequence(5, 10, 'abc');
    expect(seq).toContain('abc       '); // 'abc' + 7 spaces = width 10
  });

  test('truncates content longer than the width', () => {
    const seq = buildBarSequence(5, 4, 'abcdefgh');
    expect(seq).toContain('abcd');
    expect(seq).not.toContain('abcde');
  });
});

describe('buildClearSequence', () => {
  test('resets the scroll region and erases the reserved row, bracketed by save/restore', () => {
    const seq = buildClearSequence(24);
    expect(seq).toBe('\x1b7\x1b[?6l\x1b[r\x1b[24;1H\x1b[2K\x1b8');
  });
});

describe('StatusBar', () => {
  function harness(overrides: Partial<StatusBarDeps> = {}) {
    const writes: string[] = [];
    const logs: string[] = [];
    const deps: StatusBarDeps = {
      getStdoutFd: () => 1,
      getStatus: () => mkStatus(),
      getSize: () => ({ cols: 80, rows: 24 }),
      isEnabled: () => true,
      writeToFd: (_fd, data) => writes.push(data),
      now: () => NOW_MS,
      log: (m) => logs.push(m),
      intervalMs: 5,
      ...overrides,
    };
    return { bar: new StatusBar(deps), writes, logs };
  }

  test('render writes the bar when enabled with an fd and room', () => {
    const { bar, writes } = harness();
    bar.render();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('\x1b[24;1H');
  });

  test('render no-ops when disabled', () => {
    const { bar, writes } = harness({ isEnabled: () => false });
    bar.render();
    expect(writes).toHaveLength(0);
  });

  test('render no-ops when the wrapper has detached (null fd)', () => {
    const { bar, writes } = harness({ getStdoutFd: () => null });
    bar.render();
    expect(writes).toHaveLength(0);
  });

  test('render no-ops when the terminal is too short to spare a row', () => {
    const { bar, writes } = harness({ getSize: () => ({ cols: 80, rows: 1 }) });
    bar.render();
    expect(writes).toHaveLength(0);
  });

  test('start paints immediately and stop clears the row', () => {
    const { bar, writes } = harness();
    bar.start();
    expect(writes).toHaveLength(1); // immediate paint
    bar.stop();
    // stop() emits a clear sequence for the reserved row
    expect(writes).toHaveLength(2);
    expect(writes[1]).toBe(buildClearSequence(24));
  });

  test('start is idempotent', () => {
    const { bar, writes } = harness();
    bar.start();
    bar.start();
    expect(writes).toHaveLength(1); // second start does not repaint
    bar.stop();
  });

  test('the timer repaints on its interval', async () => {
    const { bar, writes } = harness();
    bar.start();
    await new Promise((r) => setTimeout(r, 30)); // a few 5ms ticks
    bar.stop();
    expect(writes.length).toBeGreaterThan(2);
  });

  test('a persistent render error never throws, logs once, and backs off after the threshold', async () => {
    let calls = 0;
    const { bar, writes, logs } = harness({
      writeToFd: () => {
        calls += 1;
        throw new Error('EIO');
      },
    });
    expect(() => bar.start()).not.toThrow();
    await new Promise((r) => setTimeout(r, 60)); // well past MAX_RENDER_ERRORS ticks
    // Backed off after MAX consecutive failures, then stopped retrying.
    expect(calls).toBe(MAX_RENDER_ERRORS);
    expect(writes).toHaveLength(0); // the throwing write never records a paint
    expect(logs).toHaveLength(1); // first failure of the streak only
    const settled = calls;
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(settled); // no further attempts once disabled
    bar.stop();
  });

  test('a transient render error does not disable the bar', async () => {
    let attempts = 0;
    const painted: string[] = [];
    const { bar, logs } = harness({
      writeToFd: (_fd, data) => {
        attempts += 1;
        if (attempts === 1) throw new Error('EINTR'); // one transient blip
        painted.push(data);
      },
    });
    bar.start();
    await new Promise((r) => setTimeout(r, 40)); // several ticks past the blip
    // The streak reset on the first success, so the bar kept painting and never
    // backed off. The single failure logged exactly once.
    expect(painted.length).toBeGreaterThan(0);
    expect(logs).toHaveLength(1);
    bar.stop();
  });
});
