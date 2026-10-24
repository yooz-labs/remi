import { fullGC, heapStats } from 'bun:jsc';
/** Necessary retained-state control; capacity input is internal, not viewport fidelity evidence. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PTYSession } from '../packages/daemon/src/pty/pty-session.ts';
import {
  type BorrowedTerminalFrame,
  TerminalCaptureHost,
} from '../packages/daemon/src/terminal/capture-host.ts';
import { BoundedScreen, SCREEN_LIMITS } from '../packages/daemon/src/terminal/screen.ts';
import {
  type OwnedTerminalSend,
  TerminalSendSlot,
} from '../packages/daemon/src/terminal/send-slot.ts';
import { runTerminalNetworkPeer } from '../packages/daemon/tests/helpers/terminal-native-pair.ts';
import { runOwnedTerminalOutputChild } from '../packages/daemon/tests/helpers/terminal-output-child.ts';
import {
  createNativeTlsTerminalPair,
  runNativeTlsNetworkPeer,
} from '../packages/daemon/tests/helpers/terminal-tls-pair.ts';
import { createNativeTerminalPair } from '../packages/daemon/tests/helpers/terminal-view-ownership-proof.ts';
import {
  type SessionTerminalSnapshot,
  encodeTerminalViewFrame,
} from '../packages/shared/src/terminal-view.ts';
const args = process.argv.slice(2);
const tlsMode = args.includes('--terminal-tls-root');
const networkPair = () =>
  tlsMode ? createNativeTlsTerminalPair() : createNativeTerminalPair(process.platform === 'linux');
function requiredArgument(index: number): string {
  const value = args[index];
  assert(value, 'owned proof argument present');
  return value;
}
if (args[0] === '--external-calibration') {
  fullGC();
  const before = heapStats();
  assert(
    before.extraMemorySize < 2 * 1024 * 1024,
    'isolated calibration has a small external baseline',
  );
  const data = new Uint8Array(8 * 1024 * 1024);
  data[0] = 1;
  data[data.length - 1] = 2;
  fullGC();
  const after = heapStats();
  assert(
    after.extraMemorySize >= data.byteLength && after.heapSize >= after.extraMemorySize,
    'isolated heap counter includes actual external backing store',
  );
  assert(data[0] === 1 && data[data.length - 1] === 2);
  console.info(
    JSON.stringify({
      status: 'passed',
      version: Bun.version,
      revision: Bun.revision,
      before: { heap: before.heapSize, extra: before.extraMemorySize },
      after: { heap: after.heapSize, extra: after.extraMemorySize },
      bytes: data.byteLength,
    }),
  );
  process.exit(0);
}

if (args[0] === '--terminal-tls-peer') {
  await runNativeTlsNetworkPeer(requiredArgument(1), requiredArgument(2));
  process.exit(0);
}
if (args[0] === '--terminal-peer') {
  await runTerminalNetworkPeer(
    requiredArgument(1),
    requiredArgument(2),
    args.includes('--stable-peer'),
  );
  process.exit(0);
}
if (args[0] === '--owned-output-child') {
  await runOwnedTerminalOutputChild(requiredArgument(1), args[2] ?? '');
  process.exit(0);
}
const command = (): [string, ...string[]] =>
  Bun.main.startsWith('/$bunfs/')
    ? [process.execPath]
    : [process.execPath, '--no-env-file', Bun.main];
async function until(check: () => boolean) {
  const end = performance.now() + 10000;
  while (!check()) {
    assert(performance.now() < end, 'owned resource deadline');
    await Bun.sleep(2);
  }
}
const bytes = (s: string) => new TextEncoder().encode(s);
const chunks = [
  bytes('X'.repeat(14400)),
  bytes(`\x1b[H${'e\u0301'.repeat(SCREEN_LIMITS.combiningBytes / 4)}`),
  bytes(`\x1b[H${'X'.repeat(14400)}`),
  bytes(`\x1b[?1049h\x1b[H${'é'.repeat(14400)}`),
  bytes(`\x1b[H${'e\u0301'.repeat(SCREEN_LIMITS.combiningBytes / 4)}`),
  bytes(`\x1b[H${'é'.repeat(14400)}`),
];
if (args.includes('--utf16-escaped')) {
  const rows = Array.from(
    { length: 60 },
    (_, i) =>
      '"'.repeat(i < 58 ? 138 : 136) + '\u{1d11e}'.repeat(i < 58 ? 102 : 103) + (i < 58 ? '' : 'é'),
  );
  const text = rows.join('');
  assert.equal(Buffer.byteLength(text), 32768, 'maximum UTF16/escaped text');
  chunks.push(bytes(`\x1b[H${text}`));
}
const input = bytes('x'.repeat(8192));
const memory = () => {
  fullGC();
  const stats = heapStats();
  return { heap: stats.heapSize, extra: stats.extraMemorySize, charge: stats.heapSize };
};
function create() {
  const home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'terminal-send-resource-')));
  const prefix = join(home, 'child');
  const cmd = command();
  const pty = new PTYSession({
    command: cmd[0],
    args: [...cmd.slice(1), '--owned-output-child', prefix, ''],
    cwd: home,
    env: { HOME: home },
    size: { cols: 240, rows: 60 },
  });
  return { home, prefix, pty, host: new TerminalCaptureHost(home), id: crypto.randomUUID() };
}
function model(f: ReturnType<typeof create>) {
  const m = (Reflect.get(f.host, 'captures') as Map<string, { screen: BoundedScreen }>).get(
    f.id,
  )?.screen;
  assert(m instanceof BoundedScreen);
  return m;
}
async function start(f: ReturnType<typeof create>) {
  assert(await f.host.prepare(f.id, f.pty));
  await f.pty.start();
  await until(() => fs.existsSync(`${f.prefix}.ready`));
  const native = JSON.parse(fs.readFileSync(`${f.prefix}.ready`, 'utf8'));
  assert.equal(native.pid, f.pty.childPid);
  assert.deepEqual(native.size, [240, 60]);
  const m = model(f);
  for (const chunk of chunks) {
    assert(m.observe(chunk));
    await m.whenIdle();
    assert(m.available, m.reason);
  }
  const context = f.host.contextFor(f.id);
  assert(context);
  return Array.from({ length: 4 }, () =>
    context.reserveView(crypto.randomUUID().replaceAll('-', '').repeat(2), crypto.randomUUID()),
  );
}
function message(
  f: ReturnType<typeof create>,
  frame: Pick<BorrowedTerminalFrame, 'revision' | 'snapshot'>,
): SessionTerminalSnapshot {
  return {
    type: 'session_terminal_snapshot' as const,
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    sessionId: f.id,
    requestId: crypto.randomUUID(),
    viewId: 'AAAAAAAAAAAAAAAAAAAAAA',
    revision: frame.revision,
    ...frame.snapshot,
  };
}
async function closePty(f: ReturnType<typeof create>) {
  await f.pty.close(1000);
  const childPid = f.pty.childPid;
  assert(childPid !== null);
  assert.throws(
    () => process.kill(childPid, 0),
    (e) => (e as NodeJS.ErrnoException).code === 'ESRCH',
    'resource actual PTY reaped',
  );
  assert.equal(
    JSON.parse(fs.readFileSync(`${f.prefix}.input`, 'utf8')).inputBytes,
    0,
    'ownership resource actual child input is zero',
  );
}
for (let i = 0; i < 3; i++) {
  const f = create();
  const pair = await networkPair();
  try {
    const views = await start(f);
    let released = false;
    pair.resumePeer();
    assert(
      pair.slot.schedule((deliver) => {
        const frame = views[0]?.borrow();
        assert(frame);
        deliver({
          message: message(f, frame),
          release() {
            frame.release();
            released = true;
          },
          quarantine() {
            frame.quarantine();
            assert.fail('warm native ownership is certain');
          },
        });
        return undefined;
      }),
    );
    await until(() => released);
    await closePty(f);
    assert(await f.host.closeAll());
  } finally {
    await pair.close();
    await f.pty.close(1000);
    await f.host.closeAll();
  }
  fs.rmSync(f.home, { recursive: true, force: true });
}
await Bun.sleep(1100);
const calibrationProc = Bun.spawn([...command(), '--external-calibration'], {
  stdin: 'ignore',
  stdout: 'pipe',
  stderr: 'pipe',
  env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', LANG: 'en_US.UTF-8', TMPDIR: tmpdir() },
});
const calibrationOut = new Response(calibrationProc.stdout).text();
const calibrationErr = new Response(calibrationProc.stderr).text();
assert.equal(await calibrationProc.exited, 0, await calibrationErr);
assert.equal(await calibrationErr, '');
const calibration = JSON.parse(await calibrationOut);
assert(
  calibration.status === 'passed' &&
    calibration.version === Bun.version &&
    calibration.revision === Bun.revision,
);
assert.throws(
  () => process.kill(calibrationProc.pid, 0),
  (e) => (e as NodeJS.ErrnoException).code === 'ESRCH',
  'isolated calibration child reaped',
);
// Collect completed warmup finalizers before measuring new state; this lowers the baseline, not the budget.
for (let i = 0; i < 3; i++) {
  fullGC();
  await Bun.sleep(0);
}
// Fixed server/peer setup precedes the baseline; fresh slot and all view state follow it.
const pair = await networkPair();
const f = create();
let passed = false;
try {
  const before = memory();
  const nativeCopyAllowance = new Uint8Array(65536 + 10);
  const pressureAllowance = new Uint8Array(16384 + 1034);
  const tlsWorkingAllowance = new Uint8Array(tlsMode ? 198666 : 0);
  const envelopeAllowance = new Uint8Array(1024);
  const ingressHandoffAllowance = new Uint8Array(16384);
  const slot = new TerminalSendSlot(pair.ws, tlsMode ? 'tls-receipt' : 'plain-ws');
  pair.replaceSlot(slot);
  const views = await start(f);
  const m = model(f);
  let outcome: string | undefined;
  let released = 0;
  let quarantined = 0;
  let projectedBytes = 0;
  let handoffBefore: ReturnType<typeof memory> | undefined;
  let handoffAfter: ReturnType<typeof memory> | undefined;
  let handoffStartPending: { bytes: number; operations: number } | undefined;
  let handoffEndPending: { bytes: number; operations: number } | undefined;
  pair.pressureAtSend();
  const pressuredSend = pair.ws.send;
  pair.ws.send = (text, compress) => {
    assert(typeof text === 'string', 'actual strict string enters native transport');
    projectedBytes = Buffer.byteLength(text);
    if (args.includes('--negative-overlap'))
      assert(m.observe(input), 'real diagnostic parser operation admitted');
    handoffStartPending = { ...m.pending };
    handoffBefore = memory();
    const status = pressuredSend.call(pair.ws, text, compress);
    handoffAfter = memory();
    handoffEndPending = { ...m.pending };
    return status;
  };
  assert(
    slot.schedule((deliver) => {
      const frame = views[0]?.borrow();
      assert(frame, 'actual view borrows measured screen');
      assert.equal(views[1]?.borrow(), null, 'model owns one outgoing slot across views');
      const value = message(f, frame);
      outcome = deliver({
        message: value,
        release() {
          frame.release();
          released++;
        },
        quarantine() {
          frame.quarantine();
          quarantined++;
        },
      });
      return undefined;
    }),
  );
  await until(() => outcome !== undefined);
  assert.deepEqual(
    handoffStartPending,
    { bytes: 0, operations: 0 },
    'synchronous native handoff starts from idle parser',
  );
  assert.deepEqual(
    handoffEndPending,
    { bytes: 0, operations: 0 },
    'synchronous native handoff finishes before parser ingress',
  );
  assert.equal(outcome, 'pending', 'actual native projection is held');
  assert(pair.ws.getBufferedAmount() > 0 && slot.busy);
  assert.equal(released, 0);
  assert(projectedBytes > 0 && projectedBytes <= 65536, 'strict frame budget');
  assert(handoffBefore && handoffAfter, 'both actual native handoff samples recorded');
  const settled = memory();
  for (let index = 0; index < 8; index++) assert(m.observe(input), 'full parser queue admitted');
  assert.deepEqual(m.pending, { bytes: 65536, operations: 8 });
  const pending = memory();
  await m.whenIdle();
  assert(m.available, m.reason);
  const drained = memory();
  const tlsPair = pair as Awaited<ReturnType<typeof createNativeTlsTerminalPair>>;
  const pendingState = {
    busy: slot.busy,
    released,
    quarantined,
    frameOwned: !!Reflect.get(slot, 'frame'),
    receiptBytes: (Reflect.get(slot, 'receipt') as Uint8Array | null)?.byteLength ?? 0,
    receiptConfirmed: Reflect.get(slot, 'receiptConfirmed'),
    ready: pair.ws.readyState === WebSocket.OPEN,
    rawNative: pair.ws.getBufferedAmount(),
    peerStopped: tlsMode ? tlsPair.receiverStopped() : true,
    peerDecodedFrame: tlsMode ? tlsPair.receivedAnyFrame() : false,
  };
  assert(
    pendingState.busy &&
      released === 0 &&
      quarantined === 0 &&
      (tlsMode
        ? pendingState.frameOwned &&
          pendingState.receiptBytes === 16 &&
          pendingState.receiptConfirmed === false &&
          pendingState.ready &&
          pendingState.peerStopped &&
          !pendingState.peerDecodedFrame
        : pendingState.rawNative > 0),
    `actual projection ownership persists through resource measurements: ${JSON.stringify(pendingState)}`,
  );

  const evidence = {
    before,
    handoffBefore,
    handoffAfter,
    handoffStartPending,
    handoffEndPending,
    settled,
    pending,
    drained,
    conservativePeakDelta:
      Math.max(
        handoffBefore.charge,
        handoffAfter.charge,
        settled.charge,
        pending.charge,
        drained.charge,
      ) - before.charge,
    budget: 1048576,
    projectedBytes,
    actualNativeBuffered: pair.ws.getBufferedAmount(),
    pendingState,
    calibration,
    nativeCopyAllowanceBytes: nativeCopyAllowance.byteLength,
    tlsWorkingAllowanceBytes: tlsWorkingAllowance.byteLength,
    transport: tlsMode ? 'wss-native-receipt' : 'plain-ws',
    fixturePressureAllowanceBytes: pressureAllowance.byteLength,
    viewCount: views.length,
    envelopeAllowanceBytes: envelopeAllowance.byteLength,
    ingressHandoffAllowanceBytes: ingressHandoffAllowance.byteLength,
    profile: args.includes('--utf16-escaped') ? 'utf16-escaped' : 'latin1',
    scope:
      'maximum actual synchronous encode/native handoff and later native-pending full-queue stages; original message/snapshot,4views,new sender and all explicit allowances; preexistingPTY/emptyhost/fixednetwork setup precede one baseline; no extra probe-owned serialized string in later pending phase; internalcapacity is notfidelity or OS/kernel bound',
  };
  fs.writeFileSync(join(f.home, 'resource-result.json'), JSON.stringify(evidence));
  assert(
    evidence.conservativePeakDelta <= 1048576,
    `one MiB actual terminal ownership stage gate: ${JSON.stringify(evidence)}`,
  );
  assert(
    nativeCopyAllowance.length &&
      pressureAllowance.length &&
      envelopeAllowance.length &&
      ingressHandoffAllowance.length &&
      calibration.bytes &&
      tlsWorkingAllowance.byteLength === (tlsMode ? 198666 : 0),
    'all retained allowances survive every measurement',
  );
  const actualPendingOwner = Reflect.get(slot, 'frame') as OwnedTerminalSend | null;
  assert(actualPendingOwner, 'actual sender still holds original message');
  // Construct this receipt verifier only after the last resource sample.
  const expectedFrame = encodeTerminalViewFrame(actualPendingOwner.message);

  if (args.includes('--negative-write')) {
    await f.pty.write('X');
    await Bun.sleep(100);
  }
  await closePty(f);
  slot.retire();
  assert.equal(
    await f.host.closeAll(),
    false,
    'native pending projection retains view/model after exit',
  );
  pair.resumePeer();
  await until(() => released === 1);
  await until(() => pair.receivedFrame(expectedFrame));
  assert(await f.host.closeAll());
  passed = true;
  console.info(
    JSON.stringify({
      status: 'passed',
      version: Bun.version,
      revision: Bun.revision,
      platform: process.platform,
      architecture: process.arch,
      evidence,
    }),
  );
} finally {
  await pair.close();
  await f.pty.close(1000);
  await f.host.closeAll();
  if (passed) fs.rmSync(f.home, { recursive: true, force: true });
  else console.error('Owned ownership resource evidence retained', f.home);
}
