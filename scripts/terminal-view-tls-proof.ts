/** Actual TLS receipt barrier with the admitted maximum text and no input (#1646). */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeTerminalViewFrame } from '@remi/shared';
import { PTYSession } from '../packages/daemon/src/pty/pty-session.ts';
import { TerminalCaptureHost } from '../packages/daemon/src/terminal/capture-host.ts';
import { runOwnedTerminalOutputChild } from '../packages/daemon/tests/helpers/terminal-output-child.ts';
import {
  createNativeTlsTerminalPair,
  runNativeTlsNetworkPeer,
} from '../packages/daemon/tests/helpers/terminal-tls-pair.ts';

import { TerminalSendSlot } from '../packages/daemon/src/terminal/send-slot.ts';
const groups = [
  'ordered-receipt',
  'reentrant-pong',
  'stale-receipt',
  'retired-receipt',
  'entered-ping-error',
  'close-during-ping',
  'close-pending-projection',
  'missing-ping',
  'unknown-completion',
] as const;
type Group = (typeof groups)[number];
async function runCase(kind: Group): Promise<unknown> {
  const pair = await createNativeTlsTerminalPair();
  const home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'terminal-tls-model-')));
  const prefix = join(home, 'child');
  const sessionId = randomUUID();
  const initial = Array.from(
    { length: 60 },
    (_, i) =>
      '"'.repeat(i < 58 ? 138 : 136) + '\u{1d11e}'.repeat(i < 58 ? 102 : 103) + (i < 58 ? '' : 'é'),
  ).join('');
  assert.equal(Buffer.byteLength(initial), 32768, 'previously qualified maximum UTF16 profile');
  const command = Bun.main.startsWith('/$bunfs/')
    ? [process.execPath]
    : [process.execPath, '--no-env-file', Bun.main];
  const pty = new PTYSession(
    {
      command: command[0] as string,
      args: [...command.slice(1), '--owned-output-child', prefix, initial],
      cwd: home,
      env: { HOME: home },
      size: { cols: 240, rows: 60 },
    },
    {},
  );
  const host = new TerminalCaptureHost(home);
  let released = 0;
  let quarantined = 0;
  let encoded = '';
  let outcome: string | undefined;
  let beforeKernel = 0;
  let afterKernel = 0;
  let afterNative = 0;
  let view: ReturnType<NonNullable<ReturnType<typeof host.contextFor>>['reserveView']> | undefined;
  let evidence: unknown;
  let complete = false;
  let expectQuarantine = false;
  let nativeCalls = 0;
  let pingCalls = 0;
  const until = async (check: () => boolean, name: string) => {
    const end = performance.now() + 10000;
    while (!check()) {
      assert(performance.now() < end, name);
      await Bun.sleep(2);
    }
  };
  try {
    assert(await host.prepare(sessionId, pty));
    await pty.start();
    await until(() => fs.existsSync(`${prefix}.ready`), 'actual owned PTY ready');
    await until(() => {
      const f = host.contextFor(sessionId)?.borrow();
      f?.release();
      return !!f;
    }, 'complete actual snapshot');
    const context = host.contextFor(sessionId);
    assert(context);
    view = context.reserveView(
      createHash('sha256').update(randomBytes(32)).digest('hex'),
      randomUUID(),
    );
    const originalSend = pair.ws.send;
    pair.ws.send = (text, compress) => {
      nativeCalls++;
      return originalSend.call(pair.ws, text, compress);
    };
    const originalPing = pair.ws.ping;
    if (kind === 'missing-ping') Reflect.set(pair.ws, 'ping', undefined);
    else
      pair.ws.ping = (nonce) => {
        pingCalls++;
        if (kind === 'reentrant-pong' && nonce instanceof Uint8Array) {
          pair.slot.nativeDrained();
          pair.slot.nativePong(nonce);
        }
        if (kind === 'close-during-ping') pair.ws.close();
        const result = originalPing.call(pair.ws, nonce);
        if (kind === 'entered-ping-error') throw new Error('Owned post-native ping failure');
        return result;
      };
    if (kind === 'unknown-completion')
      pair.replaceSlot(new TerminalSendSlot(pair.ws, 'unknown' as never));
    if (kind === 'missing-ping' || kind === 'unknown-completion') {
      let entered = false;
      assert.equal(
        pair.slot.schedule(() => {
          entered = true;
          return undefined;
        }),
        false,
        'unproved native completion never schedules',
      );
      await Bun.sleep(20);
      assert.equal(entered, false);
      assert.equal(nativeCalls, 0);
      assert.equal(pingCalls, 0);
      complete = true;
      return { name: kind, nativeCalls, pingCalls, actualChildInputBytes: 0 };
    }
    assert.equal(pair.ws.getBufferedAmount(), 0);
    const enqueue = () => {
      assert(
        pair.slot.schedule((deliver) => {
          const frame = view?.borrow();
          assert(frame);
          const message = {
            id: randomUUID(),
            requestId: randomUUID(),
            timestamp: new Date().toISOString(),
            sessionId,
            type: 'session_terminal_snapshot' as const,
            viewId: randomBytes(16).toString('base64url'),
            revision: frame.revision,
            ...frame.snapshot,
          };
          encoded = encodeTerminalViewFrame(message);
          beforeKernel = pair.kernelQueuedBytes();
          outcome = deliver({
            message,
            release() {
              released++;
              frame.release();
            },
            quarantine() {
              quarantined++;
              frame.quarantine();
            },
          });
          afterNative = pair.ws.getBufferedAmount();
          afterKernel = pair.kernelQueuedBytes();
          return undefined;
        }),
      );
    };
    enqueue();
    await until(() => outcome !== undefined, 'actual native send outcome');
    const bytes = Buffer.byteLength(encoded);
    evidence = {
      version: Bun.version,
      revision: Bun.revision,
      platform: process.platform,
      architecture: process.arch,
      encodedBytes: bytes,
      senderCapacity: pair.senderCapacity,
      receiverCapacity: pair.receiverCapacity,
      kernelBefore: beforeKernel,
      kernelAfter: afterKernel,
      nativeBufferedAfter: afterNative,
      outcome,
      releasedBeforePeerResume: released,
      quarantinedBeforePeerResume: quarantined,
      conservativeHiddenPlaintextMinimum: Math.max(
        0,
        bytes - afterKernel - (pair.receiverCapacity ?? 0),
      ),
      scope:
        'actual TLS and C1 sender with OS-stopped independent bounded TCP peer and real launch-captured PTY; native ownership characterization only',
    };
    if (
      kind === 'entered-ping-error' ||
      kind === 'close-during-ping' ||
      kind === 'close-pending-projection'
    ) {
      if (kind === 'close-pending-projection') pair.ws.close();
      expectQuarantine = true;
      pair.resumePeer();
      await until(() => quarantined === 1, 'uncertain actual native ping or close quarantines');
      assert.equal(released, 0, 'uncertain native TLS completion never releases');
      assert.equal(context.available, false, 'uncertain TLS copy retires its capture');
      if (kind === 'entered-ping-error') {
        assert.equal(
          pair.ws.readyState,
          WebSocket.OPEN,
          'optional ping failure preserves original socket',
        );
        await until(() => pair.receivedFrame(encoded), 'entered native frame can still arrive');
      }
      assert.equal(
        pair.slot.schedule(() => undefined),
        false,
        'quarantined sender never restarts',
      );
      evidence = {
        ...(evidence as object),
        name: kind,
        nativeCalls,
        pingCalls,
        quarantined,
        actualChildInputBytes: 0,
        retainedRoot: home,
      };
    } else {
      assert.equal(released, 0, 'TLS projection stays borrowed before its native receipt');
      assert.equal(outcome, 'pending');
      if (kind === 'retired-receipt') {
        pair.slot.retire();
        view.retire();
        assert.equal(
          pair.slot.schedule(() => undefined),
          false,
          'retired TLS sender queues no new operation',
        );
      }
      pair.holdPongs();
      pair.resumePeer();
      await until(
        () => pair.receivedFrame(encoded) && pair.pingReceived(),
        'full frame precedes actual native ping',
      );
      await until(
        () => pair.ws.getBufferedAmount() === 0 && pair.nativeDrains() > 0,
        'actual native drain at plaintext zero',
      );
      assert.equal(released, 0, 'plaintext zero plus actual drain is insufficient without receipt');
      pair.shortPong();
      await until(() => pair.nativePongs() === 1, 'actual short native pong arrived');
      assert.equal(released, 0, 'short native receipt preserves ownership');
      pair.wrongPong();
      await until(() => pair.nativePongs() === 2, 'actual wrong native pong arrived');
      assert.equal(released, 0, 'wrong native receipt preserves ownership');
      pair.confirmPong();
      await until(
        () => pair.nativePongs() === 3 && released === 1,
        'matching actual native pong releases ownership',
      );
      if (kind === 'stale-receipt') {
        outcome = undefined;
        enqueue();
        await until(
          () => outcome !== undefined && pair.receivedFrame(encoded) && pair.receivedPings() === 2,
          'second actual native receipt is pending',
        );
        pair.oldPong();
        await until(() => pair.nativePongs() === 4, 'actual stale native pong arrived');
        assert.equal(released, 1, 'stale native receipt cannot release a fresh frame');
        pair.confirmPong();
        await until(
          () => pair.nativePongs() === 5 && released === 2,
          'fresh native receipt releases second frame',
        );
      }
      assert.equal(quarantined, 0);
      assert.equal(pair.slot.busy, false);
      evidence = {
        ...(evidence as object),
        name: kind,
        nativeCalls,
        pingCalls,
        nativeDrains: pair.nativeDrains(),
        wrongPongIgnored: true,
        matchingPongReleased: true,
        actualChildInputBytes: 0,
      };
    }
    if (process.argv.includes('--negative-write')) {
      await pty.write('X');
      await Bun.sleep(100);
    }
    complete = true;
  } finally {
    view?.retire();
    await pair.close();
    await pty.close(1000);
    assert.equal(
      await host.closeAll(),
      !expectQuarantine,
      'TLS accounting releases only proved disposal',
    );
    if (expectQuarantine) {
      const rows = JSON.parse(
        fs.readFileSync(join(home, 'terminal-view/reservations.json'), 'utf8'),
      ).records as { kind: string }[];
      assert.deepEqual(
        rows.map((row) => row.kind).sort(),
        ['model', 'view'],
        'uncertain TLS model and view remain charged',
      );
    }
    assert.equal(
      quarantined,
      expectQuarantine ? 1 : 0,
      'native TLS quarantine settles at most once',
    );
    assert.equal(
      released,
      nativeCalls === 0 || expectQuarantine ? 0 : kind === 'stale-receipt' ? 2 : 1,
      'native TLS release settles at most once',
    );
    assert.equal(
      JSON.parse(fs.readFileSync(`${prefix}.input`, 'utf8')).inputBytes,
      0,
      'TLS receipt proof writes zero child input',
    );
    if (complete && !expectQuarantine) fs.rmSync(home, { recursive: true, force: true });
    else if (!complete) console.error(`Failed owned model root: ${home}`);
  }
  return evidence;
}
const peerIndex = process.argv.indexOf('--terminal-tls-peer');
if (peerIndex >= 0) {
  await runNativeTlsNetworkPeer(
    process.argv[peerIndex + 1] as string,
    process.argv[peerIndex + 2] as string,
  );
} else if (process.argv.includes('--owned-output-child')) {
  const at = process.argv.indexOf('--owned-output-child');
  await runOwnedTerminalOutputChild(process.argv[at + 1] as string, process.argv[at + 2] as string);
} else {
  const at = process.argv.indexOf('--tls-case');
  const selected = at < 0 ? groups : groups.filter((group) => group === process.argv[at + 1]);
  assert(selected.length > 0, 'known TLS proof case');
  const results = [];
  for (const group of selected) results.push(await runCase(group));
  console.log(
    JSON.stringify({
      status: 'passed',
      version: Bun.version,
      revision: Bun.revision,
      platform: process.platform,
      architecture: process.arch,
      groups: results,
    }),
  );
}
