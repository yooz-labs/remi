import { describe, expect, test } from 'bun:test';
import { PtyQuiescenceGate } from '../../src/cli/pty-quiescence-gate.ts';
import {
  HEARTBEAT_MS,
  MAX_RENDER_ERRORS,
  MIN_ROWS_FOR_BAR,
  StatusBar,
  type StatusBarDeps,
  buildBarSequence,
  buildClearSequence,
  childRows,
  formatStatusBar,
} from '../../src/cli/status-bar.ts';
import { ESCALATE_FRESH_S, type RemiStatus } from '../../src/cli/status-writer.ts';

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

  test('client count pluralizes (legacy fallback: no attach fields on the status)', () => {
    expect(formatStatusBar(mkStatus({ connections: 2 }), NOW_MS)).toContain('| 2 client(s) |');
    expect(formatStatusBar(mkStatus({ connections: 0 }), NOW_MS)).toContain('| no clients |');
  });

  // #755: with attach fields present, the label reads the REAL attach state
  // (exclusive PTY slot + FIFO queue), never the raw connection counter,
  // which also counts query-mode utility clients (remi ls / kill / polls).
  test('attached session reads "attached", not a connection count', () => {
    const out = formatStatusBar(
      mkStatus({ connections: 3, attached: true, queuedCount: 0 }),
      NOW_MS,
    );
    expect(out).toContain('| attached |');
    expect(out).not.toContain('client(s)');
  });

  test('attached with queued viewers reads "attached (+N waiting)"', () => {
    expect(
      formatStatusBar(mkStatus({ connections: 3, attached: true, queuedCount: 2 }), NOW_MS),
    ).toContain('| attached (+2 waiting) |');
  });

  test('not attached: queued-only shows "N waiting"; none shows "no clients" even with query connections', () => {
    expect(
      formatStatusBar(mkStatus({ connections: 2, attached: false, queuedCount: 1 }), NOW_MS),
    ).toContain('| 1 waiting |');
    // A `remi ls` poll bumped connections but nothing is attached or queued:
    // the pre-#755 bar showed "1 client(s)" here.
    expect(
      formatStatusBar(mkStatus({ connections: 1, attached: false, queuedCount: 0 }), NOW_MS),
    ).toContain('| no clients |');
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
    // #932 protection 2 skips a write when the built sequence is unchanged,
    // so a changing status (not a fixed one) is what proves the timer is
    // actually ticking rather than painting the same bytes over and over.
    let connections = 0;
    const { bar, writes } = harness({ getStatus: () => mkStatus({ connections: connections++ }) });
    bar.start();
    await new Promise((r) => setTimeout(r, 30)); // a few 5ms ticks
    bar.stop();
    expect(writes.length).toBeGreaterThan(2);
  });

  test('the default interval is ~250ms so the evaluating counter is smooth (#576)', async () => {
    // No explicit intervalMs: exercise the constructor default. Within 320ms a
    // 250ms timer must have ticked at least once past the immediate paint
    // (the old 1000ms default would not have). Kept comfortably above 250ms to
    // avoid CI timer jitter flaking the assertion. Status changes each read
    // (#932 protection 2) so a repeat tick is not skipped as unchanged.
    const writes: string[] = [];
    let connections = 0;
    const bar = new StatusBar({
      getStdoutFd: () => 1,
      getStatus: () => mkStatus({ connections: connections++ }),
      getSize: () => ({ cols: 80, rows: 24 }),
      isEnabled: () => true,
      writeToFd: (_fd, data) => writes.push(data),
      now: () => NOW_MS,
      log: () => {},
      // intervalMs intentionally omitted to test the default.
    });
    bar.start();
    expect(writes).toHaveLength(1); // immediate paint
    await new Promise((r) => setTimeout(r, 320));
    bar.stop();
    expect(writes.length).toBeGreaterThan(1); // at least one timer repaint
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

  // #932: the bar and Claude's own PTY output are two writers on the same
  // fd; a paint that lands at the wrong moment can corrupt or erase a live
  // question prompt. These prove the mitigations directly against the
  // fd-write count, independent of the timer.
  test('the onset paint happens on the transition into a live question and reflects its state', () => {
    // Claude's native statusLine disappears entirely while a question dialog
    // is open, so the bar has to be current the MOMENT that happens, not up
    // to HEARTBEAT_MS stale. The first render() after the transition must
    // still paint (a quiet PTY -- see the gate test below for the busy case).
    const { bar, writes } = harness({
      hasLiveQuestions: () => true,
      getStatus: () => mkStatus({ connections: 3 }),
    });
    bar.render();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('3 client(s)');
  });

  test('the bar keeps tracking status while a question stays live', () => {
    // #1038: the old contract was a blanket freeze after the onset paint,
    // which had no upper bound -- a prompt a human sits on for ten minutes
    // froze row N for ten minutes. Content varies on every getStatus() read
    // so this measures repaints, not a dedup coincidence.
    let connections = 0;
    const { bar, writes } = harness({
      hasLiveQuestions: () => true,
      getStatus: () => mkStatus({ connections: connections++ }),
    });
    bar.render(); // onset
    bar.render();
    bar.render();
    expect(writes).toHaveLength(3);
    expect(writes[2]).toContain('2 client(s)');
  });

  test('a NEVER-quiescent PTY still paints while a question is live, bounded by HEARTBEAT_MS', () => {
    // The regression that #1038's own first attempt introduced, and the
    // single most important test in this file. That attempt made
    // `isQuiescent()` hard while a question was live, reasoning that a
    // deliberating human leaves the PTY quiet. A held permission does NOT
    // idle the PTY -- the TUI spinner keeps animating on its own timer
    // (#1026, observed live) -- so `isQuiescent()` stayed false for the
    // whole prompt and the bar painted ZERO times. Worse than the freeze it
    // replaced, which at least guaranteed its onset paint.
    //
    // isQuiescent is pinned false for the entire run: whatever gating exists
    // here, liveness must come from the heartbeat, never from the PTY going
    // quiet.
    let nowMs = NOW_MS;
    const { bar, writes } = harness({
      hasLiveQuestions: () => true,
      isQuiescent: () => false,
      isBoundaryClean: () => true,
      now: () => nowMs,
    });
    bar.render(); // onset: must paint even mid-spinner
    expect(writes).toHaveLength(1);
    for (let i = 0; i < 10; i++) {
      nowMs += HEARTBEAT_MS;
      bar.render();
    }
    expect(writes).toHaveLength(11); // one per heartbeat, never starved
  });

  test('a live question does NOT suspend the heartbeat exemption from the quiescence gate', () => {
    // The heartbeat bypasses quiescence so a streaming session cannot starve
    // the DECSTBM re-assertion -- and that exemption must NOT be conditioned
    // on whether a question is open, because a held permission is precisely
    // when the PTY streams indefinitely. Mirrors the same-named test in the
    // no-question case, so the two cannot drift apart again.
    let nowMs = NOW_MS;
    const { bar, writes } = harness({
      hasLiveQuestions: () => true,
      isQuiescent: () => false,
      now: () => nowMs,
    });
    bar.render();
    expect(writes).toHaveLength(1);
    nowMs += HEARTBEAT_MS;
    bar.render();
    expect(writes).toHaveLength(2);
  });

  test('a live question does not stop a status change from reaching the row', () => {
    // The user-visible half: content varies on every getStatus() read, so
    // this measures repaints rather than a dedup coincidence.
    let connections = 0;
    const { bar, writes } = harness({
      hasLiveQuestions: () => true,
      getStatus: () => mkStatus({ connections: connections++ }),
    });
    bar.render(); // onset
    bar.render();
    bar.render();
    expect(writes).toHaveLength(3);
    expect(writes[2]).toContain('2 client(s)');
  });

  test('a "needs you" cue still decays while the question that raised it is open', () => {
    // The reported bug, end to end: an escalate is what raises the prompt, so
    // the frozen frame was almost always the one reading "needs you" -- a cue
    // whose whole contract is that it decays after ESCALATE_FRESH_S, pinned
    // on screen for as long as the prompt stayed open.
    let nowMs = NOW_MS;
    const status = mkStatus({
      sessionStatus: 'waiting',
      autoApprove: { inFlight: 0, sinceS: 0, lastVerdict: 'escalated', lastVerdictAtS: NOW_S },
    });
    const { bar, writes } = harness({
      hasLiveQuestions: () => true,
      getStatus: () => status,
      now: () => nowMs,
    });
    bar.render();
    expect(writes[0]).toContain('needs you');
    nowMs += ESCALATE_FRESH_S * 1000; // the escalate is no longer fresh
    bar.render();
    expect(writes.at(-1)).toContain('waiting');
    expect(writes.at(-1)).not.toContain('needs you');
  });

  test('the resumed repaint reflects a status change made while the question was open', () => {
    // Still load-bearing after #1038: the dialog can redraw or consume row N
    // while it owns the screen, so the physical row cannot be trusted to
    // match lastRendered once the question clears.
    let live = true;
    let connections = 0;
    const { bar, writes } = harness({
      hasLiveQuestions: () => live,
      getStatus: () => mkStatus({ connections }),
    });
    bar.render();
    expect(writes[0]).toContain('no clients');
    connections = 5;
    live = false;
    bar.render(); // question resolved: repaints with the NEW status
    expect(writes.at(-1)).toContain('5 client(s)');
  });

  test('an unchanged status does not write a second time', () => {
    const { bar, writes } = harness();
    bar.render();
    bar.render();
    expect(writes).toHaveLength(1);
  });

  test('a changed status writes again', () => {
    let connections = 0;
    const { bar, writes } = harness({ getStatus: () => mkStatus({ connections }) });
    bar.render();
    connections = 1;
    bar.render();
    expect(writes).toHaveLength(2);
  });

  test('a heartbeat repaint occurs after HEARTBEAT_MS even with an unchanged status', () => {
    // buildBarSequence's DECSTBM re-assertion (the scroll region that keeps
    // the bar's row fixed) rides on every paint; an unchanged-status dedup
    // that never repaints would mean that assertion never fires either, so
    // the heartbeat forces one at least every HEARTBEAT_MS regardless.
    let nowMs = NOW_MS;
    const { bar, writes } = harness({ now: () => nowMs });
    bar.render();
    expect(writes).toHaveLength(1);
    nowMs += HEARTBEAT_MS - 1; // just under the threshold: still deduped
    bar.render();
    expect(writes).toHaveLength(1);
    nowMs += 1; // now at the threshold: forced repaint despite same status
    bar.render();
    expect(writes).toHaveLength(2);
    expect(writes[1]).toBe(writes[0]); // same content -- a heartbeat, not a change
  });

  test('a transition during a room-too-short window still paints once the guard clears', () => {
    // #932 review fix: the fd/room guards must run BEFORE hasLiveQuestions()
    // is read and wasQuestionLive is mutated -- otherwise a transition that
    // lands on a tick with no room gets "consumed" with no write to show
    // for it, and the bar freezes on stale content for the rest of the
    // window once room returns (the exact bug protection 1 exists to
    // prevent, reintroduced through ordering).
    let rows = 1; // too short: no room for the bar
    const { bar, writes } = harness({
      hasLiveQuestions: () => true,
      getSize: () => ({ cols: 80, rows }),
    });
    // Question already live, but no room: no paint, and the transition
    // must not be consumed here.
    bar.render();
    expect(writes).toHaveLength(0);
    rows = 24; // room restored, question still live
    // Onset must still fire now: the transition was never observed while
    // room was unavailable.
    bar.render();
    expect(writes).toHaveLength(1);
  });
});

