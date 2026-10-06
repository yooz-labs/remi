/** Child ledger through real held HTTP hooks, authority files, push crypto and input handlers.
 * No apply double: the ledger receives inputHandlers.guardedAnswer itself. The
 * real PTYSession is deliberately unstarted because held answers use the hook.
 */
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  type NativeAnswerMessage,
  type Question,
  type SecurePushRegistration,
  createIdentity,
  generateId,
  relayV2,
  unlockIdentity,
} from '@remi/shared';
import { MessageAPI } from '../../src/api/message-api.ts';
import { QuestionPresenceTracker } from '../../src/api/question-presence-tracker.ts';
import { IdentityStore } from '../../src/auth/identity-store.ts';
import { AutoApproveGate } from '../../src/auto-approve/auto-approve-gate.ts';
import {
  createInputHandlers,
  gateAnswerDeps,
  trackerScreenDeps,
} from '../../src/cli/handlers/input-events.ts';
import { __resetLoggerForTests, configureLogger } from '../../src/cli/logger.ts';
import { HookEventBridge } from '../../src/hooks/hook-event-bridge.ts';
import { HookServer } from '../../src/hooks/hook-server.ts';
import { SecurePushContexts } from '../../src/notifications/secure-push-contexts.ts';
import { SecurePushStore } from '../../src/notifications/secure-push-store.ts';
import { parseQuestion } from '../../src/parser/question-parser.ts';
import { PTYSession } from '../../src/pty/pty-session.ts';
import { NativeAnswerLedger } from '../../src/remote/native-answer-ledger.ts';
import { RelayDeviceStore } from '../../src/remote/relay-device-store.ts';
import { SessionBindingStore } from '../../src/session/session-binding-store.ts';
import { SessionRegistry } from '../../src/session/session-registry.ts';
import { SessionStore } from '../../src/session/session-store.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  __resetLoggerForTests();
});

