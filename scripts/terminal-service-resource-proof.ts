import { fullGC, heapStats } from 'bun:jsc';
/** Actual signedWSS model/service capacity; combined/heldNo/caller qualification is separate. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentity, encodeTerminalViewFrame } from '@remi/shared';
import { TERMINAL_RESERVATION_LIMITS } from '../packages/daemon/src/terminal/reservations.ts';
import { type BoundedScreen, SCREEN_LIMITS } from '../packages/daemon/src/terminal/screen.ts';
import type {
  OwnedTerminalSend,
  TerminalSendSlot,
} from '../packages/daemon/src/terminal/send-slot.ts';
import { runOwnedTerminalOutputChild } from '../packages/daemon/tests/helpers/terminal-output-child.ts';
import {
  terminalServiceFixture,
  until,
} from '../packages/daemon/tests/helpers/terminal-service-fixture.ts';
import {
  type TerminalResourcePeerSpec,
  boundResourceSocket,
  ownedTerminalResourceFiles,
  publishResourceReceipt,
  resourceSocketTuples,
  runTerminalResourcePeers,
} from '../packages/daemon/tests/helpers/terminal-service-resource-support.ts';

const args = process.argv.slice(2);
const strictIngress = args.includes('--strict-ingress-utf16')
  ? 'utf16'
  : args.includes('--strict-ingress-refusal-nodes')
    ? 'nodes'
    : null;
const argument = (name: string, offset = 1) => {
  const index = args.indexOf(name);
  const value = args[index + offset];
  assert(index >= 0 && value, `owned ${name} argument`);
  return value;
};
if (args.includes('--owned-output-child')) {
  await runOwnedTerminalOutputChild(
    argument('--owned-output-child'),
    args[args.indexOf('--owned-output-child') + 2] ?? '',
  );
  process.exit(0);
}
if (args.includes('--terminal-resource-peer'))
  await runTerminalResourcePeers(
    argument('--terminal-resource-peer'),
    argument('--terminal-resource-peer', 2),
  );

if (args.includes('--external-calibration')) {
  fullGC();
  const before = heapStats();
  assert(before.extraMemorySize < 2 * 1024 * 1024);
  const data = new Uint8Array(8 * 1024 * 1024);
  data[0] = 1;
  data[data.length - 1] = 2;
  fullGC();
  const after = heapStats();
  assert(after.extraMemorySize >= data.byteLength && after.heapSize >= after.extraMemorySize);
  assert(data[0] === 1 && data[data.length - 1] === 2);
  console.log(
    JSON.stringify({
      status: 'passed',
      bytes: data.byteLength,
      version: Bun.version,
      revision: Bun.revision,
    }),
  );
  process.exit(0);
}
const memory = () => {
  fullGC();
  const stats = heapStats();
  return { heap: stats.heapSize, extra: stats.extraMemorySize, charge: stats.heapSize };
};
const bytes = (text: string) => new TextEncoder().encode(text);
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
  assert.equal(Buffer.byteLength(rows.join('')), 32768);
  chunks.push(bytes(`\x1b[H${rows.join('')}`));
}
const parserInput = bytes('x'.repeat(8192));
async function runProfile(measured: boolean) {
  const evidencePath = args.includes('--terminal-resource-evidence')
    ? argument('--terminal-resource-evidence')
    : null;
  const certificateRoot = argument('--terminal-tls-root');
  const coordination =
    measured && args.includes('--terminal-service-coordination')
      ? {
          prefix: argument('--terminal-service-coordination'),
          owner: argument('--terminal-service-owner'),
        }
      : null;
  if (coordination) assert(coordination.owner === '0' || coordination.owner === '1');
  const sharedHome = coordination ? argument('--terminal-shared-home') : undefined;
  const files = ownedTerminalResourceFiles(certificateRoot, sharedHome);
  const phase = (name: string) => `${coordination?.prefix}.${coordination?.owner}.${name}`;
  const waitPhase = async (name: string) => {
    assert(coordination);
    const end = performance.now() + 60000;
    while (!fs.existsSync(phase(name))) {
      assert(performance.now() < end, `owned cross-process setup barrier: ${name}`);
      await Bun.sleep(5);
    }
  };
  const fixture = await terminalServiceFixture({
    files,
    deferredCapture: true,
    size: { cols: 240, rows: 60 },
    initialOutput: '',
    ...(coordination && { childPrefix: join(files.directory, 'terminal-child') }),
  });
  const prefix = join(files.directory, 'peer');
  const identities = await Promise.all(Array.from({ length: 4 }, () => createIdentity()));
  for (const [index, identity] of identities.entries())
    await fixture.trust.addAuthorizedKey(identity.publicKey, `owned resource peer ${index}`);
  const spec: TerminalResourcePeerSpec = {
    port: fixture.server.port,
    ca: files.ca,
    serverPublicKey: fixture.trust.load()?.publicKey ?? '',
    sessionId: fixture.sessionId,
    binding: fixture.binding(),
    identities,
  };
  assert(spec.serverPublicKey);
  const specPath = join(files.directory, 'peer-spec.json');
  fs.writeFileSync(specPath, JSON.stringify(spec), { mode: 0o600 });
  const command = Bun.main.startsWith('/$bunfs/')
    ? [process.execPath]
    : [process.execPath, '--no-env-file', Bun.main];
  let peer: ReturnType<typeof Bun.spawn> | undefined;
  let peerStdout: Promise<string> | undefined;
  let peerStderr: Promise<string> | undefined;
  let passed = false;
  let sequence = 0;
  type RecordState = {
    slot: TerminalSendSlot;
    intent: unknown;
    borrowing: boolean;
  };
  const records = Reflect.get(fixture.service, 'records') as Map<object, RecordState>;
  const state = () =>
    JSON.parse(fs.readFileSync(`${prefix}.state`, 'utf8')) as {
      pid: number;
      sequence: number;
      states: {
        ready: boolean;
        localPort: number;
        receiverCapacity: number;
        drainCapacity: number;
        viewId: string;
        requests: string[];
        frames: { type: string; requestId: string; bytes: number; digest: string }[];
      }[];
    };
  const control = (action: string, index = 0, twice = false) =>
    publishResourceReceipt(`${prefix}.command`, {
      sequence: ++sequence,
      action,
      index,
      twice,
      ...(strictIngress && { ingressProfile: strictIngress }),
      ...(strictIngress === 'nodes' &&
        action === 'read-all' && { afterRevision: Number.MAX_SAFE_INTEGER }),
    });
  const isStopped = () => {
    assert(peer && peer.exitCode === null);
    return process.platform === 'linux'
      ? /^State:\s+[Tt]/m.test(fs.readFileSync(`/proc/${peer.pid}/status`, 'utf8'))
      : Bun.spawnSync(['/bin/ps', '-p', String(peer.pid), '-o', 'state='])
          .stdout.toString()
          .trim()
          .startsWith('T');
  };
  const resume = () => {
    if (peer?.exitCode === null) process.kill(peer.pid, 'SIGCONT');
  };
  const admissions = new Map<string, { id: string; admitted: boolean }>();
  const originalHandle = fixture.service.handle;
  let stopNextRead = false;
  fixture.service.handle = (id, ingress) => {
    if (
      stopNextRead &&
      ingress.kind === 'request' &&
      ingress.request.type === 'session_terminal_read'
    ) {
      assert(peer?.exitCode === null);
      stopNextRead = false;
      const sentEnd = performance.now() + 1000;
      while (
        !fs.existsSync(`${prefix}.sent`) ||
        JSON.parse(fs.readFileSync(`${prefix}.sent`, 'utf8')).sequence !== sequence
      ) {
        assert(performance.now() < sentEnd, 'all actual requests sent before receiver stop');
        Bun.sleepSync(1);
      }
      process.kill(peer.pid, 'SIGSTOP');
      const end = performance.now() + 1000;
      while (!isStopped()) {
        assert(performance.now() < end, 'owned resource receiver really stopped');
        Bun.sleepSync(1);
      }
    }
    const result = originalHandle.call(fixture.service, id, ingress);
    if (
      coordination &&
      ingress.kind === 'request' &&
      ingress.request.type === 'session_terminal_open'
    ) {
      const actorConnection = fixture.adapter.getDirectConnection(id);
      admissions.set(id, {
        id: ingress.request.id,
        admitted: !!actorConnection && records.has(actorConnection),
      });
    }
    return result;
  };
  try {
    const child = Bun.spawn([...command, '--terminal-resource-peer', specPath, prefix], {
      cwd: files.directory,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        HOME: files.userHome,
        REMI_HOME: files.home,
        TMPDIR: tmpdir(),
        PATH: process.env['PATH'] ?? '/usr/bin:/bin',
        LANG: 'en_US.UTF-8',
      },
    });
    peer = child;
    peerStdout = new Response(child.stdout).text();
    peerStderr = new Response(child.stderr).text();
    await until(
      () => fs.existsSync(`${prefix}.ready`) || child.exitCode !== null,
      'four actual signed resource peers ready',
    );
    assert.equal(child.exitCode, null, child.exitCode !== null ? await peerStderr : '');
    assert.equal(state().pid, child.pid);
    assert.equal(state().states.length, 4);
    assert.equal(fixture.connectionIds.length, 4);
    assert(
      state().states.every(
        (row) =>
          row.ready &&
          row.receiverCapacity > 0 &&
          row.receiverCapacity <= 8192 &&
          row.drainCapacity === 0,
      ),
    );
    assert.equal(fixture.pty.sessionState, 'created');
    assert.equal(
      fixture.capture.contextFor(fixture.sessionId),
      null,
      'network precedes actual model admission',
    );
    assert.equal(records.size, 0);
    const tuples = resourceSocketTuples(spec.port, 'server');
    for (const row of state().states) {
      const matches = tuples.filter((tuple) => tuple.remote === row.localPort);
      assert.equal(matches.length, 1, 'exact authenticated sender tuple');
      const tuple = matches[0];
      assert(tuple);
      boundResourceSocket(tuple.fd, 'send');
    }
    if (coordination) {
      publishResourceReceipt(phase('network'), {
        pid: process.pid,
        sessionId: fixture.sessionId,
        peers: 4,
      });
      await waitPhase('baseline-go');
    }
    const before = memory();
    if (coordination) {
      publishResourceReceipt(phase('baseline'), {
        before,
        modelAbsent: fixture.capture.contextFor(fixture.sessionId) === null,
      });
      await waitPhase('admit-go');
    }
    const nativeCopyAllowance = new Uint8Array(65546);
    const pressureAllowance = new Uint8Array(17418);
    const tlsWorkingAllowance = new Uint8Array(198666);
    const envelopeAllowance = new Uint8Array(1024);
    const ingressHandoffAllowance = new Uint8Array(16384);
    await fixture.startCapture();
    const source = JSON.parse(fs.readFileSync(`${fixture.prefix}.ready`, 'utf8'));
    assert.deepEqual(source.size, [240, 60]);
    for (let index = 0; index < 4; index++) {
      for (let attempt = 0; ; attempt++) {
        control('open', index);
        await until(() => {
          const current = state();
          if (current.states[index]?.viewId) return true;
          if (!coordination || current.sequence !== sequence) return false;
          const observed = admissions.get(fixture.connectionIds[index] ?? '');
          return (
            observed !== undefined &&
            observed.id === current.states[index]?.requests[0] &&
            !observed.admitted
          );
        }, 'actual resource view opened or proved not admitted');
        if (state().states[index]?.viewId) break;
        assert(coordination && attempt < 9, 'bounded fresh Open after proved non-admission');
        assert(fixture.capture.contextFor(fixture.sessionId)?.available);
        assert(
          fixture.adapter.getDirectConnection(fixture.connectionIds[index] ?? '')?.isConnected,
        );
        await Bun.sleep(5);
      }
      await until(
        () => [...records.values()].every((record) => !record.slot.busy),
        'actual Open native receipts settled',
      );
    }
    assert.equal(records.size, 4);
    if (strictIngress) {
      control('hold-pongs');
      await until(() => state().sequence === sequence, 'actual resource peer holds later pongs');
    }
    if (coordination) {
      publishResourceReceipt(phase('opened'), { views: records.size });
      await waitPhase('measure-go');
    }
    const capture = (
      Reflect.get(fixture.capture, 'captures') as Map<string, { screen: BoundedScreen }>
    ).get(fixture.sessionId);
    assert(capture?.screen.available);
    for (const chunk of chunks) {
      assert(capture.screen.observe(chunk));
      await capture.screen.whenIdle();
      assert(capture.screen.available, capture.screen.reason);
    }
    type Native = { send(text: string): number; getBufferedAmount(): number };
    const targets = fixture.connectionIds.map((id) => {
      const connection = fixture.adapter.getDirectConnection(id);
      assert(connection);
      const native = Reflect.get(connection, 'ws') as Native;
      return { native, send: native.send };
    });
    let measuredNative: Native | undefined;
    let handoffBefore: ReturnType<typeof memory> | undefined;
    let handoffAfter: ReturnType<typeof memory> | undefined;
    let handoffStartPending: { bytes: number; operations: number } | undefined;
    let handoffEndPending: { bytes: number; operations: number } | undefined;
    let projectedBytes = 0;
    for (const target of targets)
      target.native.send = (text) => {
        for (const restore of targets) restore.native.send = restore.send;
        const native = target.native;
        measuredNative = native;
        assert(
          [...records.values()].some(
            (record) =>
              (Reflect.get(record.slot, 'frame') as OwnedTerminalSend | null)?.message.type ===
              (strictIngress === 'nodes'
                ? 'session_terminal_refused'
                : 'session_terminal_snapshot'),
          ),
          'actual measured service response has the registered type',
        );
        const deadline = performance.now() + 1000;
        while (native.getBufferedAmount() < 16384) {
          assert(performance.now() < deadline, 'actual bounded native pressure established');
          target.send.call(native, 'x'.repeat(1024));
        }
        assert(native.getBufferedAmount() <= 17418);
        projectedBytes = Buffer.byteLength(text);
        if (args.includes('--negative-overlap')) assert(capture.screen.observe(parserInput));
        handoffStartPending = { ...capture.screen.pending };
        handoffBefore = memory();
        const result = target.send.call(native, text);
        handoffAfter = memory();
        handoffEndPending = { ...capture.screen.pending };
        return result;
      };
    stopNextRead = true;
    control('read-all', 0, true);
    await until(
      () =>
        [...records.values()].some(
          (record) => !!Reflect.get(record.slot, 'frame') && !!record.intent,
        ),
      'actual frame and first-time intent retained',
    );
    assert(isStopped());
    const pending = [...records.values()].find((record) => Reflect.get(record.slot, 'frame'));
    assert(pending?.borrowing && pending.slot.busy);
    assert.equal((Reflect.get(pending.slot, 'receipt') as Buffer).byteLength, 16);
    await until(
      () => [...records.values()].every((record) => record.intent !== null),
      'four actual first-time intents retained',
    );
    assert.equal(records.size, 4);
    assert.deepEqual(
      handoffStartPending,
      { bytes: 0, operations: 0 },
      'synchronous service handoff starts from idle parser',
    );
    assert.deepEqual(
      handoffEndPending,
      { bytes: 0, operations: 0 },
      'synchronous service handoff ends before parser ingress',
    );
    assert(
      handoffBefore &&
        handoffAfter &&
        measuredNative &&
        projectedBytes > 0 &&
        projectedBytes <= 65536,
    );
    const settled = memory();
    for (let index = 0; index < 8; index++) assert(capture.screen.observe(parserInput));
    assert.deepEqual(capture.screen.pending, { bytes: 65536, operations: 8 });
    const queued = memory();
    await capture.screen.whenIdle();
    assert(capture.screen.available, capture.screen.reason);
    const drained = memory();
    assert(isStopped() && pending.borrowing && pending.slot.busy);
    assert([...records.values()].every((record) => record.intent !== null));
    const ingressSamples: ReturnType<typeof memory>[] = [];
    if (strictIngress) {
      // The actual frame/nonce remains owned; only the independent receiver resumes.
      resume();
      const originalParse = JSON.parse;
      let injected = false;
      JSON.parse = (
        text: string,
        reviver?: (this: unknown, key: string, value: unknown) => unknown,
      ) => {
        const value = originalParse(text, reviver);
        if (
          text.length > 64000 &&
          Buffer.byteLength(text) === 65536 &&
          value?.type === 'session_terminal_read' &&
          value?.sessionId === fixture.sessionId &&
          typeof value.padding === 'string'
        ) {
          assert(pending.borrowing && pending.slot.busy);
          assert.equal((Reflect.get(pending.slot, 'receipt') as Buffer).byteLength, 16);
          assert.equal(Reflect.get(pending.slot, 'receiptConfirmed'), false);
          assert.equal(records.size, 4);
          assert([...records.values()].every((record) => record.intent !== null));
          if (strictIngress === 'utf16') assert.equal(value.padding.codePointAt(0), 0x1d11e);
          else assert.equal(value.nodes.length, 503); // Root+eight property values+503 leaves=512.
          if (!injected) {
            for (let index = 0; index < 8; index++) assert(capture.screen.observe(parserInput));
            injected = true;
          }
          assert.deepEqual(capture.screen.pending, { bytes: 65536, operations: 8 });
          const sample = memory();
          assert.equal(Buffer.byteLength(text), 65536);
          assert(value.padding.length > 64000, 'actual parsed wide/raw backing stays live');
          ingressSamples.push(sample);
        }
        return value;
      };
      try {
        control('malformed');
        await until(() => ingressSamples.length >= 2, 'both actual strict decoder parses observed');
      } finally {
        JSON.parse = originalParse;
      }
      await capture.screen.whenIdle();
      assert(capture.screen.available && pending.borrowing && pending.slot.busy);
    }
    const evidence = {
      before,
      handoffBefore,
      handoffAfter,
      settled,
      queued,
      drained,
      conservativePeakDelta:
        Math.max(
          handoffBefore.charge,
          handoffAfter.charge,
          settled.charge,
          queued.charge,
          drained.charge,
          ...ingressSamples.map((sample) => sample.charge),
        ) - before.charge,
      ingressProfile: strictIngress,
      ingressSamples,
      budget: TERMINAL_RESERVATION_LIMITS.modelBytes,
      projectedBytes,
      actualNativeBuffered: measuredNative.getBufferedAmount(),
      actualViews: records.size,
      actualFirstTimeIntents: [...records.values()].filter((record) => record.intent !== null)
        .length,
      nativeCopyAllowanceBytes: nativeCopyAllowance.byteLength,
      fixturePressureAllowanceBytes: pressureAllowance.byteLength,
      tlsWorkingAllowanceBytes: tlsWorkingAllowance.byteLength,
      envelopeAllowanceBytes: envelopeAllowance.byteLength,
      ingressHandoffAllowanceBytes: ingressHandoffAllowance.byteLength,
      profile: args.includes('--utf16-escaped') ? 'utf16-escaped' : 'latin1',
      scope:
        'one actual signedWSS service/capture model;4views,4firsttimeintents,actual encode/native-pending and full64KiB/8parserops;preexistingnetwork/auth/registry/unstartedPTY/globalemptyservice precede fixed baseline; strict ingress samples when selected include actual raw/AST with same pending nonce and full parser queue; internal capacity is not viewport fidelity or OS ceiling; combined and heldNo remain separate',
    };
    if (measured && args.includes('--terminal-resource-evidence'))
      publishResourceReceipt(argument('--terminal-resource-evidence'), evidence);
    if (measured)
      assert(
        evidence.conservativePeakDelta <= TERMINAL_RESERVATION_LIMITS.modelBytes,
        `approved complete service state budget: ${JSON.stringify(evidence)}`,
      );
    assert(
      nativeCopyAllowance.length &&
        pressureAllowance.length &&
        tlsWorkingAllowance.length &&
        envelopeAllowance.length &&
        ingressHandoffAllowance.length,
    );

    if (coordination) {
      publishResourceReceipt(phase('measured'), evidence);
      await waitPhase('audit-go');
      assert.equal(records.size, 4, 'all four actual owner views survive combined pressure');
      assert(
        [...records.values()].every(
          (record) => record.intent !== null && Reflect.get(record, 'state') === 'open',
        ),
      );
      assert(
        isStopped() && pending.borrowing && pending.slot.busy && Reflect.get(pending.slot, 'frame'),
      );
      publishResourceReceipt(phase('held'), {
        views: records.size,
        intents: 4,
        frames: 1,
        stopped: true,
      });
      await waitPhase('finish-go');
    }
    const owned = Reflect.get(pending.slot, 'frame') as OwnedTerminalSend;
    const expectedDigest = createHash('sha256')
      .update(encodeTerminalViewFrame(owned.message))
      .digest('hex');
    assert(
      state().states.every((row) => row.drainCapacity === 0),
      'receiver windows stayed bounded throughout measurements',
    );
    control('restore-receivers');
    resume();
    await until(
      () =>
        state().sequence === sequence && state().states.every((row) => row.drainCapacity >= 65536),
      'post-measurement receiver windows restored for disposal',
    );
    if (strictIngress) control('release-pongs');
    await until(
      () =>
        state().states.some((row) => row.frames.some((frame) => frame.digest === expectedDigest)),
      'actual peer receives complete service snapshot',
    );
    await until(
      () => [...records.values()].every((record) => !record.slot.busy && record.intent === null),
      'actual pending frame and first-time intent settled',
    );
    assert.equal(records.size, 4);
    control('exit');
    await child.exited;
    assert.equal(child.exitCode, 0, await peerStderr);
    assert.equal(await peerStdout, '');
    if (args.includes('--negative-write')) {
      await fixture.pty.write('X');
      await Bun.sleep(100);
    }
    await fixture.close();
    passed = true;
    return {
      status: measured ? 'passed-one-model-resource-only' : 'passed-warmup',
      evidence,
      version: Bun.version,
      revision: Bun.revision,
      platform: process.platform,
      architecture: process.arch,
      actualPeers: 4,
      actualViews: 4,
      actualGeometry: [240, 60],
      independentStoppedReceiver: true,
      completeFrameDigest: true,
      firstTimeIntent: true,
      actualChildInputBytes: 0,
      scope:
        'one actual service model only; combined2model/heldNo/all6compiled qualification still required',
    };
  } catch (error) {
    if (evidencePath)
      publishResourceReceipt(`${evidencePath}.failure`, {
        status: 'failed-staged-service-resource',
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        peer: fs.existsSync(`${prefix}.state`) ? state() : null,
        peerError: fs.existsSync(`${prefix}.error`)
          ? fs.readFileSync(`${prefix}.error`, 'utf8')
          : null,
        records: [...records.values()].map((record) => ({
          state: Reflect.get(record, 'state'),
          reason: Reflect.get(record, 'reason'),
          busy: record.slot.busy,
          borrowing: record.borrowing,
          intent: record.intent !== null,
          viewId: Reflect.get(record, 'viewId'),
        })),
        pty: fixture.pty.sessionState,
        context: fixture.capture.contextFor(fixture.sessionId) !== null,
      });
    throw error;
  } finally {
    fixture.service.handle = originalHandle;
    resume();
    if (!passed) {
      if (peer?.exitCode === null) {
        control('exit');
        const timeout = setTimeout(() => peer?.kill('SIGTERM'), 3000);
        try {
          await peer.exited;
        } finally {
          clearTimeout(timeout);
        }
      }
      try {
        await fixture.close();
      } catch (cleanupError) {
        const diagnostic =
          cleanupError instanceof Error
            ? (cleanupError.stack ?? cleanupError.message)
            : String(cleanupError);
        if (evidencePath) publishResourceReceipt(`${evidencePath}.cleanup`, { error: diagnostic });
        console.error('Owned staged service cleanup failed', diagnostic);
      }
      console.error('Owned staged service failure root', files.directory);
    }
  }
}
const command = Bun.main.startsWith('/$bunfs/')
  ? [process.execPath]
  : [process.execPath, '--no-env-file', Bun.main];
for (let warmup = 0; warmup < 3; warmup++) await runProfile(false);
await Bun.sleep(1100);
const calibration = Bun.spawn([...command, '--external-calibration'], {
  stdin: 'ignore',
  stdout: 'pipe',
  stderr: 'pipe',
  env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', TMPDIR: tmpdir(), LANG: 'en_US.UTF-8' },
});
const calibrationOut = new Response(calibration.stdout).text();
const calibrationErr = new Response(calibration.stderr).text();
assert.equal(await calibration.exited, 0, await calibrationErr);
assert.equal(await calibrationErr, '');
const counter = JSON.parse(await calibrationOut);
assert(
  counter.status === 'passed' &&
    counter.version === Bun.version &&
    counter.revision === Bun.revision &&
    counter.bytes === 8388608,
);
assert.throws(() => process.kill(calibration.pid, 0), { code: 'ESRCH' });
for (let collect = 0; collect < 3; collect++) {
  fullGC();
  await Bun.sleep(0);
}
console.log(JSON.stringify({ ...(await runProfile(true)), calibration: counter }));
