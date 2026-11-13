/** Actual PTYs, private quotas and native paused TCP peers; no authority service is simulated. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { createConnection } from 'node:net';
import { createNativeTerminalPair } from './terminal-native-pair.ts';
export { createNativeTerminalPair } from './terminal-native-pair.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeTerminalViewFrame } from '@remi/shared';
import { PTYSession } from '../../src/pty/pty-session.ts';
import { withInterprocessFileLockNonblocking } from '../../src/storage/interprocess-file-lock.ts';
import { writeRestrictedJson } from '../../src/storage/restricted-json.ts';
import {
  type BorrowedTerminalFrame,
  TerminalCaptureHost,
  type TerminalCaptureView,
} from '../../src/terminal/capture-host.ts';
import { TerminalReservationError, TerminalReservations } from '../../src/terminal/reservations.ts';
import { type TerminalSendOutcome, TerminalSendSlot } from '../../src/terminal/send-slot.ts';

export const OWNERSHIP_GROUPS = [
  'context view quotas across independent owners',
  'borrowed view disposal precedes model release',
  'native immediate send runs outside message cork',
  'pending native projection survives logical retirement until drain',
  'native close quarantines despite later frame delivery',
  'entered native send failure quarantines without closing the peer',
  'preexisting native pressure produces no new frame',
  'retirement cancels unsent work before borrowing',
  'reentrant drain cannot release an entered native send',
  'reentrant native close quarantines before send returns',
  'lost view ownership retires capture without replacement accounting',
  'busy view check preserves the original live capture',
  'bare capture quarantine retains its model charge',
  'unexpected native queue growth quarantines ownership',
  'duplicate delivery cannot release an aliased pending frame',
  'synchronous native handoff excludes queued PTY callbacks',
  'escaped delivery cannot outlive its synchronous operation',
] as const;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, name: string): Promise<void> {
  const end = performance.now() + 10000;
  while (!check()) {
    assert(performance.now() < end, name);
    await wait(2);
  }
}
const records = (home: string): Array<{ kind: string }> =>
  JSON.parse(fs.readFileSync(join(home, 'terminal-view/reservations.json'), 'utf8')).records;
const device = () => randomBytes(32).toString('hex');
const busy = (call: () => unknown, name: string) =>
  assert.throws(
    call,
    (error) => error instanceof TerminalReservationError && error.code === 'busy',
    name,
  );

async function consumer(
  home: string,
  command: readonly string[],
  host = new TerminalCaptureHost(home),
) {
  const prefix = join(home, randomUUID());
  const id = randomUUID();
  const executable = command[0];
  assert(executable, 'owned command is present');
  let dispatchedBytes = 0;
  const pty = new PTYSession(
    {
      command: executable,
      args: [...command.slice(1), '--owned-output-child', prefix, 'SCREEN\x1b[6n'],
      cwd: home,
      env: { HOME: home },
      size: { cols: 20, rows: 4 },
    },
    {
      onData(data) {
        dispatchedBytes += Buffer.byteLength(data);
      },
    },
  );
  try {
    assert(await host.prepare(id, pty));
    await pty.start();
    await until(() => fs.existsSync(`${prefix}.ready`), 'actual owned PTY ready');
    await until(() => {
      const frame = host.contextFor(id)?.borrow();
      if (!frame) return false;
      const ready = frame.snapshot.lines[0] === 'SCREEN';
      frame.release();
      return ready;
    }, 'complete actual launch screen');
  } catch (error) {
    const errors = [error];
    for (const close of [() => pty.close(1000), () => host.closeAll()]) {
      try {
        await close();
      } catch (failure) {
        errors.push(failure);
      }
    }
    throw new AggregateError(errors, 'Owned capture startup failed');
  }
  const context = host.contextFor(id);
  assert(context);
  let injected = false;
  return {
    home,
    prefix,
    dispatchedBytes: () => dispatchedBytes,
    id,
    pty,
    host,
    context,
    async close() {
      if (!injected && pty.isRunning && process.argv.includes('--negative-write')) {
        injected = true;
        await pty.write('X');
        await wait(30);
      }
      await pty.close(1000);
      assert(pty.childPid !== null);
      const pid = pty.childPid;
      assert.throws(
        () => process.kill(pid, 0),
        (error) => (error as NodeJS.ErrnoException).code === 'ESRCH',
        'owned PTY child reaped',
      );
      assert.equal(
        JSON.parse(fs.readFileSync(`${prefix}.input`, 'utf8')).inputBytes,
        0,
        'ownership proof writes zero child input bytes',
      );
    },
  };
}
async function borrowed(view: TerminalCaptureView): Promise<BorrowedTerminalFrame> {
  let frame: BorrowedTerminalFrame | null = null;
  await until(() => {
    frame = view.borrow();
    return frame !== null;
  }, 'owned view borrows complete frame');
  assert(frame);
  return frame;
}

export async function createInProcessNativeTerminalPair() {
  let ws: Bun.ServerWebSocket<undefined> | undefined;
  let slot: TerminalSendSlot | undefined;
  let insideMessage = false;
  let action: (() => void) | undefined;
  let upgraded = false;
  let tail = Buffer.alloc(0);
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response('owned', { status: 400 });
    },
    websocket: {
      open(value) {
        ws = value;
        slot = new TerminalSendSlot(value, 'plain-ws');
      },
      message() {
        insideMessage = true;
        try {
          action?.();
        } finally {
          insideMessage = false;
        }
      },
      drain() {
        slot?.nativeDrained();
      },
      close() {
        slot?.nativeClosed();
      },
      backpressureLimit: 128 * 1024,
      closeOnBackpressureLimit: false,
    },
  });
  const port = server.port;
  assert(port, 'owned WebSocket port is present');
  const peer = createConnection({ host: '127.0.0.1', port });
  peer.on('error', () => {});
  peer.on('data', (data) => {
    tail = Buffer.concat([tail, data]).subarray(-131072);
    if (!upgraded && tail.includes(Buffer.from('\r\n\r\n'))) {
      assert(tail.toString().startsWith('HTTP/1.1 101'));
      upgraded = true;
      peer.pause();
    }
  });
  await new Promise<void>((resolve, reject) => {
    peer.once('connect', resolve);
    peer.once('error', reject);
  });
  peer.write(
    `GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  );
  await until(() => upgraded && !!ws && !!slot, 'actual owned WebSocket upgrade');
  assert(ws && slot);
  const native = ws;
  const sender = slot;
  const original = native.send;
  let capacityBytes = 0;
  const fill = () => {
    while (native.getBufferedAmount() === 0) {
      assert(capacityBytes < 16 * 1024 * 1024, 'finite owned native pressure');
      original.call(native, 'x'.repeat(1024));
      capacityBytes += 1024;
    }
    assert(
      native.getBufferedAmount() <= 1034,
      'fixture pressure retains at most one KiB plus header',
    );
  };
  return {
    ws: native,
    get slot() {
      return slot ?? sender;
    },
    replaceSlot(value: TerminalSendSlot) {
      sender.retire();
      slot = value;
    },
    peer,
    fill,
    insideMessage: () => insideMessage,
    received: () => tail.toString(),
    capacity: () => capacityBytes,
    fromMessage(call: () => void) {
      action = call;
      // One actual masked client text frame. The owned trigger is not PTY input.
      peer.write(Buffer.from([0x81, 0x81, 0, 0, 0, 0, 0x78]));
    },
    pressureAtSend(
      throwAfter = false,
      beforeFill?: () => void,
      closeAfter = false,
      excess = false,
    ) {
      native.send = (text, compress) => {
        native.send = original;
        beforeFill?.();
        fill(); // Real writes establish pressure between preflight and the actual frame.
        if (excess)
          while (native.getBufferedAmount() < 80 * 1024) original.call(native, 'x'.repeat(1024));
        const result = original.call(native, text, compress);
        if (closeAfter) native.close();
        if (throwAfter) throw new Error('owned post-native-call failure');
        return result;
      };
    },
    close() {
      peer.destroy();
      server.stop(true);
    },
  };
}

export async function runRemoteTerminalViews(
  home: string,
  sharedDevice: string,
  prefix: string,
  command: readonly string[],
) {
  const f = await consumer(home, command);
  const views = [
    f.context.reserveView(sharedDevice, randomUUID()),
    f.context.reserveView(sharedDevice, randomUUID()),
  ];
  try {
    fs.writeFileSync(`${prefix}.ready`, String(process.pid));
    await until(() => fs.existsSync(`${prefix}.go`), 'owned remote view release');
  } finally {
    for (const view of views) view.retire();
    assert(await f.host.closeAll());
    await f.close();
  }
}

export function holdTerminalViewLock(home: string, prefix: string): void {
  withInterprocessFileLockNonblocking(join(home, 'terminal-view/reservations.json'), () => {
    fs.writeFileSync(`${prefix}.ready`, String(process.pid));
    const deadline = performance.now() + 20000;
    while (!fs.existsSync(`${prefix}.go`)) {
      assert(performance.now() < deadline, 'owned view lock release deadline');
      Bun.sleepSync(1);
    }
  });
}

export async function runTerminalOwnershipOwner(
  name: string,
  home: string,
  command: readonly string[],
) {
  if (name === OWNERSHIP_GROUPS[0]) {
    const remoteDevice = device();
    const prefix = join(home, 'remote');
    const remote = Bun.spawn([...command, '--remote-views', home, remoteDevice, prefix], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: home,
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', LANG: 'en_US.UTF-8', TMPDIR: tmpdir() },
    });
    const remoteErrors = new Response(remote.stderr).text();
    const remoteOutput = new Response(remote.stdout).text();
    const consumers: Awaited<ReturnType<typeof consumer>>[] = [];
    const views: TerminalCaptureView[] = [];
    const failures: unknown[] = [];
    try {
      await until(
        () => fs.existsSync(`${prefix}.ready`) || remote.exitCode !== null,
        'actual remote views ready',
      );
      assert.equal(remote.exitCode, null, 'remote resource owner remains live');
      assert.equal(Number(fs.readFileSync(`${prefix}.ready`, 'utf8')), remote.pid);
      const first = await consumer(home, command);
      consumers.push(first);
      const second = await consumer(home, command);
      consumers.push(second);
      const third = await consumer(home, command, first.host);
      consumers.push(third);
      const a = device();
      const connection = randomUUID();
      busy(
        () => first.context.reserveView(remoteDevice, randomUUID()),
        'third device view across processes refused',
      );
      views.push(first.context.reserveView(a, connection));
      busy(() => first.context.reserveView(device(), connection), 'second connection view refused');
      views.push(first.context.reserveView(a, randomUUID()));
      busy(
        () => second.context.reserveView(a, randomUUID()),
        'third device view across owners refused',
      );
      views.push(first.context.reserveView(device(), randomUUID()));
      views.push(first.context.reserveView(device(), randomUUID()));
      busy(() => first.context.reserveView(device(), randomUUID()), 'fifth session view refused');
      for (let index = 0; index < 2; index++)
        views.push(second.context.reserveView(device(), randomUUID()));
      busy(() => third.context.reserveView(device(), randomUUID()), 'ninth home view refused');
      assert.equal(records(home).filter((row) => row.kind === 'view').length, 8);
      assert(first.context.available && second.context.available && third.context.available);
      for (const view of views) view.retire();
      assert(await first.host.closeAll());
      assert(await second.host.closeAll());
      assert.equal(records(home).length, 3, 'foreign live model and views remain charged');
    } catch (error) {
      failures.push(error);
    }
    for (const view of views) view.retire();
    const cleanup = await Promise.allSettled([
      (async () => {
        fs.writeFileSync(`${prefix}.go`, 'release');
        assert.equal(await remote.exited, 0, await remoteErrors);
        assert.equal(await remoteOutput, '');
        assert.throws(
          () => process.kill(remote.pid, 0),
          (error) => (error as NodeJS.ErrnoException).code === 'ESRCH',
          'remote resource owner reaped',
        );
      })(),
      ...consumers.map(async (value) => {
        try {
          await value.close();
        } finally {
          await value.host.closeAll();
        }
      }),
    ]);
    failures.push(
      ...cleanup.flatMap((value) => (value.status === 'rejected' ? [value.reason] : [])),
    );
    if (failures.length)
      throw new AggregateError(failures, 'Owned quota scenario or cleanup failed');
    assert.equal(records(home).length, 0);
    return { quarantined: false };
  }
  const f = await consumer(home, command);
  const view = f.context.reserveView(device(), randomUUID());
  let pair: Awaited<ReturnType<typeof createNativeTerminalPair>> | undefined;
  let quarantined = false;
  try {
    if (name === OWNERSHIP_GROUPS[12]) {
      view.retire();
      const frame = f.context.borrow();
      assert(frame);
      frame.quarantine();
      frame.quarantine();
      assert.equal(f.host.contextFor(f.id), null);
      assert.equal(await f.host.closeAll(), false, 'bare quarantine retains model accounting');
      assert.equal(records(home).length, 1);
      assert(f.pty.isRunning);
      return { quarantined: true, quarantinedRows: 1 };
    }
    if (name === OWNERSHIP_GROUPS[10]) {
      const path = join(home, 'terminal-view/reservations.json');
      const ledger = JSON.parse(fs.readFileSync(path, 'utf8'));
      ledger.records = ledger.records.filter((row: { kind: string }) => row.kind !== 'view');
      writeRestrictedJson(path, ledger);
      assert.equal(view.available, false, 'lost view row permits no frame');
      assert.equal(f.host.contextFor(f.id), null);
      assert(await f.host.closeAll());
      assert.equal(records(home).length, 0);
      assert(f.pty.isRunning);
      return { quarantined: false };
    }
    if (name === OWNERSHIP_GROUPS[11]) {
      const prefix = join(home, 'holder');
      const holder = Bun.spawn([...command, '--terminal-lock', home, prefix], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        cwd: home,
        env: {
          PATH: process.env['PATH'] ?? '/usr/bin:/bin',
          LANG: 'en_US.UTF-8',
          TMPDIR: tmpdir(),
        },
      });
      const errors = new Response(holder.stderr).text();
      try {
        await until(
          () => fs.existsSync(`${prefix}.ready`) || holder.exitCode !== null,
          'actual view lock held',
        );
        assert.equal(holder.exitCode, null);
        const start = performance.now();
        assert.equal(view.available, false);
        assert.equal(view.borrow(), null);
        assert(performance.now() - start < 1000, 'view quota check remains nonblocking');
        assert(f.context.available, 'busy metadata does not retire original capture');
      } finally {
        fs.writeFileSync(`${prefix}.go`, 'release');
        assert.equal(await holder.exited, 0, await errors);
        assert.throws(
          () => process.kill(holder.pid, 0),
          (error) => (error as NodeJS.ErrnoException).code === 'ESRCH',
          'actual lock holder reaped',
        );
      }
      assert(view.available);
      (await borrowed(view)).release();
      view.retire();
      assert(await f.host.closeAll());
      return { quarantined: false };
    }
    if (name === OWNERSHIP_GROUPS[1]) {
      const second = f.context.reserveView(device(), randomUUID());
      const frame = await borrowed(view);
      assert.equal(second.borrow(), null, 'one shared model projection across views');
      view.retire();
      view.retire();
      f.host.retireSession(f.id);
      assert.equal(await f.host.closeAll(), false, 'borrowed view prevents model release');
      assert.equal(records(home).filter((row) => row.kind === 'view').length, 1);
      assert(f.pty.isRunning);
      frame.release();
      frame.release();
      assert(await f.host.closeAll());
      assert.equal(records(home).length, 0);
      return { quarantined: false };
    }
    if (name === OWNERSHIP_GROUPS[15] || name === OWNERSHIP_GROUPS[16]) {
      pair = await createNativeTerminalPair();
      const native = pair;
      const send = native.ws.send;
      let nativeCalls = 0;
      let released = 0;
      let uncertain = 0;
      let outcome: TerminalSendOutcome | undefined;
      let savedDeliver:
        | ((
            owned: import('../../src/terminal/send-slot.ts').OwnedTerminalSend,
          ) => TerminalSendOutcome)
        | undefined;
      let offered: import('../../src/terminal/send-slot.ts').OwnedTerminalSend | undefined;
      let beforeDispatch: number | undefined;
      let afterDispatch: number | undefined;
      let acknowledged = false;
      let expected = '';
      native.ws.send = (text, compress) => {
        nativeCalls++;
        if (name === OWNERSHIP_GROUPS[15]) {
          beforeDispatch = f.dispatchedBytes();
          fs.writeFileSync(
            `${f.prefix}.next`,
            JSON.stringify({
              sequence: 1,
              kind: 'output',
              output: Buffer.from('X').toString('base64'),
            }),
          );
          fs.renameSync(`${f.prefix}.next`, `${f.prefix}.command`);
          const end = performance.now() + 1000;
          while (!fs.existsSync(`${f.prefix}.ack`) && performance.now() < end) Bun.sleepSync(1);
          acknowledged =
            fs.existsSync(`${f.prefix}.ack`) &&
            JSON.parse(fs.readFileSync(`${f.prefix}.ack`, 'utf8')).sequence === 1;
        }
        const status = send.call(native.ws, text, compress);
        afterDispatch = f.dispatchedBytes();
        return status;
      };
      assert(
        native.slot.schedule((deliver) => {
          const frame = view.borrow();
          assert(frame);
          const message = {
            type: 'session_terminal_snapshot' as const,
            id: randomUUID(),
            timestamp: new Date().toISOString(),
            sessionId: f.id,
            requestId: randomUUID(),
            viewId: randomBytes(16).toString('base64url'),
            revision: frame.revision,
            ...frame.snapshot,
          };
          expected = encodeTerminalViewFrame(message);
          offered = {
            message,
            release() {
              released++;
              frame.release();
            },
            quarantine() {
              uncertain++;
              frame.quarantine();
            },
          };
          if (name === OWNERSHIP_GROUPS[16]) savedDeliver = deliver;
          else outcome = deliver(offered);
          return undefined;
        }),
      );
      if (name === OWNERSHIP_GROUPS[16]) {
        await until(() => savedDeliver !== undefined, 'escaped callback was captured');
        const late = savedDeliver;
        const owner = offered;
        assert(late && owner);
        outcome = late(owner);
        assert.equal(nativeCalls, 0, 'escaped delivery never enters native send');
        assert.equal(outcome, 'unavailable');
        assert.equal(released, 0);
        assert.equal(uncertain, 1);
        assert.equal(
          native.ws.readyState,
          WebSocket.OPEN,
          'escaped terminal failure preserves original peer',
        );
        assert.equal(view.available, false);
        assert.equal(await f.host.closeAll(), false);
        assert.equal(records(home).length, 2, 'escaped delivery retains model and view accounting');
        quarantined = true;
      } else {
        await until(() => outcome !== undefined, 'actual native handoff completed');
        assert(acknowledged, 'independent actual PTY writer acknowledged during handoff');
        assert.equal(nativeCalls, 1);
        assert.equal(
          afterDispatch,
          beforeDispatch,
          'actual native handoff dispatches no queued PTY callback',
        );
        const observedBefore = beforeDispatch;
        assert(observedBefore !== undefined);
        await until(
          () => f.dispatchedBytes() > observedBefore,
          'actual queued PTY output arrives after handoff',
        );
        native.resumePeer();
        await until(
          () => native.receivedFrame(expected),
          'actual synchronous handoff frame received',
        );
      }
      return { quarantined, capacityBytes: native.capacity() };
    }
    pair = await createNativeTerminalPair();
    const native = pair;
    let constructed = 0;
    let released = 0;
    let uncertain = 0;
    let releasedAtReentry: number | undefined;
    let duplicateOutcome: TerminalSendOutcome | undefined;
    let releasedAfterDuplicate: number | undefined;
    let secondScheduled: boolean | undefined;
    let outcome: TerminalSendOutcome | undefined;
    let expected = '';
    const offer = () =>
      native.slot.schedule((deliver) => {
        assert(!native.insideMessage(), 'terminal encoding occurs after native message cork');
        const frame = view.borrow();
        assert(frame, 'actual capture frame admitted');
        constructed++;
        const message = {
          type: 'session_terminal_snapshot' as const,
          id: randomUUID(),
          timestamp: new Date().toISOString(),
          sessionId: f.id,
          requestId: randomUUID(),
          viewId: randomBytes(16).toString('base64url'),
          revision: frame.revision,
          ...frame.snapshot,
        };
        expected = encodeTerminalViewFrame(message);
        // Establish real pressure immediately before preflight, without a timer gap.
        if (name === OWNERSHIP_GROUPS[6]) native.fill();
        const owned = {
          message,
          release() {
            released++;
            frame.release();
          },
          quarantine() {
            uncertain++;
            frame.quarantine();
          },
        };
        outcome = deliver(owned);
        if (name === OWNERSHIP_GROUPS[14]) {
          duplicateOutcome = deliver(owned);
          releasedAfterDuplicate = released;
        }
        return undefined;
      });
    if (name === OWNERSHIP_GROUPS[7]) {
      assert(offer());
      native.slot.retire();
      await wait(20);
      assert.equal(constructed, 0, 'retired unsent operation never borrows');
      assert.equal(native.slot.busy, false);
    } else {
      if (
        name === OWNERSHIP_GROUPS[3] ||
        name === OWNERSHIP_GROUPS[4] ||
        name === OWNERSHIP_GROUPS[5]
      )
        native.pressureAtSend(name === OWNERSHIP_GROUPS[5]);
      if (name === OWNERSHIP_GROUPS[8])
        native.pressureAtSend(false, () => {
          native.slot.nativeDrained();
          releasedAtReentry = released;
        });
      if (name === OWNERSHIP_GROUPS[9]) native.pressureAtSend(false, undefined, true);
      if (name === OWNERSHIP_GROUPS[13]) native.pressureAtSend(false, undefined, false, true);
      if (name === OWNERSHIP_GROUPS[14]) native.pressureAtSend();
      native.fromMessage(() => {
        assert(offer());
        secondScheduled = offer();
      });
      await until(() => outcome !== undefined, 'actual native send outcome');
      assert.equal(secondScheduled, false, 'one scheduled operation slot');
      assert.equal(constructed, 1);
      if (name === OWNERSHIP_GROUPS[14]) {
        assert.equal(outcome, 'pending');
        assert.equal(duplicateOutcome, 'unavailable');
        assert.equal(
          releasedAfterDuplicate,
          0,
          'duplicate delivery never releases aliased pending ownership',
        );
      }
      if (name === OWNERSHIP_GROUPS[8])
        assert.equal(releasedAtReentry, 0, 'reentrant native drain retains entered projection');
      if (name === OWNERSHIP_GROUPS[13])
        assert.equal(
          outcome,
          'unavailable',
          'oversized native queue is never accepted as a pending projection',
        );
      if (name === OWNERSHIP_GROUPS[2]) {
        assert.equal(outcome, 'sent');
        assert.equal(released, 1);
        assert.equal(uncertain, 0);
        native.resumePeer();
        await until(() => native.receivedFrame(expected), 'actual strict terminal frame received');
      } else if (name === OWNERSHIP_GROUPS[6]) {
        assert.equal(outcome, 'unavailable', 'preexisting native pressure permits no new frame');
        assert.equal(released, 1);
        assert.equal(uncertain, 0);
        assert(view.available);
        native.resumePeer();
      } else {
        if (name !== OWNERSHIP_GROUPS[9])
          assert(native.ws.getBufferedAmount() > 0, 'actual native terminal bytes remain pending');
        if (
          name !== OWNERSHIP_GROUPS[5] &&
          name !== OWNERSHIP_GROUPS[9] &&
          name !== OWNERSHIP_GROUPS[13] &&
          name !== OWNERSHIP_GROUPS[14]
        ) {
          assert.equal(outcome, 'pending');
          assert.equal(released, 0);
          assert.equal(uncertain, 0);
          assert.equal(offer(), false, 'pending native frame blocks another operation');
        }
        if (name === OWNERSHIP_GROUPS[3] || name === OWNERSHIP_GROUPS[8]) {
          native.slot.retire();
          view.retire();
          assert.equal(
            await f.host.closeAll(),
            false,
            'logical retirement retains pending view charge',
          );
          assert.equal(records(home).length, 2, 'pending projection retains model and view');
          native.resumePeer();
          await until(() => released === 1, 'actual native drain releases borrowed slot');
          assert.equal(uncertain, 0);
          assert(await f.host.closeAll());
          assert.equal(records(home).length, 0);
        } else {
          if (name === OWNERSHIP_GROUPS[4]) native.ws.close();
          assert.equal(uncertain, 1, 'uncertain native disposal quarantines exactly once');
          native.slot.nativeClosed();
          native.slot.nativeDrained();
          assert.equal(released, 0);
          assert.equal(uncertain, 1);
          assert.equal(view.available, false);
          assert.equal(
            await f.host.closeAll(),
            false,
            'uncertain native copy retains fixed charge',
          );
          assert.equal(records(home).length, 2, 'quarantine preserves model and view accounting');
          assert(f.pty.isRunning);
          if (name === OWNERSHIP_GROUPS[5])
            assert.equal(
              native.ws.readyState,
              WebSocket.OPEN,
              'optional terminal failure keeps original peer open',
            );
          native.resumePeer();
          await until(
            () => native.receivedFrame(expected),
            'closed/uncertain native transport can still deliver its queued frame',
          );
          quarantined = true;
        }
      }
    }
    return { quarantined, capacityBytes: native.capacity() };
  } finally {
    await pair?.close();
    view.retire();
    await f.host.closeAll();
    await f.close();
  }
}

export async function runTerminalOwnershipProof(command: readonly string[]) {
  const groups = [];
  for (const name of OWNERSHIP_GROUPS) {
    const home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'terminal-view-owner-')));
    const proc = Bun.spawn(
      [
        ...command,
        '--terminal-owner',
        name,
        home,
        ...(process.argv.includes('--negative-write') ? ['--negative-write'] : []),
      ],
      {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        cwd: home,
        env: {
          PATH: process.env['PATH'] ?? '/usr/bin:/bin',
          LANG: 'en_US.UTF-8',
          TMPDIR: tmpdir(),
        },
      },
    );
    const output = new Response(proc.stdout).text();
    const errors = new Response(proc.stderr).text();
    const watchdog = setTimeout(() => proc.kill('SIGTERM'), 20000);
    const code = await proc.exited;
    clearTimeout(watchdog);
    const stdout = await output;
    const stderr = await errors;
    if (code !== 0 || stderr) {
      fs.writeFileSync(join(home, 'owner.stdout'), stdout);
      fs.writeFileSync(join(home, 'owner.stderr'), stderr);
      console.error('Owned terminal ownership evidence retained', home);
    }
    assert.equal(code, 0, `${name}: ${stderr}`);
    assert.equal(stderr, '', `${name} owned stderr`);
    assert.throws(
      () => process.kill(proc.pid, 0),
      (error) => (error as NodeJS.ErrnoException).code === 'ESRCH',
      'actual ownership child reaped',
    );
    const receipt = JSON.parse(stdout);
    if (receipt.quarantined) {
      assert.equal(
        records(home).length,
        receipt.quarantinedRows ?? 2,
        'quarantine outlives its exited process',
      );
      const ledger = TerminalReservations.open(home);
      const model = ledger.reserveModel(randomUUID());
      assert.equal(records(home).length, 1, 'only proved dead owner is reclaimed');
      ledger.release(model);
    }
    assert.equal(records(home).length, 0, 'owned proof resources retired or dead-owner reclaimed');
    groups.push({ name, ...receipt });
    fs.rmSync(home, { recursive: true, force: true });
  }
  return groups;
}