async function fixture() {
  configureLogger({ writeLog: () => {} });
  const directory = mkdtempSync('/private/tmp/remi-native-ledger-');
  chmodSync(directory, 0o700);
  const trust = new IdentityStore(directory);
  await trust.generate();
  const machineIdentity = await trust.unlock();
  const deviceIdentity = await unlockIdentity(await createIdentity());
  const publicKey = deviceIdentity.publicKeyRaw;
  await trust.addAuthorizedKey(publicKey, 'owned ledger device');
  const devices = new RelayDeviceStore(directory, trust);
  await devices.add(publicKey, 'owned ledger device');
  const store = new SecurePushStore(directory, trust);
  const recipient = await relayV2.generateEcPair();
  const registration: SecurePushRegistration = {
    token: 'ab'.repeat(32),
    environment: 'sandbox',
    pushPublicKey: relayV2.b64u(recipient.publicKey),
    keyVersion: 1,
  };
  const authority = store.captureAuthority(publicKey);
  if (!authority) throw new Error('owned enrolled authority missing');
  expect(await store.register(authority, registration)).toMatchObject({ success: true });
  const machineSigner = await relayV2.signerFromKey(
    machineIdentity.privateKey,
    new Uint8Array(Buffer.from(machineIdentity.publicKeyRaw, 'base64')),
  );
  const deviceSigner = await relayV2.signerFromKey(
    deviceIdentity.privateKey,
    new Uint8Array(Buffer.from(publicKey, 'base64')),
  );
  const machinePublicKey = relayV2.b64u(machineSigner.publicKey);
  const rid = Buffer.from(await relayV2.ridOf(machineSigner.publicKey)).toString('hex');
  const sessionId = generateId();
  const registry = new SessionRegistry({ orphanTimeoutMs: 60_000, redactQuestionLogs: true });
  let output = '';
  const pty = new PTYSession(
    { command: '/bin/cat', cwd: directory },
    {
      onData: (data) => {
        output += data;
      },
    },
  );
  const questions: Question[] = [];
  const resolved: string[] = [];
  const cleanupAuthorityReads: number[] = [];
  const api = new MessageAPI(
    { sessionId },
    {
      onQuestion: (question, options) => {
        const card = options?.held ? { ...question, held: true } : question;
        registry.addQuestion(sessionId, card, 'owned-real-hook');
        questions.push(card);
      },
      onStatusChange: (status) => registry.updateStatus(sessionId, status),
    },
  );
  registry.registerSession(sessionId, directory, pty, api);
  const tracker = new QuestionPresenceTracker((question, options) =>
    api.handleQuestion(question, options),
  );
  const bridge = new HookEventBridge(sessionId, {
    onQuestion: (question) => {
      tracker.recordPendingHook(question);
      return undefined;
    },
    onStatusChange: (status) => api.handleStatusChange(status),
  });
  const gate = new AutoApproveGate(
    {
      sessionRegistry: registry,
      isInSubagentContext: () => bridge.isInSubagentContext(),
      escalate: (input) => bridge.handlePermissionRequest(input),
      onHeldEscalate: (id) => tracker.pushHeldHook(id),
      hasLocalTerminal: true,
      holdMs: 60_000,
      hookTimeoutMs: 600_000,
    },
    sessionId,
  );
  registry.setQuestionEvictionGuard(sessionId, (id) => gate.isHeld(id));
  const hooks = new HookServer({ port: 0, hostname: '127.0.0.1' });
  hooks.setPermissionResolver((input, signal) => gate.resolvePermission(input, signal));
  hooks.start();
  const responses: Promise<Response>[] = [];
  const contexts = new SecurePushContexts({
    questionFor: (sid, qid) => registry.getQuestion(sid, qid),
    validityFor: (_sid, qid) =>
      gate.answerValidity(qid) ??
      (tracker.isPromptCurrent(qid) ? { kind: 'current-prompt' } : { kind: 'closed' }),
  });
  let runtime = contexts.begin(sessionId);
  const handlers = createInputHandlers({
    sessionRegistry: registry,
    bindingStore: new SessionBindingStore(new SessionStore(join(directory, 'sessions.json'))),
    send: () => true,
    ...gateAnswerDeps(() => gate),
    ...trackerScreenDeps(() => tracker),
    onQuestionResolved: (_sid, qid) => {
      resolved.push(qid);
      // Actual file-lock acquisition after held resolution. A lock held through
      // cleanup would make this read fail, as the production dismiss path does.
      cleanupAuthorityReads.push(store.listCurrent().length);
    },
  });
  const ledger = new NativeAnswerLedger({
    machinePublicKey,
    rid,
    store,
    contexts,
    runtimeFor: (sid) => (sid === sessionId ? runtime : undefined),
    apply: handlers.guardedAnswer,
  });
  cleanups.push(async () => {
    gate.forceRelease('owned ledger cleanup');
    await Promise.allSettled(responses);
    hooks.stop();
    tracker.clearPending();
    await pty.close(2000);
    await registry.shutdown();
    rmSync(directory, { recursive: true, force: true });
  });

  async function hold() {
    const before = questions.length;
    const response = fetch(hooks.url, {
      method: 'POST',
      keepalive: false,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: 'owned-harness-session',
        transcript_path: join(directory, 'owned.jsonl'),
        cwd: directory,
        permission_mode: 'default',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: `printf owned-ledger-${before}` },
      }),
    });
    responses.push(response);
    const deadline = Date.now() + 2000;
    while (questions.length === before && Date.now() < deadline) await Bun.sleep(2);
    const question = questions[before];
    if (!question || !gate.isHeld(question.id)) throw new Error('actual held hook setup failed');
    return { question, response };
  }
  async function publish(question: Question) {
    const snapshot = store.listCurrent()[0];
    if (!snapshot) throw new Error('owned current subscription missing');
    const context = contexts.capture(runtime, snapshot, {
      kind: 'question',
      logicalId: question.id,
      question,
    });
    if (!context || !context.payload.actionable)
      throw new Error('actual actionable context setup failed');
    const metadata = { ...context.content, machinePublicKey, rid };
    const sealed = await relayV2.sealPushContent(
      machineSigner,
      metadata,
      context.payload,
      relayV2.systemRandom,
    );
    const opened = await relayV2.openPushContent(
      recipient,
      {
        v: 2,
        rid,
        collapseId: metadata.collapseId,
        keyVersion: metadata.keyVersion,
        kind: metadata.kind,
        sealed: relayV2.b64u(sealed),
      },
      {
        machinePublicKey,
        devicePublicKey: metadata.devicePublicKey,
        pushPublicKey: metadata.pushPublicKey,
        keyVersion: metadata.keyVersion,
      },
      Math.floor(Date.now() / 1000),
    );
    expect(contexts.bindDigest(context, opened.contentDigest)).toBe(true);
    return { context, digest: opened.contentDigest };
  }
  async function sign(value: relayV2.UnsignedNativeAnswer): Promise<NativeAnswerMessage> {
    return {
      ...value,
      signature: relayV2.b64u(
        await deviceSigner.sign(await relayV2.buildNativeAnswerSigningInput(value)),
      ),
    };
  }
  async function proof(question: Question, answer = '1') {
    const { context, digest } = await publish(question);
    const now = Math.floor(Date.now() / 1000);
    return sign({
      type: 'native_answer',
      v: 2,
      id: generateId(),
      timestamp: new Date(now * 1000).toISOString(),
      rid,
      machinePublicKey,
      devicePublicKey: relayV2.b64u(deviceSigner.publicKey),
      sessionId,
      runtimeInstance: runtime.instance,
      questionId: question.id,
      collapseId: context.content.collapseId,
      revision: context.content.revision,
      contentDigest: relayV2.b64u(new Uint8Array(Buffer.from(digest, 'hex'))),
      nonce: relayV2.b64u(relayV2.systemRandom(32)),
      issuedAt: now,
      expiresAt: Math.min(now + 30, context.content.expiresAt),
      answer,
    });
  }
  return {
    ledger,
    store,
    devices,
    trust,
    publicKey,
    deviceIdentity,
    registration,
    authority,
    contexts,
    registry,
    sessionId,
    pty,
    gate,
    resolved,
    cleanupAuthorityReads,
    hold,
    proof,
    sign,
    restart: () => {
      contexts.finish(runtime);
      runtime = contexts.begin(sessionId);
    },
    currentRuntime: () => runtime,
    output: () => output,
    terminal: async () => {
      await pty.start();
      await pty.write('Continue? (y/n)\n');
      const deadline = Date.now() + 2000;
      while (!output.includes('Continue? (y/n)') && Date.now() < deadline) await Bun.sleep(2);
      const question = parseQuestion(output).question;
      if (!question) throw new Error('actual owned PTY prompt setup failed');
      tracker.onOrphanPTYPrompt(question);
      while (!registry.getQuestion(sessionId, question.id) && Date.now() < deadline)
        await Bun.sleep(2);
      if (!registry.getQuestion(sessionId, question.id))
        throw new Error('actual PTY tracker setup failed');
      return question;
    },
  };
}

