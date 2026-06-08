import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  SPINNER_FRAMES,
  type TerminalCueConfig,
  TerminalIndicator,
  createTerminalIndicator,
  osc9Notify,
  osc777Notify,
  oscTitle,
  wrapTmuxPassthrough,
} from '../../src/cli/terminal-indicator.ts';
import { __resetWrapperStateForTests, setPtyStdoutFd } from '../../src/cli/wrapper-state.ts';

const ESC = '\x1b';
const BEL = '\x07';

// ---------------------------------------------------------------------------
// OSC builders (pure)
// ---------------------------------------------------------------------------
describe('OSC builders', () => {
  test('oscTitle wraps OSC 2', () => {
    expect(oscTitle('hello')).toBe(`${ESC}]2;hello${BEL}`);
  });
  test('osc9Notify wraps OSC 9', () => {
    expect(osc9Notify('ping')).toBe(`${ESC}]9;ping${BEL}`);
  });
  test('osc777Notify wraps OSC 777 with title;body', () => {
    expect(osc777Notify('T', 'B')).toBe(`${ESC}]777;notify;T;B${BEL}`);
  });
  test('sanitize strips control bytes (no sequence break-out)', () => {
    // A crafted title containing BEL/ESC must not terminate the OSC early.
    const out = oscTitle(`a${BEL}b${ESC}c`);
    expect(out).toBe(`${ESC}]2;a b c${BEL}`);
  });
  test('wrapTmuxPassthrough doubles inner ESC and brackets with DCS', () => {
    expect(wrapTmuxPassthrough(`${ESC}]2;x${BEL}`)).toBe(
      `${ESC}Ptmux;${ESC}${ESC}${ESC}]2;x${BEL}${ESC}\\`,
    );
  });
});

// ---------------------------------------------------------------------------
// Deterministic lifecycle (injected timers — real recording functions, no mocks)
// ---------------------------------------------------------------------------
interface Harness {
  ind: TerminalIndicator;
  out: string[];
  tickSpinner: () => void;
  fireLinger: () => void;
  spinnerRunning: () => boolean;
}

