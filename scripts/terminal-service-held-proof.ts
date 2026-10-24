/** Actual signed service load and held HTTP No, with two owners and eight real TLS views. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentity } from '@remi/shared';
import { AutoApproveGate } from '../packages/daemon/src/auto-approve/auto-approve-gate.ts';
import {
  createInputHandlers,
  gateAnswerDeps,
} from '../packages/daemon/src/cli/handlers/input-events.ts';
import { __resetLoggerForTests, configureLogger } from '../packages/daemon/src/cli/logger.ts';
import { createMessageApiForSession } from '../packages/daemon/src/cli/session-phases/message-api-setup.ts';
import { HookServer } from '../packages/daemon/src/hooks/hook-server.ts';
import type { TerminalSendSlot } from '../packages/daemon/src/terminal/send-slot.ts';
import { runOwnedTerminalOutputChild } from '../packages/daemon/tests/helpers/terminal-output-child.ts';
import {
  type TerminalServiceFixture,
  terminalServiceFixture,
  until,
} from '../packages/daemon/tests/helpers/terminal-service-fixture.ts';
import {
  type TerminalResourcePeerSpec,
  type TerminalResourcePeerTarget,
  boundResourceSocket,
  ownedTerminalResourceFiles,
  publishResourceReceipt,
  resourceSocketTuples,
  runTerminalResourcePeers,
} from '../packages/daemon/tests/helpers/terminal-service-resource-support.ts';
import { runTerminalStoreLockHolder } from '../packages/daemon/tests/helpers/terminal-store-lock-holder.ts';
import { runApprovalClientMode } from './tunnel-decoder-proof/approval-client.ts';
const args = process.argv.slice(2);
const argument = (flag: string, offset = 1) => {
  const value = args[args.indexOf(flag) + offset];
  assert(args.includes(flag) && value);
  return value;
};
const executable = () =>
  Bun.main.startsWith('/$bunfs/')
    ? [process.execPath]
    : [process.execPath, '--no-env-file', Bun.main];
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
if (args.includes('--approval-client')) {
  await runApprovalClientMode();
  process.exit(0);
}
if (args.includes('--store-holder')) {
  runTerminalStoreLockHolder([argument('--store-holder'), argument('--store-holder', 2)]);
  process.exit(0);
}
const records = (f: TerminalServiceFixture) =>
  Reflect.get(f.service, 'records') as Map<
    object,
    { slot: TerminalSendSlot; intent: unknown; borrowing: boolean; viewId: string }
  >;
const read = (path: string) => JSON.parse(fs.readFileSync(path, 'utf8'));
const env = (home: string) => ({
  HOME: home,
  REMI_HOME: home,
  TMPDIR: tmpdir(),
  PATH: process.env['PATH'] ?? '/usr/bin:/bin',
  LANG: 'en_US.UTF-8',
});
const captureState = (f: TerminalServiceFixture) =>
  (
    Reflect.get(f.capture, 'captures') as Map<
      string,
      {
        screen: { pending: { operations: number }; whenIdle(): Promise<void> };
        ingress: { used: number } | null;
      }
    >
  ).get(f.sessionId);
const untilSetup = async (check: () => boolean, label: string) => {
  const end = performance.now() + 15000;
  while (!check()) {
    assert(performance.now() < end, `owned service setup deadline: ${label}`);
    await Bun.sleep(5);
  }
};
if (args.includes('--secondary-owner')) {
  const prefix = argument('--secondary-owner');
  const files = ownedTerminalResourceFiles(
    argument('--terminal-tls-root'),
    argument('--terminal-shared-home'),
  );
  let outputBytes = 0;
  const f = await terminalServiceFixture({
    files,
    size: { cols: 240, rows: 60 },
    initialOutput: '',
    childPrefix: join(files.directory, 'output'),
    onOutput: (data) => {
      outputBytes += Buffer.byteLength(data);
    },
  });
  const admissions: { id: string; admitted: boolean; connectionId: string }[] = [];
  const actual = f.service.handle;
  f.service.handle = (id, ingress) => {
    const result = actual.call(f.service, id, ingress);
    if (ingress.kind === 'request' && ingress.request.type === 'session_terminal_open') {
      const connection = f.adapter.getDirectConnection(id);
      admissions.push({
        id: ingress.request.id,
        connectionId: id,
        admitted: !!connection && records(f).has(connection),
      });
      if (admissions.length > 16) admissions.shift();
    }
    return result;
  };
  const report = () => {
    const state = captureState(f);
    publishResourceReceipt(`${prefix}.state`, {
      pid: process.pid,
      outputBytes,
      available: !!f.capture.contextFor(f.sessionId),
      pending: state?.screen.pending.operations ?? 0,
      ingress: state?.ingress?.used ?? 0,
      admissions: admissions.map((row) => {
        const connection = f.adapter.getDirectConnection(row.connectionId);
        const record = connection && records(f).get(connection);
        return {
          ...row,
          settledWithoutView:
            !!record &&
            record.viewId === '' &&
            !record.slot.busy &&
            record.intent === null &&
            !record.borrowing,
        };
      }),
      records: [...records(f).values()].map((r) => ({
        state: Reflect.get(r, 'state'),
        busy: r.slot.busy,
        frame: !!Reflect.get(r.slot, 'frame'),
        intent: !!r.intent,
        borrowing: r.borrowing,
        lastRead: Reflect.get(r, 'lastRead'),
      })),
    });
  };
  report();
  publishResourceReceipt(`${prefix}.ready`, {
    pid: process.pid,
    port: f.server.port,
    sessionId: f.sessionId,
    binding: f.binding(),
    serverPublicKey: f.trust.load()?.publicKey,
    prefix: f.prefix,
  });
  const timer = setInterval(report, 10);
  try {
    const end = performance.now() + 60000;
    while (!fs.existsSync(`${prefix}.go`)) {
      assert(performance.now() < end, 'owned secondary lifetime');
      await Bun.sleep(5);
    }
  } finally {
    clearInterval(timer);
    f.service.handle = actual;
    await f.close();
  }
  process.exit(0);
}
const YES = { label: 'Yes', value: '1', isYes: true, isNo: false, isRecommended: true };
const NO = { label: 'No', value: '2', isYes: false, isNo: true, isRecommended: false };
const PROOF_COMMAND = 'echo REMI_TERMINAL_APPROVAL_PROOF';
const fullText = '\ue000'.repeat(3968) + 'é'.repeat(10432);
assert.equal(Buffer.byteLength(fullText), 32768);
const clear = ('\x1b[2J'.repeat(4) + '\x1b[31m'.repeat(816)).repeat(2);
type Child = {
  process: ReturnType<typeof Bun.spawn>;
  stdout: Promise<string>;
  stderr: Promise<string>;
};
const spawn = (argv: string[], home: string): Child => {
  const process = Bun.spawn(argv, {
    cwd: home,
    env: env(home),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    process,
    stdout: new Response(process.stdout).text(),
    stderr: new Response(process.stderr).text(),
  };
};
const isStopped = (child: Child) =>
  process.platform === 'linux'
    ? /^State:\s+[Tt]/m.test(fs.readFileSync(`/proc/${child.process.pid}/status`, 'utf8'))
    : Bun.spawnSync(['/bin/ps', '-p', String(child.process.pid), '-o', 'state='])
        .stdout.toString()
        .trim()
        .startsWith('T');
const results: unknown[] = [];
for (const scenario of args.includes('--scenario')
  ? [argument('--scenario')]
  : [
      'max-text-service-load',
      'clear-service-load',
      'retirement-lock-contention',
      'blocking-control',
    ]) {
  const common = ownedTerminalResourceFiles(argument('--terminal-tls-root'));
  const childPrefix = join(common.directory, 'secondary');
  const children: Child[] = [];
  let f: TerminalServiceFixture | undefined;
  let gate: AutoApproveGate | undefined;
  let hook: HookServer | undefined;
  let answer: ReturnType<typeof Bun.serve> | undefined;
  let fast: Child | undefined;
  let slow: Child | undefined;
  let approval: Child | undefined;
  let holder: Child | undefined;
  const fastPrefix = join(common.directory, 'fast');
  const slowPrefix = join(common.directory, 'slow');
  const holderPrefix = join(common.directory, 'quota-holder');
  let fastSequence = 0;
  let slowSequence = 0;
  let running = false;
  let load: Promise<void> | undefined;
  let loadFailure: unknown;
  let passed = false;
  let outputBytes = 0;
  let progress = 0;
  const fastControl = (action: string, index = 0) =>
    publishResourceReceipt(`${fastPrefix}.command`, { sequence: ++fastSequence, action, index });
  const slowControl = (action: string, twice = false) =>
    publishResourceReceipt(`${slowPrefix}.command`, {
      sequence: ++slowSequence,
      action,
      index: 0,
      twice,
    });
  configureLogger({ writeLog: () => {} });
  try {
    const ownFiles = ownedTerminalResourceFiles(argument('--terminal-tls-root'), common.home);
    f = await terminalServiceFixture({
      files: ownFiles,
      size: { cols: 240, rows: 60 },
      initialOutput: '',
      childPrefix: join(ownFiles.directory, 'output'),
      onOutput: (data) => {
        outputBytes += Buffer.byteLength(data);
      },
      messageApiFactory: (sessionRegistry, sessionId) =>
        createMessageApiForSession(
          {
            sessionRegistry,
            transcriptWatchers: new Map(),
            deviceTokens: new Map(),
            pushConfig: () => ({ signalingUrl: 'https://owned.invalid' }),
            updateRemiStatus: () => {},
            maxBulletLength: 500,
            sendMessage: () => {},
          },
          sessionId,
        ).messageApi,
    });
    const root = f;
    const secondary = spawn(
      [
        ...executable(),
        '--secondary-owner',
        childPrefix,
        '--terminal-tls-root',
        argument('--terminal-tls-root'),
        '--terminal-shared-home',
        common.home,
      ],
      common.directory,
    );
    children.push(secondary);
    await untilSetup(
      () => fs.existsSync(`${childPrefix}.ready`) || secondary.process.exitCode !== null,
      'actual secondary ready',
    );
    assert.equal(
      secondary.process.exitCode,
      null,
      secondary.process.exitCode !== null ? await secondary.stderr : '',
    );
    const info = read(`${childPrefix}.ready`);
    assert.equal(info.pid, secondary.process.pid);
    const identities = await Promise.all(Array.from({ length: 8 }, () => createIdentity()));
    for (const [index, identity] of identities.entries())
      await root.trust.addAuthorizedKey(identity.publicKey, `owned service load peer ${index}`);
    const spec = (targets: TerminalResourcePeerTarget[]): TerminalResourcePeerSpec => ({
      port: root.server.port,
      ca: common.ca,
      serverPublicKey: root.trust.load()?.publicKey ?? '',
      sessionId: root.sessionId,
      binding: root.binding(),
      identities: [],
      targets,
    });
    const slowIdentity = identities[0];
    assert(slowIdentity);
    const slowSpec = join(common.directory, 'slow-spec.json');
    fs.writeFileSync(
      slowSpec,
      JSON.stringify(
        spec([
          {
            port: root.server.port,
            sessionId: root.sessionId,
            binding: root.binding(),
            identity: slowIdentity,
          },
        ]),
      ),
      { mode: 0o600 },
    );
    slow = spawn(
      [...executable(), '--terminal-resource-peer', slowSpec, slowPrefix],
      common.directory,
    );
    children.push(slow);
    await untilSetup(
      () => fs.existsSync(`${slowPrefix}.ready`) || slow?.process.exitCode !== null,
      'actual slow signed peer',
    );
    assert.equal(slow.process.exitCode, null);
    const targets = identities.slice(1).map((identity, index) => ({
      identity,
      port: index < 3 ? root.server.port : info.port,
      sessionId: index < 3 ? root.sessionId : info.sessionId,
      binding: index < 3 ? root.binding() : info.binding,
    }));
    const fastSpec = join(common.directory, 'fast-spec.json');
    fs.writeFileSync(fastSpec, JSON.stringify(spec(targets)), { mode: 0o600 });
    fast = spawn(
      [...executable(), '--terminal-resource-peer', fastSpec, fastPrefix],
      common.directory,
    );
    children.push(fast);
    await untilSetup(
      () => fs.existsSync(`${fastPrefix}.ready`) || fast?.process.exitCode !== null,
      'seven actual mixed-session peers',
    );
    assert.equal(fast.process.exitCode, null);
    const admissions: { id: string; admitted: boolean; connectionId: string }[] = [];
    const actualHandle = root.service.handle;
    let stopRead = false;
    root.service.handle = (id, ingress) => {
      if (
        stopRead &&
        ingress.kind === 'request' &&
        ingress.request.type === 'session_terminal_read' &&
        id === root.connectionIds[0]
      ) {
        stopRead = false;
        assert(slow);
        const end = performance.now() + 1000;
        while (
          !fs.existsSync(`${slowPrefix}.sent`) ||
          read(`${slowPrefix}.sent`).sequence !== slowSequence
        ) {
          assert(performance.now() < end);
          Bun.sleepSync(1);
        }
        process.kill(slow.process.pid, 'SIGSTOP');
        while (!isStopped(slow)) {
          assert(performance.now() < end);
          Bun.sleepSync(1);
        }
      }
      const result = actualHandle.call(root.service, id, ingress);
      if (ingress.kind === 'request' && ingress.request.type === 'session_terminal_open') {
        const connection = root.adapter.getDirectConnection(id);
        admissions.push({
          id: ingress.request.id,
          connectionId: id,
          admitted: !!connection && records(root).has(connection),
        });
        if (admissions.length > 16) admissions.shift();
      }
      return result;
    };
    const open = async (slowPeer: boolean, index: number) => {
      const prefix = slowPeer ? slowPrefix : fastPrefix;
      for (let attempt = 0; ; attempt++) {
        if (slowPeer) slowControl('open');
        else fastControl('open', index);
        const sequence = slowPeer ? slowSequence : fastSequence;
        await until(() => {
          const state = read(`${prefix}.state`);
          if (state.states[index]?.viewId) return true;
          if (state.sequence !== sequence) return false;
          const observed = (
            slowPeer || index < 3 ? admissions : read(`${childPrefix}.state`).admissions
          ).find(
            (item: {
              id: string;
              admitted: boolean;
              connectionId: string;
              settledWithoutView?: boolean;
            }) => item.id === state.states[index]?.requests[0],
          );
          if (!observed) return false;
          if (!observed.admitted) return true;
          if (!slowPeer && index >= 3) return observed.settledWithoutView === true;
          const connection = root.adapter.getDirectConnection(observed.connectionId);
          const record = connection && records(root).get(connection);
          // Admission precedes a separate nonblocking grant attempt. Only a settled
          // record with no minted ID/effect permits another explicit setup Open.
          return (
            !!record &&
            record.viewId === '' &&
            !record.slot.busy &&
            record.intent === null &&
            !record.borrowing
          );
        }, 'actual service view opened or settled without a view');
        if (read(`${prefix}.state`).states[index]?.viewId) {
          const peers = read(`${fastPrefix}.state`).states as { viewId: string }[];
          const rootOwner = slowPeer || index < 3;
          const expected = rootOwner
            ? 1 + peers.slice(0, 3).filter((row) => row.viewId).length
            : peers.slice(3).filter((row) => row.viewId).length;
          await until(() => {
            if (rootOwner)
              return (
                records(root).size === expected &&
                [...records(root).values()].every(
                  (record) => !record.slot.busy && record.intent === null,
                )
              );
            const observed = read(`${childPrefix}.state`).records as {
              busy: boolean;
              intent: boolean;
            }[];
            return (
              observed.length === expected && observed.every((row) => !row.busy && !row.intent)
            );
          }, 'each setup Open native receipt settled before the next view');
          break;
        }
        assert(attempt < 9, 'bounded fresh setup Open after proved no view/effect');
        await Bun.sleep(5);
      }
    };
    await open(true, 0);
    for (let index = 0; index < 7; index++) await open(false, index);
    await until(
      () =>
        records(root).size === 4 &&
        [...records(root).values()].every((record) => !record.slot.busy),
      'root four native Open receipts settled',
    );
    const stored = () => read(join(common.home, 'terminal-view/reservations.json'));
    assert.equal(stored().records.length, 10, 'two actual models and eight views charged');
    assert(read(`${fastPrefix}.state`).states.every((row: { viewId: string }) => row.viewId));
    let sequence = 0;
    const expected = [0, 0];
    const emit = async (text: string, allowRetired = false) => {
      sequence++;
      const bytes = Buffer.byteLength(text);
      expected[0] = (expected[0] ?? 0) + bytes;
      expected[1] = (expected[1] ?? 0) + bytes;
      for (const prefix of [root.prefix, info.prefix])
        publishResourceReceipt(`${prefix}.command`, {
          sequence,
          kind: 'output',
          output: Buffer.from(text).toString('base64'),
        });
      await untilSetup(
        () =>
          [root.prefix, info.prefix].every(
            (prefix) =>
              fs.existsSync(`${prefix}.ack`) && read(`${prefix}.ack`).sequence === sequence,
          ) &&
          outputBytes >= (expected[0] ?? 0) &&
          read(`${childPrefix}.state`).outputBytes >= (expected[1] ?? 0),
        'both actual PTY outputs delivered',
      );
      if (!allowRetired) {
        const state = captureState(root);
        assert(state);
        await state.screen.whenIdle();
        await untilSetup(() => {
          const other = read(`${childPrefix}.state`);
          return (
            !!root.capture.contextFor(root.sessionId) &&
            state.screen.pending.operations === 0 &&
            !state.ingress &&
            other.available &&
            other.pending === 0 &&
            other.ingress === 0
          );
        }, 'both accepted bursts parsed');
      }
      progress += 2 * bytes;
    };
    await emit(scenario === 'clear-service-load' ? clear : `\x1b[H${fullText}`);
    const rootScreen = captureState(root);
    assert(rootScreen);
    const preview = root.capture.contextFor(root.sessionId)?.borrow();
    assert(preview);
    assert.equal(
      preview.snapshot.lines.reduce((sum, line) => sum + Buffer.byteLength(line), 0),
      scenario === 'clear-service-load' ? 0 : 32768,
    );
    preview.release();
    const connection = root.adapter.getDirectConnection(root.connectionIds[0] ?? '');
    assert(connection);
    const native = Reflect.get(connection, 'ws') as {
      send(text: string): number;
      getBufferedAmount(): number;
    };
    const peerRow = read(`${slowPrefix}.state`).states[0];
    const tuples = resourceSocketTuples(root.server.port, 'server').filter(
      (tuple) => tuple.remote === peerRow.localPort,
    );
    assert.equal(tuples.length, 1);
    const tuple = tuples[0];
    assert(tuple);
    boundResourceSocket(tuple.fd, 'send');
    const nativeSend = native.send;
    native.send = (text) => {
      native.send = nativeSend;
      const end = performance.now() + 1000;
      while (native.getBufferedAmount() < 16384) {
        assert(performance.now() < end);
        nativeSend.call(native, 'x'.repeat(1024));
      }
      assert(native.getBufferedAmount() <= 17418);
      return nativeSend.call(native, text);
    };
    stopRead = true;
    slowControl('read', true);
    await until(
      () =>
        [...records(root).values()].some(
          (record) => !!Reflect.get(record.slot, 'frame') && !!record.intent,
        ),
      'actual stopped slow service projection and intent',
    );
    const slowRecord = [...records(root).values()].find(
      (record) => !!Reflect.get(record.slot, 'frame'),
    );
    assert(slowRecord);
    const slowHeld = () =>
      !!slow &&
      isStopped(slow) &&
      slowRecord.borrowing &&
      slowRecord.slot.busy &&
      !!Reflect.get(slowRecord.slot, 'frame') &&
      (Reflect.get(slowRecord.slot, 'receipt') as Buffer | null)?.byteLength === 16 &&
      Reflect.get(slowRecord.slot, 'receiptConfirmed') === false;
    assert(slowHeld());
    const questionPath = join(common.directory, 'question');
    let questionId: string | undefined;
    const messageApi = root.registry.getSession(root.sessionId)?.messageApi;
    assert(messageApi);
    gate = new AutoApproveGate(
      {
        sessionRegistry: root.registry,
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
          fs.writeFileSync(questionPath, questionId);
          return questionId;
        },
      },
      root.sessionId,
    );
    const activeGate = gate;
    hook = new HookServer({ port: 0 });
    hook.setPermissionResolver((input, signal) => activeGate.resolvePermission(input, signal));
    hook.start();
    const handlers = createInputHandlers({
      sessionRegistry: root.registry,
      bindingStore: root.bindings,
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
          body.sessionId !== root.sessionId ||
          body.questionId !== questionId ||
          body.answer !== NO.value ||
          !questionId
        )
          return new Response(null, { status: 400 });
        return Response.json({
          outcome: await handlers.relayAnswer(root.sessionId, questionId, NO.value),
        });
      },
    });
    const readyPath = join(common.directory, 'ready');
    const triggerPath = join(common.directory, 'trigger');
    const sentPath = join(common.directory, 'sent');
    approval = spawn(
      [
        ...executable(),
        '--approval-client',
        JSON.stringify({
          hookUrl: hook.url,
          answerUrl: new URL('/answer', answer.url).toString(),
          sessionId: root.sessionId,
          questionPath,
          proofCommand: PROOF_COMMAND,
          answerNoValue: NO.value,
          cwd: root.files.work,
          readyPath,
          triggerPath,
          sentPath,
        }),
      ],
      common.directory,
    );
    children.push(approval);
    await untilSetup(
      () => fs.existsSync(readyPath) && !!questionId && activeGate.hasOpenHookPrompt(),
      'actual held hook question registered',
    );
    fastControl('start-poll');
    running = true;
    load = (async () => {
      while (running) {
        await emit(scenario === 'clear-service-load' ? clear : `\x1b[H${fullText}`);
        assert(slowHeld(), 'actual slow projection stays pending through accepted load');
      }
    })();
    void load.catch((error) => {
      loadFailure = error;
    });
    const loadStart = performance.now();
    try {
      await untilSetup(() => {
        if (loadFailure) throw loadFailure;
        const fastState = read(`${fastPrefix}.state`);
        return (
          progress >= 131072 &&
          performance.now() - loadStart >= 2000 &&
          fastState.states.every((row: { reads: number }) => row.reads >= 1) &&
          fastState.states
            .slice(3)
            .every(
              (row: { polls: number; snapshots: number }) => row.polls >= 4 && row.snapshots >= 1,
            )
        );
      }, 'actual two Hz eligible fast reads under two-model load');
    } catch (error) {
      publishResourceReceipt(join(common.directory, 'load-failure-state.json'), {
        progress,
        outputBytes,
        elapsed: performance.now() - loadStart,
        fast: read(`${fastPrefix}.state`),
        secondary: read(`${childPrefix}.state`),
      });
      throw error;
    }
    if (scenario === 'retirement-lock-contention') {
      running = false;
      await load;
      holder = spawn(
        [
          ...executable(),
          '--store-holder',
          join(common.home, 'terminal-view/reservations.json'),
          holderPrefix,
        ],
        common.directory,
      );
      children.push(holder);
      await untilSetup(() => fs.existsSync(`${holderPrefix}.ready`), 'actual quota holder ready');
      assert.equal(read(`${holderPrefix}.ready`).pid, holder.process.pid);
      publishResourceReceipt(`${root.prefix}.command`, {
        sequence: ++sequence,
        kind: 'output',
        output: Buffer.from('\x1bPqunsupported\x1b\\').toString('base64'),
      });
      await untilSetup(
        () => root.capture.contextFor(root.sessionId) === null,
        'actual optional capture retirement',
      );
      assert.equal(
        stored().records.length,
        10,
        'held cleanup cannot free physical model/view charges',
      );
    }
    const before = progress;
    const blockStarted = Date.now();
    fs.writeFileSync(triggerPath, 'No');
    if (scenario === 'blocking-control') {
      const end = performance.now() + 1250;
      while (performance.now() < end) Math.imul(17, 31);
      const sent = Number(fs.readFileSync(sentPath, 'utf8'));
      assert(sent >= blockStarted && sent <= Date.now(), 'independent actual No sent inside block');
    }
    const watch = setTimeout(() => approval?.process.kill('SIGKILL'), 15000);
    const status = await approval.process.exited;
    clearTimeout(watch);
    assert.equal(status, 0, await approval.stderr);
    const outcome = JSON.parse(await approval.stdout);
    assert.equal(await approval.stderr, '');
    assert.equal(outcome.answerOutcome, 'delivered');
    assert.equal(outcome.hookResponse.hookSpecificOutput.decision.behavior, 'deny');
    assert.equal(activeGate.hasOpenHookPrompt(), false);
    assert(
      scenario === 'blocking-control' ? outcome.latencyMs > 1000 : outcome.latencyMs < 1000,
      'actual signed-service held No latency gate',
    );
    assert(slowHeld(), 'No completes while actual slow native ownership remains pending');
    assert(
      read(`${slowPrefix}.state`).states.every(
        (row: { drainCapacity: number }) => row.drainCapacity === 0,
      ),
    );
    assert(
      read(`${fastPrefix}.state`).states.every(
        (row: { drainCapacity: number }) => row.drainCapacity === 0,
      ),
    );
    publishResourceReceipt(join(common.directory, 'no-result-before-cleanup.json'), {
      scenario,
      latencyMs: outcome.latencyMs,
      denyParsed: true,
      bytesBeforeNo: before,
      actualViews: 8,
    });
    if (holder) {
      assert.equal(holder.process.exitCode, null);
      fs.writeFileSync(`${holderPrefix}.go`, 'release');
      assert.equal(await holder.process.exited, 0, await holder.stderr);
    }
    running = false;
    if (load) await load;
    if (loadFailure) throw loadFailure;
    fastControl('stop-poll');
    await untilSetup(
      () => read(`${fastPrefix}.sent`).sequence === fastSequence,
      'actual polling stopped',
    );
    fastControl('restore-receivers');
    await untilSetup(
      () =>
        read(`${fastPrefix}.state`).sequence === fastSequence &&
        read(`${fastPrefix}.state`).states.every(
          (row: { drainCapacity: number }) => row.drainCapacity >= 65536,
        ),
      'post-No fast receiver windows restored for disposal',
    );
    await untilSetup(
      () =>
        read(`${childPrefix}.state`).records.every(
          (row: { busy: boolean; intent: boolean }) => !row.busy && !row.intent,
        ),
      'secondary native slots and intents settled before disposal',
    );
    const counts = read(`${fastPrefix}.state`).states.map(
      (row: { reads: number; polls: number; snapshots: number; refusals: number }) => ({
        reads: row.reads,
        polls: row.polls,
        snapshots: row.snapshots,
        refusals: row.refusals,
      }),
    );
    slowControl('restore-receivers');
    process.kill(slow.process.pid, 'SIGCONT');
    await untilSetup(
      () =>
        read(`${slowPrefix}.state`).sequence === slowSequence &&
        read(`${slowPrefix}.state`).states.every(
          (row: { drainCapacity: number }) => row.drainCapacity >= 65536,
        ),
      'post-No slow receiver window restored for disposal',
    );
    await untilSetup(
      () => !slowRecord.slot.busy,
      'actual stopped projection disposed by matching pong',
    );
    await untilSetup(
      () =>
        [...records(root).values()].every((record) => !record.slot.busy && record.intent === null),
      'root native slots settled',
    );
    if (args.includes('--negative-write')) {
      await root.pty.write('X');
      await Bun.sleep(100);
    }
    await root.close();
    f = undefined;
    fs.writeFileSync(`${childPrefix}.go`, 'exit');
    await untilSetup(() => secondary.process.exitCode !== null, 'secondary actor cleanup');
    assert.equal(await secondary.process.exited, 0, await secondary.stderr);
    assert.equal(await secondary.stderr, '');
    assert.equal(
      await secondary.stdout,
      `WebSocket adapter listening on port ${info.port}\nWebSocket adapter stopped\n`,
    );
    fastControl('exit');
    slowControl('exit');
    for (const peer of [fast, slow]) {
      await untilSetup(() => peer.process.exitCode !== null, 'actual client reaped');
      assert.equal(await peer.process.exited, 0, await peer.stderr);
      assert.equal(await peer.stderr, '');
      assert.equal(await peer.stdout, '');
    }
    assert.equal(stored().records.length, 0, 'all physical shared-home charges released');
    for (const child of children)
      assert.throws(() => process.kill(child.process.pid, 0), { code: 'ESRCH' });
    passed = true;
    results.push({
      scenario,
      latencyMs: outcome.latencyMs,
      actualOwners: 2,
      actualViews: 8,
      bytesBeforeNo: before,
      bytesAfterNo: progress,
      fastCounters: counts,
      slowReadRequests: 2,
      slowReceiverStoppedDuringNo: true,
      denyParsed: true,
      actualChildInputBytes: 0,
      scope:
        'actual signed-service/hook/input-handler/native load; no caller/hardware/deployed acceptance',
    });
  } finally {
    running = false;
    if (load) await load.catch(() => {});
    if (holder?.process.exitCode === null) fs.writeFileSync(`${holderPrefix}.go`, 'release');
    if (slow?.process.exitCode === null) {
      process.kill(slow.process.pid, 'SIGCONT');
      slowControl('stop-poll');
    }
    if (fast?.process.exitCode === null) fastControl('stop-poll');
    gate?.forceRelease('owned service proof cleanup');
    answer?.stop(true);
    hook?.stop();
    if (f) {
      try {
        await f.close();
      } catch (error) {
        console.error('Owned primary cleanup failure', String(error));
      }
    }
    fs.writeFileSync(`${childPrefix}.go`, 'exit');
    if (fast?.process.exitCode === null) fastControl('exit');
    if (slow?.process.exitCode === null) slowControl('exit');
    for (const child of children)
      if (child.process.exitCode === null) {
        const watch = setTimeout(() => child.process.kill('SIGTERM'), 3000);
        try {
          await child.process.exited;
        } finally {
          clearTimeout(watch);
        }
      }
    __resetLoggerForTests();
    if (passed) common.cleanup();
    else console.error('Owned signed-service held evidence retained', common.directory);
  }
}
console.log(
  JSON.stringify({
    status: 'passed-service-held-only',
    version: Bun.version,
    revision: Bun.revision,
    platform: process.platform,
    architecture: process.arch,
    results,
  }),
);