// #932 durable fix: the quiescence + clean-boundary gate. `isBoundaryClean`
// and `isQuiescent` default to always-true in the harness (matching
// StatusBar's own fail-open defaults), so every test below opts in
// explicitly -- proving these tests actually exercise the new guards rather
// than merely coinciding with the pre-gate behavior every other test above
// already covers.
describe('StatusBar — #932 durable fix (quiescence + clean-boundary gate)', () => {
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

  test('render refuses to write while isBoundaryClean is false', () => {
    const { bar, writes } = harness({ isBoundaryClean: () => false });
    bar.render();
    expect(writes).toHaveLength(0);
  });

  test('render writes once the boundary becomes clean', () => {
    let clean = false;
    const { bar, writes } = harness({ isBoundaryClean: () => clean });
    bar.render();
    expect(writes).toHaveLength(0);
    clean = true;
    bar.render();
    expect(writes).toHaveLength(1);
  });

  test('a routine (content-changed) paint is refused while not quiescent, then happens once quiescent', () => {
    // The very first render() is itself heartbeat-due (lastWriteAtMs is
    // still null), so it bypasses quiescence like any other forced paint --
    // same as before this fix. The gate under test here is a SECOND paint
    // triggered only by a content change, well inside HEARTBEAT_MS.
    let quiescent = false;
    let connections = 0;
    const { bar, writes } = harness({
      isQuiescent: () => quiescent,
      getStatus: () => mkStatus({ connections: connections++ }),
    });
    bar.render(); // first-ever paint: heartbeat-due, bypasses quiescence
    expect(writes).toHaveLength(1);
    bar.render(); // content changed again, but not quiescent: refused
    expect(writes).toHaveLength(1);
    quiescent = true;
    bar.render(); // now quiescent: the routine paint proceeds
    expect(writes).toHaveLength(2);
    // Content keeps changing but quiescence drops again: refused once more.
    quiescent = false;
    bar.render();
    expect(writes).toHaveLength(2);
  });

  test('an unchanged status still does not write a second time even when quiescent (dedup unaffected)', () => {
    const { bar, writes } = harness({ isQuiescent: () => true });
    bar.render();
    bar.render();
    expect(writes).toHaveLength(1);
  });

  test('the onset paint bypasses the quiescence gate but still honors the boundary gate', () => {
    // Onset must fire the instant a question goes live, even mid-burst --
    // see status-bar.ts's HEARTBEAT_MS doc for why the soft gate has
    // documented exceptions.
    //
    // #1038 tried to remove this exemption (onset implies a live question,
    // and that attempt made quiescence hard there). It must stay: a held
    // permission keeps the TUI spinner animating (#1026), so an onset that
    // waited for quiescence would never fire at all -- the bar would keep
    // whatever it painted BEFORE the escalate, for the whole prompt.
    const { bar, writes } = harness({
      hasLiveQuestions: () => true,
      isQuiescent: () => false,
      isBoundaryClean: () => true,
    });
    bar.render();
    expect(writes).toHaveLength(1);
  });

  test('the onset paint does NOT bypass the boundary gate', () => {
    // The hard gate has no exceptions -- not even onset. Regression guard:
    // if someone "simplifies" render() by exempting onset from the boundary
    // check too, this must go red.
    const { bar, writes } = harness({
      hasLiveQuestions: () => true,
      isQuiescent: () => true,
      isBoundaryClean: () => false,
    });
    bar.render();
    expect(writes).toHaveLength(0);
  });

  test('the resumed paint bypasses the quiescence gate but still honors the boundary gate', () => {
    let live = true;
    let quiescent = true;
    const { bar, writes } = harness({
      hasLiveQuestions: () => live,
      isQuiescent: () => quiescent,
      isBoundaryClean: () => true,
    });
    bar.render(); // onset, PTY quiet: paints
    expect(writes).toHaveLength(1);
    // The question clears just as Claude starts writing again. `resumed`
    // still paints: once no question is live, the soft gate's documented
    // exemptions are back in force (#1038 suspends them only while one is).
    live = false;
    quiescent = false;
    bar.render();
    expect(writes).toHaveLength(2);
  });

  test('a heartbeat repaint bypasses the quiescence gate but still honors the boundary gate', () => {
    let nowMs = NOW_MS;
    const { bar, writes } = harness({ now: () => nowMs, isQuiescent: () => false });
    bar.render();
    expect(writes).toHaveLength(1);
    nowMs += HEARTBEAT_MS; // heartbeat due; PTY still "active" (not quiescent)
    bar.render();
    expect(writes).toHaveLength(2);
  });

  test('a heartbeat repaint does NOT bypass the boundary gate', () => {
    // Regression guard for the interaction called out in HEARTBEAT_MS's doc:
    // the heartbeat must never force a write at a dirty boundary, even
    // though it is exempt from the (safe) quiescence gate.
    let nowMs = NOW_MS;
    const { bar, writes } = harness({ now: () => nowMs, isBoundaryClean: () => false });
    bar.render();
    expect(writes).toHaveLength(0);
    nowMs += HEARTBEAT_MS;
    bar.render();
    expect(writes).toHaveLength(0);
  });

  test('notifyScrollRegionReset paints immediately, bypassing the quiescence gate', () => {
    const { bar, writes } = harness({ isQuiescent: () => false, isBoundaryClean: () => true });
    bar.notifyScrollRegionReset();
    expect(writes).toHaveLength(1);
  });

  test('notifyScrollRegionReset stays pending and retries once the boundary clears', () => {
    let clean = true;
    let quiescent = true;
    const { bar, writes } = harness({
      isQuiescent: () => quiescent,
      isBoundaryClean: () => clean,
    });
    // Get an ordinary first paint in so lastWriteAtMs is set -- otherwise
    // every following render() would ALSO be "heartbeat due" (lastWriteAtMs
    // still null) regardless of forceRepaintPending, and the test below
    // would not actually prove the pending flag is what triggers the write.
    bar.render();
    expect(writes).toHaveLength(1);
    // Now block both the boundary and quiescence, and go dirty; the
    // immediate attempt inside notifyScrollRegionReset must be refused.
    clean = false;
    quiescent = false;
    bar.notifyScrollRegionReset();
    expect(writes).toHaveLength(1);
    bar.render(); // still dirty, still not quiescent, unchanged content: no write
    expect(writes).toHaveLength(1);
    // Boundary clears, but quiescence and content still would not justify a
    // routine write on their own (unchanged status, heartbeat not due,
    // still not quiescent) -- only the pending flag can explain a write now.
    clean = true;
    bar.render();
    expect(writes).toHaveLength(2);
  });

  test('a transition during a dirty-boundary window still paints once the boundary clears', () => {
    // Mirrors the room-too-short guard-ordering test: the boundary gate must
    // sit in the same "cannot physically paint" group as the fd/room checks,
    // BEFORE hasLiveQuestions() is read -- otherwise a question transition
    // landing while the boundary is dirty gets consumed with no write to
    // show for it, and the bar freezes on stale content once the boundary
    // clears (the exact bug the ordering exists to prevent).
    let clean = false;
    const { bar, writes } = harness({
      hasLiveQuestions: () => true,
      isBoundaryClean: () => clean,
    });
    bar.render(); // question already live, but boundary dirty: no paint, no consumption
    expect(writes).toHaveLength(0);
    clean = true;
    bar.render(); // onset must still fire now
    expect(writes).toHaveLength(1);
  });

  test('omitting isBoundaryClean/isQuiescent keeps pre-durable-fix behavior (always paintable)', () => {
    const { bar, writes } = harness({});
    bar.render();
    expect(writes).toHaveLength(1);
  });
});