test('native ledger delivers actual held HTTP decision once and retains outcome after the live prompt disappears', async () => {
  const f = await fixture();
  const held = await f.hold();
  const proof = await f.proof(held.question);
  expect(await f.ledger.answer(proof)).toBe('delivered');
  expect(await (await held.response).json()).toEqual({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
  });
  expect(f.registry.getQuestion(f.sessionId, held.question.id)).toBeNull();
  expect(f.contexts.latestAction(f.currentRuntime(), held.question.id, f.publicKey)).toBeNull();
  expect(await f.ledger.answer(proof)).toBe('delivered');
  expect(f.resolved).toEqual([held.question.id]);
  expect(f.cleanupAuthorityReads).toEqual([1]);
  expect(f.pty.sessionState).toBe('created');
});

test('native ledger keeps id and nonce conflicts distinct from legacy same-choice aliases', async () => {
  const f = await fixture();
  const held = await f.hold();
  const proof = await f.proof(held.question);
  expect(await f.ledger.answer(proof)).toBe('delivered');
  for (const change of [
    { answer: '2' },
    { nonce: relayV2.b64u(relayV2.systemRandom(32)) },
    { id: generateId() },
  ])
    expect(await f.ledger.answer(await f.sign({ ...proof, ...change }))).toBe('conflict');
  expect(
    await f.ledger.answer(
      await f.sign({ ...proof, id: generateId(), nonce: relayV2.b64u(relayV2.systemRandom(32)) }),
    ),
  ).toBe('stale');
  expect(await f.ledger.answer({ ...proof, answer: '2' })).toBe('stale');
  expect(f.resolved).toEqual([held.question.id]);
});

test('native ledger owns mutable input before crypto awaits and simultaneous exact duplicates never apply twice', async () => {
  const f = await fixture();
  const held = await f.hold();
  const proof = await f.proof(held.question);
  const mutable = { ...proof };
  const first = f.ledger.answer(mutable);
  mutable.answer = '2';
  const duplicate = f.ledger.answer(proof);
  expect(await first).toBe('delivered');
  expect(['uncertain', 'delivered']).toContain(await duplicate);
  expect(await f.ledger.answer(proof)).toBe('delivered');
  expect(f.resolved).toEqual([held.question.id]);
  expect(await (await held.response).json()).toMatchObject({
    hookSpecificOutput: { decision: { behavior: 'allow' } },
  });
});