function makeHarness(config: TerminalCueConfig, opts?: { tmux?: boolean }): Harness {
  const out: string[] = [];
  let intervalCb: (() => void) | null = null;
  let timeoutCb: (() => void) | null = null;
  const ind = new TerminalIndicator({
    write: (s) => out.push(s),
    config,
    idleTitle: 'proj',
    tmux: opts?.tmux ?? false,
    setIntervalFn: (cb) => {
      intervalCb = cb;
      return 1 as unknown as ReturnType<typeof setInterval>;
    },
    clearIntervalFn: () => {
      intervalCb = null;
    },
    setTimeoutFn: (cb) => {
      timeoutCb = cb;
      return 2 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeoutFn: () => {
      timeoutCb = null;
    },
  });
  return {
    ind,
    out,
    tickSpinner: () => intervalCb?.(),
    fireLinger: () => timeoutCb?.(),
    spinnerRunning: () => intervalCb !== null,
  };
}

const FULL: TerminalCueConfig = { notify: 'osc9', statusCue: true };

describe('TerminalIndicator lifecycle', () => {
  test('start renders frame 0 then animates on tick', () => {
    const h = makeHarness(FULL);
    h.ind.start();
    expect(h.out.at(-1)).toBe(oscTitle(`${SPINNER_FRAMES[0]} Remi · evaluating…`));
    h.tickSpinner();
    expect(h.out.at(-1)).toBe(oscTitle(`${SPINNER_FRAMES[1]} Remi · evaluating…`));
    expect(h.spinnerRunning()).toBe(true);
  });

  test('start writes nothing when statusCue is off', () => {
    const h = makeHarness({ notify: 'osc9', statusCue: false });
    h.ind.start();
    expect(h.out).toHaveLength(0);
    expect(h.spinnerRunning()).toBe(false);
  });

  test('resolve(handled) stops spinner, shows check, then restores idle after linger', () => {
    const h = makeHarness(FULL);
    h.ind.start();
    h.ind.resolve('handled');
    expect(h.spinnerRunning()).toBe(false);
    expect(h.out.at(-1)).toBe(oscTitle('✓ Remi'));
    h.fireLinger();
    expect(h.out.at(-1)).toBe(oscTitle('proj'));
  });

  test('resolve(escalate) stops spinner, shows warning, fires osc9 notification', () => {
    const h = makeHarness(FULL);
    h.ind.start();
    const before = h.out.length;
    h.ind.resolve('escalate');
    expect(h.spinnerRunning()).toBe(false);
    const emitted = h.out.slice(before);
    expect(emitted).toContain(oscTitle('⚠ Remi · needs you'));
    expect(emitted).toContain(osc9Notify('Remi: A permission needs your approval'));
  });

  test('escalate does not auto-restore the idle title (persists as the cue)', () => {
    const h = makeHarness(FULL);
    h.ind.start();
    h.ind.resolve('escalate');
    // No linger timeout was scheduled, so nothing restores the title.
    expect(h.out.at(-1)).not.toBe(oscTitle('proj'));
  });

  test('notify=osc777 fires the OSC 777 notification', () => {
    const h = makeHarness({ notify: 'osc777', statusCue: true });
    h.ind.start();
    h.ind.resolve('escalate');
    expect(h.out).toContain(osc777Notify('Remi', 'A permission needs your approval'));
  });

  test('notify=bell fires a bare BEL', () => {
    const h = makeHarness({ notify: 'bell', statusCue: true });
    h.ind.start();
    h.ind.resolve('escalate');
    expect(h.out).toContain(BEL);
  });

  test('notify=off emits the warning title but no notification', () => {
    const h = makeHarness({ notify: 'off', statusCue: true });
    h.ind.start();
    const before = h.out.length;
    h.ind.resolve('escalate');
    const emitted = h.out.slice(before);
    expect(emitted).toEqual([oscTitle('⚠ Remi · needs you')]);
  });

  test('statusCue off + escalate fires only the notification (no title writes)', () => {
    const h = makeHarness({ notify: 'osc9', statusCue: false });
    h.ind.resolve('escalate');
    expect(h.out).toEqual([osc9Notify('Remi: A permission needs your approval')]);
  });

  test('stop restores idle title and clears the spinner', () => {
    const h = makeHarness(FULL);
    h.ind.start();
    h.ind.stop();
    expect(h.spinnerRunning()).toBe(false);
    expect(h.out.at(-1)).toBe(oscTitle('proj'));
  });

  test('tmux mode wraps every sequence in passthrough', () => {
    const h = makeHarness(FULL, { tmux: true });
    h.ind.start();
    expect(h.out.at(-1)).toBe(
      wrapTmuxPassthrough(oscTitle(`${SPINNER_FRAMES[0]} Remi · evaluating…`)),
    );
  });

  test('dispose clears a running spinner', () => {
    const h = makeHarness(FULL);
    h.ind.start();
    h.ind.dispose();
    expect(h.spinnerRunning()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Production writer (real fd -> temp file; verifies the guard + real bytes)
// ---------------------------------------------------------------------------
describe('createTerminalIndicator production writer', () => {
  afterEach(() => __resetWrapperStateForTests());

  test('no-ops when no terminal fd is attached (headless)', () => {
    __resetWrapperStateForTests(); // fd = null
    const ind = createTerminalIndicator({ notify: 'osc9', statusCue: true }, '/tmp/proj');
    // Must not throw despite there being no terminal.
    expect(() => {
      ind.start();
      ind.resolve('escalate');
      ind.dispose();
    }).not.toThrow();
  });

  test('writes real OSC bytes to the attached terminal fd', () => {
    const file = path.join(os.tmpdir(), `remi-term-${process.pid}-${Date.now()}.out`);
    const fd = fs.openSync(file, 'w');
    try {
      setPtyStdoutFd(fd);
      const ind = createTerminalIndicator({ notify: 'osc9', statusCue: true }, '/tmp/myproj');
      ind.resolve('escalate');
      ind.dispose();
      fs.fsyncSync(fd);
      const written = fs.readFileSync(file, 'utf-8');
      expect(written).toContain(oscTitle('⚠ Remi · needs you'));
      expect(written).toContain(osc9Notify('Remi: A permission needs your approval'));
    } finally {
      fs.closeSync(fd);
      fs.rmSync(file, { force: true });
    }
  });

  test('derives the idle title from the working directory basename', () => {
    const file = path.join(os.tmpdir(), `remi-term-idle-${process.pid}-${Date.now()}.out`);
    const fd = fs.openSync(file, 'w');
    try {
      setPtyStdoutFd(fd);
      const ind = createTerminalIndicator(
        { notify: 'off', statusCue: true },
        '/home/dev/cool-project',
      );
      ind.stop();
      fs.fsyncSync(fd);
      expect(fs.readFileSync(file, 'utf-8')).toContain(oscTitle('cool-project'));
    } finally {
      fs.closeSync(fd);
      fs.rmSync(file, { force: true });
    }
  });
});