// #1038: the unit tests above inject `isQuiescent` directly, which is how the
// first attempt at this fix passed its own suite while being broken in
// production. These drive the REAL PtyQuiescenceGate with real chunk bytes,
// at the cadence Claude's TUI spinner actually runs, so the starvation case
// cannot hide behind a hand-flipped boolean.
describe('StatusBar against the real PtyQuiescenceGate (#1038)', () => {
  /** Claude's spinner glyphs, redrawn in place on their own timer. */
  const SPINNER = ['✶', '⠻', '✢', '✳'];
  /** Well under QUIESCENCE_MS (500), which is the whole point. */
  const SPINNER_MS = 150;
  const TICK_MS = 250;

  /**
   * Run `minutes` of a live question during which the PTY never goes quiet
   * for QUIESCENCE_MS, and report how often row N was actually painted.
   */
  function runWithSpinner(minutes: number): { writes: string[]; status: RemiStatus } {
    let nowMs = NOW_MS;
    const gate = new PtyQuiescenceGate(() => nowMs);
    const status = mkStatus({
      sessionStatus: 'waiting',
      attached: false,
      queuedCount: 0,
      autoApprove: { inFlight: 0, sinceS: 0, lastVerdict: 'escalated', lastVerdictAtS: NOW_S },
    });
    const writes: string[] = [];
    const bar = new StatusBar({
      getStdoutFd: () => 1,
      getStatus: () => status,
      getSize: () => ({ cols: 80, rows: 24 }),
      isEnabled: () => true,
      hasLiveQuestions: () => true,
      isBoundaryClean: () => gate.isBoundaryClean(),
      isQuiescent: () => gate.isQuiescent(),
      writeToFd: (_fd, data) => writes.push(data),
      now: () => nowMs,
      log: () => {},
    });

    let spinnerAt = NOW_MS;
    let tickAt = NOW_MS;
    let frame = 0;
    const end = NOW_MS + minutes * 60_000;
    while (nowMs < end) {
      nowMs = Math.min(spinnerAt, tickAt);
      if (nowMs === spinnerAt) {
        gate.observe(Buffer.from(`\r${SPINNER[frame++ % SPINNER.length]} Running...`));
        spinnerAt += SPINNER_MS;
      }
      if (nowMs === tickAt) {
        bar.render();
        tickAt += TICK_MS;
        status.attached = true; // a phone attaches while the prompt is open
      }
    }
    return { writes, status };
  }

  test('a held permission whose spinner never lets the PTY go quiet still paints', () => {
    // The exact production scenario. `isQuiescent()` is never true for the
    // whole ten minutes; if liveness depended on it, this is 0.
    const { writes } = runWithSpinner(10);
    expect(writes.length).toBeGreaterThan(0);
    // Bounded by HEARTBEAT_MS, so ~1 paint per 2s over 10 minutes.
    expect(writes.length).toBeGreaterThanOrEqual((10 * 60_000) / HEARTBEAT_MS - 1);
  });

  test('the row reflects state that changed during the prompt, not the frame that raised it', () => {
    // The user-visible bug: "needs you" is contractually bounded by
    // ESCALATE_FRESH_S and the attach label changed mid-prompt. Both must
    // reach the row even though Claude never stopped writing.
    const { writes } = runWithSpinner(10);
    expect(writes[0]).toContain('needs you');
    expect(writes.at(-1)).toContain('attached');
    expect(writes.at(-1)).not.toContain('needs you');
  });

  test('no paint ever lands at a dirty escape-sequence boundary', () => {
    // The hard gate is what makes the hazard #932 documents impossible, and
    // it is the reason painting through a spinner is safe at all. Feed a
    // deliberately unterminated sequence and confirm the bar refuses.
    let nowMs = NOW_MS;
    const gate = new PtyQuiescenceGate(() => nowMs);
    const writes: string[] = [];
    const bar = new StatusBar({
      getStdoutFd: () => 1,
      getStatus: () => mkStatus(),
      getSize: () => ({ cols: 80, rows: 24 }),
      isEnabled: () => true,
      hasLiveQuestions: () => true,
      isBoundaryClean: () => gate.isBoundaryClean(),
      isQuiescent: () => gate.isQuiescent(),
      writeToFd: (_fd, data) => writes.push(data),
      now: () => nowMs,
      log: () => {},
    });
    gate.observe(Buffer.from('\x1b[')); // truncated CSI: mid-sequence
    expect(gate.isBoundaryClean()).toBe(false);
    nowMs += HEARTBEAT_MS * 3; // heartbeat long overdue
    bar.render();
    expect(writes).toHaveLength(0);
    gate.observe(Buffer.from('0m')); // sequence completes
    bar.render();
    expect(writes).toHaveLength(1);
  });
});