test('native ledger refuses every present optional before the real held decision', async () => {
  const f = await fixture();
  const held = await f.hold();
  const proof = await f.proof(held.question);
  for (const change of [
    { claudeSessionId: 'owned-harness-session' },
    { message: '' },
    { cancel: false },
    { answer: '', cancel: true },
    { answer: '', selections: [{ questionIndex: 0, optionIndices: [0] }] },
  ])
    expect(await f.ledger.answer(await f.sign({ ...proof, ...change }))).toBe('stale');
  expect(f.gate.isHeld(held.question.id)).toBe(true);
  expect(f.resolved).toEqual([]);
  expect(await f.ledger.answer(proof)).toBe('delivered');
});

test('native ledger refuses signed wrong context, option value, expiry and session without consuming the real hold', async () => {
  const f = await fixture();
  const held = await f.hold();
  const proof = await f.proof(held.question);
  const now = Math.floor(Date.now() / 1000);
  for (const change of [
    { sessionId: 'another-session' },
    { questionId: generateId() },
    { runtimeInstance: relayV2.b64u(relayV2.systemRandom(32)) },
    { collapseId: relayV2.b64u(relayV2.systemRandom(16)) },
    { revision: proof.revision + 1 },
    { contentDigest: relayV2.b64u(relayV2.systemRandom(32)) },
    { answer: 'Yes' },
    { answer: '99' },
    {
      issuedAt: now - 31,
      expiresAt: now - 1,
      timestamp: new Date((now - 31) * 1000).toISOString(),
    },
    {
      issuedAt: now + 10,
      expiresAt: now + 30,
      timestamp: new Date((now + 10) * 1000).toISOString(),
    },
  ])
    expect(await f.ledger.answer(await f.sign({ ...proof, ...change }))).toBe('stale');
  expect(f.gate.isHeld(held.question.id)).toBe(true);
  expect(f.resolved).toEqual([]);
  expect(await f.ledger.answer(proof)).toBe('delivered');
});

test('native ledger rechecks actual grant removal while signature verification awaits', async () => {
  const f = await fixture();
  const held = await f.hold();
  const proof = await f.proof(held.question);
  const pending = f.ledger.answer(proof);
  f.trust.removeAuthorizedKey(f.deviceIdentity.fingerprint);
  expect(await pending).toBe('stale');
  expect(f.gate.isHeld(held.question.id)).toBe(true);
  expect(f.resolved).toEqual([]);
});

for (const mutation of ['grant', 'enrollment', 'subscription'] as const) {
  test(`native ledger retained delivery cannot adopt a fresh ${mutation} epoch`, async () => {
    const f = await fixture();
    const held = await f.hold();
    const proof = await f.proof(held.question);
    expect(await f.ledger.answer(proof)).toBe('delivered');
    if (mutation === 'grant') {
      f.trust.removeAuthorizedKey(f.deviceIdentity.fingerprint);
      await f.trust.addAuthorizedKey(f.publicKey, 'fresh owned grant');
    }
    if (mutation !== 'subscription') await f.devices.add(f.publicKey, 'fresh owned enrollment');
    const current = f.store.captureAuthority(f.publicKey);
    if (!current) throw new Error('fresh owned authority setup failed');
    expect(
      await f.store.register(current, { ...f.registration, token: 'cd'.repeat(32) }),
    ).toMatchObject({ success: true });
    expect(await f.ledger.answer(proof)).toBe('stale');
    expect(f.resolved).toEqual([held.question.id]);
  });
}

test('native ledger restart invalidates both unseen proofs and retained actual outcomes', async () => {
  const f = await fixture();
  const first = await f.hold();
  const firstProof = await f.proof(first.question);
  expect(await f.ledger.answer(firstProof)).toBe('delivered');
  const second = await f.hold();
  const secondProof = await f.proof(second.question);
  f.restart();
  expect(await f.ledger.answer(firstProof)).toBe('stale');
  expect(await f.ledger.answer(secondProof)).toBe('stale');
  expect(f.gate.isHeld(second.question.id)).toBe(true);
  expect(f.resolved).toEqual([first.question.id]);
});

