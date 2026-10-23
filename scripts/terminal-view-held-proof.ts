import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutoApproveGate } from '../packages/daemon/src/auto-approve/auto-approve-gate.ts';
import {
  createInputHandlers,
  gateAnswerDeps,
} from '../packages/daemon/src/cli/handlers/input-events.ts';
import { __resetLoggerForTests, configureLogger } from '../packages/daemon/src/cli/logger.ts';
import { createMessageApiForSession } from '../packages/daemon/src/cli/session-phases/message-api-setup.ts';
import { HookServer } from '../packages/daemon/src/hooks/hook-server.ts';
import { PTYSession } from '../packages/daemon/src/pty/pty-session.ts';
import { SessionBindingStore } from '../packages/daemon/src/session/session-binding-store.ts';
import { SessionRegistry } from '../packages/daemon/src/session/session-registry.ts';
import { SessionStore } from '../packages/daemon/src/session/session-store.ts';
import { withInterprocessFileLockNonblocking } from '../packages/daemon/src/storage/interprocess-file-lock.ts';
import { TerminalCaptureHost } from '../packages/daemon/src/terminal/capture-host.ts';
import { runOwnedTerminalOutputChild } from '../packages/daemon/tests/helpers/terminal-output-child.ts';
import { encodeTerminalViewFrame } from '../packages/shared/src/terminal-view.ts';

import {
  createNativeTerminalPair,
  runTerminalNetworkPeer,
} from '../packages/daemon/tests/helpers/terminal-native-pair.ts';
import { createInProcessNativeTerminalPair } from '../packages/daemon/tests/helpers/terminal-view-ownership-proof.ts';
function requiredArgument(index: number): string {
  const value = process.argv[index];
  assert(value, 'owned proof argument present');
  return value;
}
const peerMode = process.argv.indexOf('--terminal-peer');
if (peerMode !== -1) {
  await runTerminalNetworkPeer(
    requiredArgument(peerMode + 1),
    requiredArgument(peerMode + 2),
    process.argv.includes('--stable-peer'),
  );
  process.exit(0);
}
const outputChild = process.argv.indexOf('--owned-output-child');
if (outputChild !== -1) {
  await runOwnedTerminalOutputChild(
    requiredArgument(outputChild + 1),
    process.argv[outputChild + 2] ?? '',
  );
  process.exit(0);
}
const holderIndex = process.argv.indexOf('--quota-holder');
if (holderIndex !== -1) {
  const file = requiredArgument(holderIndex + 1);
  const prefix = requiredArgument(holderIndex + 2);
  withInterprocessFileLockNonblocking(file, () => {
    fs.writeFileSync(`${prefix}.ready`, String(process.pid));
    const end = performance.now() + 20000;
    while (!fs.existsSync(`${prefix}.go`)) {
      assert(performance.now() < end, 'owned quota holder release deadline');
      Bun.sleepSync(1);
    }
  });
  process.exit(0);
}
if (process.argv.includes('--approval-client')) {
  const { runApprovalClientMode } = await import('./tunnel-decoder-proof/approval-client.ts');
  await runApprovalClientMode();
  process.exit(0);
}
const YES = { label: 'Yes', value: '1', isYes: true, isNo: false, isRecommended: true };
const NO = { label: 'No', value: '2', isYes: false, isNo: true, isRecommended: false };
const PROOF_COMMAND = 'echo REMI_TERMINAL_APPROVAL_PROOF';
const environment = {
  PATH: process.env['PATH'] ?? '/usr/bin:/bin',
  LANG: 'en_US.UTF-8',
  TMPDIR: process.env['TMPDIR'] ?? '/tmp',
  REMI_HOME: process.env['REMI_HOME'] ?? join(tmpdir(), 'terminal-proof-home'),
};
const executable = (): [string, ...string[]] =>
  Bun.main.startsWith('/$bunfs/') ? [process.execPath] : [process.execPath, Bun.main];