test('native ledger current content revision and full-title policy constrain the actual option', async () => {
  const f = await fixture();
  const held = await f.hold();
  const old = await f.proof(held.question);
  const changed = { ...held.question, text: `${held.question.text} revised` };
  f.registry.addQuestion(f.sessionId, changed, 'owned actual question revision');
  const latest = await f.proof(changed);
  expect(latest.revision).toBeGreaterThan(old.revision);
  expect(await f.ledger.answer(old)).toBe('stale');
  const long = {
    ...changed,
    options: changed.options.map((option) => ({ ...option, description: 'x'.repeat(25) })),
  };
  f.registry.addQuestion(f.sessionId, long, 'owned complete long labels');
  expect(await f.ledger.answer(await f.proof(long))).toBe('stale');
  expect(f.gate.isHeld(held.question.id)).toBe(true);
  expect(f.resolved).toEqual([]);
  f.registry.addQuestion(f.sessionId, changed, 'owned restored complete labels');
  expect(await f.ledger.answer(await f.proof(changed))).toBe('delivered');
});

test('native ledger retains all 1024 actual outcomes across runtime replacement and refuses overflow without applying', async () => {
  const f = await fixture();
  let latest: NativeAnswerMessage | undefined;
  for (let index = 0; index < 1024; index++) {
    // Real per-runtime push slots are bounded at 32. Replacing the runtime
    // clears those slots, but must not release child-global ledger capacity.
    if (index > 0 && index % 32 === 0) f.restart();
    const held = await f.hold();
    latest = await f.proof(held.question);
    expect(await f.ledger.answer(latest)).toBe('delivered');
    expect(await (await held.response).json()).toMatchObject({
      hookSpecificOutput: { decision: { behavior: 'allow' } },
    });
  }
  if (!latest) throw new Error('missing last real delivery');
  expect(await f.ledger.answer(latest)).toBe('delivered');
  const overflow = await f.hold();
  // Start a fresh runtime so the push-context cap does not cause the refusal.
  f.restart();
  const excess = await f.proof(overflow.question);
  expect(await f.ledger.answer(excess)).toBe('busy');
  expect(f.gate.isHeld(overflow.question.id)).toBe(true);
  expect(f.resolved).toHaveLength(1024);
  expect(f.pty.sessionState).toBe('created');
}, 30000);

test('native ledger never evicts a real queued PTY answer after proof retention expires', async () => {
  const f = await fixture();
  for (let index = 0; index < 1023; index++) {
    if (index > 0 && index % 32 === 0) f.restart();
    const held = await f.hold();
    expect(await f.ledger.answer(await f.proof(held.question))).toBe('delivered');
    await held.response;
  }
  f.restart();
  const question = await f.terminal();
  const completeProof = await f.proof(question, 'y');
  const proof = await f.sign({ ...completeProof, expiresAt: completeProof.issuedAt + 2 });
  // The real FIFO's 50ms-per-input sequence keeps the accepted answer pending
  // past expiresAt+5 without substituting an apply function or a fake clock.
  const queue = Array.from({ length: 180 }, (_, index) =>
    f.pty.submitInput(`owned-ahead-${index}`),
  );
  const pending = f.ledger.answer(proof);
  cleanups.push(async () => {
    await Promise.allSettled([...queue, pending]);
  });
  expect(await f.ledger.answer(proof)).toBe('uncertain');
  expect(f.output()).not.toContain('y\r');
  const held = await f.hold();
  const excess = await f.proof(held.question);
  while (Math.floor(Date.now() / 1000) <= proof.expiresAt + 5) await Bun.sleep(20);
  expect(f.output()).not.toContain('y\r');
  expect(await f.ledger.answer(excess)).toBe('busy');
  expect(f.gate.isHeld(held.question.id)).toBe(true);
  expect(await pending).toBe('delivered');
  await Promise.all(queue);
  const outputDeadline = Date.now() + 2000;
  while (!f.output().includes('y\r') && Date.now() < outputDeadline) await Bun.sleep(2);
  expect(f.output()).toContain('y\r');
  // Only actual completion permits pruning the expired record and accepting
  // the separate live hook, never a fresh nonce for the expired answer.
  expect(await f.ledger.answer(proof)).toBe('stale');
  expect(await f.ledger.answer(excess)).toBe('delivered');
  expect(await (await held.response).json()).toMatchObject({
    hookSpecificOutput: { decision: { behavior: 'allow' } },
  });
  expect(f.resolved).toHaveLength(1025);
}, 30000);