const results = [];
for (const scenario of process.argv.includes('--scenario')
  ? [requiredArgument(process.argv.indexOf('--scenario') + 1)]
  : [
      'max-text-native-load',
      'clear-native-load',
      'retirement-lock-contention',
      'blocking-control',
    ]) {
  const dir = mkdtempSync(join(tmpdir(), 'terminal-held-'));
  const registry = new SessionRegistry({ orphanTimeoutMs: 60000 });
  let outputBytes = 0;
  const sessionId = crypto.randomUUID();
  const prefix = join(dir, 'output');
  const launch = executable();
  const secondPrefix = join(dir, 'second');
  const secondId = crypto.randomUUID();
  const secondPty = new PTYSession({
    command: launch[0],
    args: [...launch.slice(1), '--owned-output-child', secondPrefix, ''],
    cwd: dir,
    env: { HOME: dir },
    size: { cols: 240, rows: 60 },
  });
  const pty = new PTYSession(
    {
      command: launch[0],
      args: [...launch.slice(1), '--owned-output-child', prefix, ''],
      cwd: dir,
      env: { HOME: dir },
      size: { cols: 240, rows: 60 },
    },
    {
      onData(data) {
        outputBytes += Buffer.byteLength(data);
      },
    },
  );
  const capture = new TerminalCaptureHost(dir);
  let quotaHolder: Bun.Subprocess | undefined;
  let holderPrefix: string | undefined;
  let passed = false;
  const failures: unknown[] = [];
  const cleanup = async (operation: () => unknown | Promise<unknown>) => {
    try {
      await operation();
    } catch (error) {
      failures.push(error);
    }
  };
  let gate: AutoApproveGate | undefined;
  let hook: HookServer | undefined;
  let answer: ReturnType<typeof Bun.serve> | undefined;
  let client: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
  let running = true;
  let progress = 0;
  let load: Promise<void> | undefined;
  const fast: Awaited<ReturnType<typeof createInProcessNativeTerminalPair>>[] = [];
  let slow: Awaited<ReturnType<typeof createNativeTerminalPair>> | undefined;
  const handles: {
    view: NonNullable<
      ReturnType<NonNullable<ReturnType<typeof capture.contextFor>>['reserveView']>
    >;
    sessionId: string;
    pair: {
      slot: import('../packages/daemon/src/terminal/send-slot.ts').TerminalSendSlot;
      ws: Bun.ServerWebSocket<undefined>;
    };
  }[] = [];
  const counters = Array.from({ length: 8 }, () => ({ reads: 0, sent: 0, refused: 0 }));
  let slowOutcome: string | undefined;
  let slowReleased = 0;
  let slowQuarantined = 0;
  let nextRead = performance.now();
  const scheduleReads = () => {
    if (performance.now() < nextRead) return;
    nextRead = performance.now() + 500;
    for (let i = 0; i < handles.length; i++) {
      const h = handles[i];
      assert(h);
      const counts = counters[i];
      assert(counts);
      counts.reads++;
      h.pair.slot.schedule((deliver) => {
        const frame = h.view.borrow();
        if (!frame) {
          counts.refused++;
          return undefined;
        }
        const value = {
          type: 'session_terminal_snapshot' as const,
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          sessionId: h.sessionId,
          requestId: crypto.randomUUID(),
          viewId: 'AAAAAAAAAAAAAAAAAAAAAA',
          revision: frame.revision,
          ...frame.snapshot,
        };
        const result = deliver({
          message: value,
          release() {
            frame.release();
            if (i === 0) slowReleased++;
          },
          quarantine() {
            frame.quarantine();
            if (i === 0) slowQuarantined++;
          },
        });
        if (result === 'sent' || result === 'pending') counts.sent++;
        return undefined;
      });
    }
  };
  configureLogger({ writeLog: () => {} });

  try {
    assert(await capture.prepare(sessionId, pty), 'real launch capture prepared');
    assert(await capture.prepare(secondId, secondPty), 'second real capture prepared');
    await pty.start();
    await secondPty.start();
    const startupDeadline = performance.now() + 10000;
    while (!existsSync(`${prefix}.ready`) || !existsSync(`${secondPrefix}.ready`)) {
      assert(performance.now() < startupDeadline, 'actual capture child ready');
      await Bun.sleep(5);
    }
    const { messageApi } = createMessageApiForSession(
      {
        sessionRegistry: registry,
        transcriptWatchers: new Map(),
        deviceTokens: new Map(),
        pushConfig: () => ({ signalingUrl: 'https://owned.invalid' }),
        updateRemiStatus: () => {},
        maxBulletLength: 500,
        sendMessage: () => {},
      },
      sessionId,
    );
    registry.registerSession(sessionId, dir, pty, messageApi);
    const bindingStore = new SessionBindingStore(new SessionStore(join(dir, 'sessions.json')));
    let questionId: string | undefined;
    const questionPath = join(dir, 'question');
    gate = new AutoApproveGate(
      {
        sessionRegistry: registry,
        isInSubagentContext: () => false,
        holdMs: 60000,
        hasLocalTerminal: true,
        escalate: () => {
          questionId = crypto.randomUUID();
          messageApi.handleQuestion(
            {
              id: questionId,
              text: `Allow Bash: ${PROOF_COMMAND}`,
              options: [YES, NO],
              allowsFreeText: false,
              isAnswered: false,
            },
            { held: true },
          );
          writeFileSync(questionPath, questionId);
          return questionId;
        },
      },
      sessionId,
    );
    const activeGate = gate;
    hook = new HookServer({ port: 0 });
    hook.setPermissionResolver((input, signal) => activeGate.resolvePermission(input, signal));
    hook.start();
    const handlers = createInputHandlers({
      sessionRegistry: registry,
      bindingStore,
      send: () => true,
      onQuestionResolved: () => {},
      ...gateAnswerDeps(() => activeGate),
    });
    answer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const body = await request.json();
        if (
          body.sessionId !== sessionId ||
          body.questionId !== questionId ||
          body.answer !== NO.value ||
          !questionId
        )
          return new Response(null, { status: 400 });
        return Response.json({
          outcome: await handlers.relayAnswer(sessionId, questionId, NO.value),
        });
      },
    });
    const readyPath = join(dir, 'ready');
    const triggerPath = join(dir, 'trigger');
    const sentPath = join(dir, 'sent');
    client = Bun.spawn(
      [
        ...executable(),
        '--approval-client',
        JSON.stringify({
          hookUrl: hook.url,
          answerUrl: new URL('/answer', answer.url).toString(),
          sessionId,
          questionPath,
          proofCommand: PROOF_COMMAND,
          answerNoValue: NO.value,
          cwd: dir,
          readyPath,
          triggerPath,
          sentPath,
        }),
      ],
      { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: environment },
    );
    const stdout = new Response(client.stdout).text();
    const stderr = new Response(client.stderr).text();
    const deadline = performance.now() + 15000;
    while (
      (!existsSync(readyPath) || !questionId || !activeGate.hasOpenHookPrompt()) &&
      performance.now() < deadline
    ) {
      if (client.exitCode !== null)
        throw new Error(`independent answer client exit ${client.exitCode}: ${await stderr}`);
      await Bun.sleep(5);
    }
    assert(questionId && activeGate.hasOpenHookPrompt(), 'real held PermissionRequest registered');
    const fullText = '\ue000'.repeat(3968) + 'é'.repeat(10432);
    assert.equal(Buffer.byteLength(fullText), 32768, 'maximum visible UTF-8 text fixture');
    const slice = '\x1b[2J'.repeat(4) + '\x1b[31m'.repeat(816);
    assert.equal(Buffer.byteLength(slice), 4096);
    let sequence = 0;
    let expectedOutput = 0;
    const emit = async (output: string, frame = true) => {
      sequence++;
      expectedOutput += Buffer.byteLength(output);
      fs.writeFileSync(
        `${prefix}.next`,
        JSON.stringify({
          sequence,
          kind: 'output',
          output: Buffer.from(output).toString('base64'),
        }),
      );
      fs.renameSync(`${prefix}.next`, `${prefix}.command`);
      while (
        !existsSync(`${prefix}.ack`) ||
        JSON.parse(readFileSync(`${prefix}.ack`, 'utf8')).sequence !== sequence ||
        outputBytes < expectedOutput
      ) {
        assert(performance.now() < deadline, 'actual output delivery progressed');
        await Bun.sleep(1);
      }
      if (!frame) return;
      for (;;) {
        const context = capture.contextFor(sessionId);
        assert(context, 'accepted native output retains capture');
        const borrowed = context.borrow();
        if (borrowed) {
          try {
            const wire = encodeTerminalViewFrame({
              type: 'session_terminal_snapshot',
              id: crypto.randomUUID(),
              timestamp: new Date().toISOString(),
              sessionId,
              requestId: crypto.randomUUID(),
              viewId: 'AAAAAAAAAAAAAAAAAAAAAA',
              revision: borrowed.revision,
              ...borrowed.snapshot,
            });
            assert(Buffer.byteLength(wire) <= 65536, 'actual projected frame bound');
            if (scenario !== 'clear-native-load')
              assert.equal(
                borrowed.snapshot.lines.reduce((sum, line) => sum + Buffer.byteLength(line), 0),
                32768,
                'maximum visible snapshot text is exercised',
              );
          } finally {
            borrowed.release();
          }
          break;
        }
        assert(performance.now() < deadline, 'actual parse/snapshot deadline');
        await Bun.sleep(1);
      }
    };
    // Preload both actual PTYs before retaining one real native projection.
    await emit(scenario === 'clear-native-load' ? slice.repeat(2) : `\x1b[H${fullText}`);
    fs.writeFileSync(
      `${secondPrefix}.next`,
      JSON.stringify({
        sequence: 1,
        kind: 'output',
        output: Buffer.from(`\x1b[H${fullText}`).toString('base64'),
      }),
    );
    fs.renameSync(`${secondPrefix}.next`, `${secondPrefix}.command`);
    while (!existsSync(`${secondPrefix}.ack`)) {
      assert(performance.now() < deadline, 'second actual PTY delivered');
      await Bun.sleep(1);
    }
    const boundedSocketPeer = process.platform === 'linux';
    slow = await createNativeTerminalPair(boundedSocketPeer);
    assert(
      !boundedSocketPeer || (slow.senderCapacity !== undefined && slow.senderCapacity <= 8192),
      'Linux held fixture bounds its exact native sender',
    );
    for (let i = 0; i < 7; i++) {
      const pair = await createInProcessNativeTerminalPair();
      pair.peer.resume();
      fast.push(pair);
    }
    const pairs = [slow, ...fast];
    const diagnosticScreen = (
      Reflect.get(capture, 'captures') as Map<
        string,
        { screen: import('../packages/daemon/src/terminal/screen.ts').BoundedScreen }
      >
    ).get(sessionId)?.screen;
    assert(diagnosticScreen, 'actual captured screen exists');
    for (let i = 0; i < 8; i++) {
      const target = i < 4 ? sessionId : secondId;
      const context = capture.contextFor(target);
      assert(context);
      const view = context.reserveView(
        crypto.randomUUID().replaceAll('-', '').repeat(2),
        crypto.randomUUID(),
      );
      assert(view, 'eight real home view handles');
      const pair = pairs[i];
      assert(pair);
      handles.push({ view, sessionId: target, pair });
    }
    assert.equal(
      JSON.parse(readFileSync(join(dir, 'terminal-view', 'reservations.json'), 'utf8')).records
        .length,
      10,
      'two models plus eight views charged',
    );
    slow.pressureAtSend();
    assert(
      slow.slot.schedule((deliver) => {
        const frame = handles[0]?.view.borrow();
        assert(frame, 'initial slow model projection available');
        assert.equal(
          frame.snapshot.lines.reduce((sum, line) => sum + Buffer.byteLength(line), 0),
          scenario === 'clear-native-load' ? 0 : 32768,
          'maximum native text is actually projected',
        );
        slowOutcome = deliver({
          message: {
            type: 'session_terminal_snapshot',
            id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            sessionId,
            requestId: crypto.randomUUID(),
            viewId: 'AAAAAAAAAAAAAAAAAAAAAA',
            revision: frame.revision,
            ...frame.snapshot,
          },
          release() {
            frame.release();
            slowReleased++;
          },
          quarantine() {
            frame.quarantine();
            slowQuarantined++;
          },
        });
        return undefined;
      }),
    );
    while (slowOutcome === undefined) {
      assert(performance.now() < deadline, 'actual slow send');
      await Bun.sleep(1);
    }
    assert.equal(slowOutcome, 'pending');
    load = (async () => {
      while (running) {
        const text = scenario === 'clear-native-load' ? slice.repeat(2) : `\x1b[H${fullText}`;
        await emit(text, false);
        // Each maximum-sized burst is accepted before the next one; an unpaced producer exceeded the registered 64KiB parser ingress bound (trace preserved).
        await diagnosticScreen.whenIdle();
        while (
          diagnosticScreen.pending.operations ||
          (Reflect.get(capture, 'captures') as Map<string, { ingress: unknown }>).get(sessionId)
            ?.ingress
        ) {
          assert(performance.now() < deadline, 'accepted burst parse completes');
          await diagnosticScreen.whenIdle();
          await Bun.sleep(0);
        }
        scheduleReads();
        assert(
          slow?.slot.busy &&
            slow?.ws.getBufferedAmount() > 0 &&
            slowReleased === 0 &&
            slowQuarantined === 0,
          'real slow native projection remains held',
        );
        assert(
          capture.contextFor(sessionId),
          `accepted output keeps capture available: ${JSON.stringify({
            reason: diagnosticScreen.reason,
            pending: diagnosticScreen.pending,
            outputBytes,
            progress,
          })}`,
        );
        progress += Buffer.byteLength(text);
      }
    })();
    void load.catch(() => {});
    const loadStart = performance.now();
    while (
      (progress < 131072 || performance.now() - loadStart < 2000) &&
      performance.now() < deadline
    )
      await Bun.sleep(1);
    assert(
      counters.every((c) => c.reads >= 4),
      'all eight views attempted repeated bounded reads',
    );
    assert(progress >= 131072, 'actual native screen load progressed before No');
    if (scenario === 'retirement-lock-contention') {
      running = false;
      await load;
      holderPrefix = join(dir, 'quota-holder');
      quotaHolder = Bun.spawn(
        [
          ...executable(),
          '--quota-holder',
          join(dir, 'terminal-view', 'reservations.json'),
          holderPrefix,
        ],
        { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe', env: environment },
      );
      while (!existsSync(`${holderPrefix}.ready`)) {
        assert(performance.now() < deadline, 'owned quota holder acquired');
        await Bun.sleep(1);
      }
      assert.equal(Number(readFileSync(`${holderPrefix}.ready`, 'utf8')), quotaHolder.pid);
      await emit('\x1bPqunsupported\x1b\\', false);
      while (capture.contextFor(sessionId) !== null) {
        assert(performance.now() < deadline, 'actual capture retired');
        await Bun.sleep(1);
      }
      await Bun.sleep(20);
      assert.equal(
        JSON.parse(readFileSync(join(dir, 'terminal-view', 'reservations.json'), 'utf8')).records
          .length,
        10,
        'blocked cleanup retains model/view charge',
      );
    }
    const before = progress;
    const blockStart = Date.now();
    writeFileSync(triggerPath, 'No');
    if (scenario === 'blocking-control') {
      const until = performance.now() + 1250;
      while (performance.now() < until) {
        Math.imul(17, 31);
      }
      const sent = Number(readFileSync(sentPath, 'utf8'));
      assert(
        sent >= blockStart && sent <= Date.now(),
        'independent No was sent inside the CPU block',
      );
    }
    const watchdog = setTimeout(() => client?.kill('SIGKILL'), 15000);
    const exit = await client.exited;
    clearTimeout(watchdog);
    const out = await stdout;
    const error = await stderr;
    assert.equal(exit, 0, error);
    assert(out.length < 4096 && error.length < 4096, 'bounded independent result');
    const result = JSON.parse(out);
    assert.equal(result.answerOutcome, 'delivered');
    assert.equal(result.hookResponse.hookSpecificOutput.decision.behavior, 'deny');
    assert.equal(activeGate.hasOpenHookPrompt(), false);
    assert(
      scenario === 'blocking-control' ? result.latencyMs > 1000 : result.latencyMs < 1000,
      'independent actual held No latency gate',
    );
    await Bun.sleep(75);
    if (quotaHolder) {
      const quotaPid = quotaHolder.pid;
      assert.equal(quotaHolder.exitCode, null, 'No completed while cleanup lock remains held');
      assert(holderPrefix);
      writeFileSync(`${holderPrefix}.go`, 'release');
      assert.equal(await quotaHolder.exited, 0);
      assert.throws(
        () => process.kill(quotaPid, 0),
        (e) => (e as NodeJS.ErrnoException).code === 'ESRCH',
        'quota holder reaped',
      );
    }
    running = false;
    if (load) await load;
    assert(
      slow.slot.busy &&
        slow.ws.getBufferedAmount() > 0 &&
        slowReleased === 0 &&
        slowQuarantined === 0,
      'No completed while one actual native projection is pending',
    );
    slow.resumePeer();
    const drainDeadline = performance.now() + 10000;
    const releasedSlowFrame = (): number => slowReleased;
    while (releasedSlowFrame() !== 1) {
      assert(performance.now() < drainDeadline, 'actual pending send drained');
      await Bun.sleep(1);
    }
    for (const h of handles) {
      h.pair.slot.retire();
      h.view.retire();
    }
    if (process.argv.includes('--negative-write')) {
      await pty.write('X');
      await Bun.sleep(100);
    }
    await pty.close(1000);
    await secondPty.close(1000);
    assert(await capture.closeAll());
    const secondInput = JSON.parse(readFileSync(`${secondPrefix}.input`, 'utf8'));
    assert.equal(secondInput.inputBytes, 0, 'second held fixture wrote zero child input');
    assert.throws(
      () => process.kill(secondInput.pid, 0),
      (e) => (e as NodeJS.ErrnoException).code === 'ESRCH',
      'second actual capture child reaped',
    );
    const input = JSON.parse(readFileSync(`${prefix}.input`, 'utf8'));
    assert.equal(input.inputBytes, 0, 'actual held No wrote zero child input bytes');
    assert.throws(
      () => process.kill(input.pid, 0),
      (e) => (e as NodeJS.ErrnoException).code === 'ESRCH',
      'actual capture child reaped',
    );
    assert(progress >= before, 'screen progress is monotonic through No');
    passed = true;
    results.push({
      scenario,
      latencyMs: result.latencyMs,
      bytesBeforeNo: before,
      bytesAfterNo: progress,
      actualChildInputBytes: input.inputBytes,
      actualOutputBytes: outputBytes,
      denyParsed: true,
      clientPid: client.pid,
      views: handles.length,
      slowPeerMode: boundedSocketPeer ? 'bounded pre-connect raw TCP' : 'native paused Node TCP',
      readAttempts: counters.map((c) => c.reads),
      sent: counters.map((c) => c.sent),
      refused: counters.map((c) => c.refused),
      slowReleased,
      slowQuarantined,
    });
  } catch (error) {
    failures.push(error);
  } finally {
    running = false;
    const loadResult = load ? await Promise.allSettled([load]) : [];
    if (loadResult[0]?.status === 'rejected') failures.push(loadResult[0].reason);
    await cleanup(async () => {
      if (quotaHolder?.exitCode === null && holderPrefix)
        writeFileSync(`${holderPrefix}.go`, 'release');
      if (quotaHolder) await quotaHolder.exited;
    });
    for (const h of handles) {
      h.pair.slot.retire();
      h.view.retire();
    }
    await cleanup(() => slow?.close());
    for (const pair of fast) await cleanup(() => pair.close());
    await cleanup(() => capture.closeAll());
    await cleanup(async () => {
      if (client?.exitCode === null) client.kill('SIGKILL');
      if (client) await client.exited;
    });
    await cleanup(() => gate?.forceRelease('owned proof cleanup'));
    await cleanup(() => answer?.stop(true));
    await cleanup(() => hook?.stop());
    await cleanup(() => pty.close(2000));
    await cleanup(() => secondPty.close(2000));
    await cleanup(() => capture.closeAll());
    await cleanup(() => registry.shutdown());
    __resetLoggerForTests();
    if (passed && !failures.length) rmSync(dir, { recursive: true, force: true });
    else console.error('Owned held-capture evidence retained', dir);
  }
  const uniqueFailures = [...new Set(failures)];
  if (uniqueFailures.length === 1) throw uniqueFailures[0];
  if (uniqueFailures.length)
    throw new AggregateError(uniqueFailures, 'Owned held proof or cleanup failed');
}
console.log(
  JSON.stringify(
    {
      status: 'passed',
      version: Bun.version,
      revision: Bun.revision,
      runtime: Bun.version,
      platform: process.platform,
      architecture: process.arch,
      results,
      scope:
        'actual native PTY capture, maximum-text projection and real held HookServer/gate/answer handler with eight real views, two captured PTYs, one actually pending native projection, max2Hz/view and blocked cleanup; not signed terminal transport/provider acceptance',
    },
    null,
    2,
  ),
);
