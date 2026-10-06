/** Exact answer commits against durable authority, real HTTP/unix sockets and a real PTY.
 * The owned app-server replays captured Codex frames; no decision/crypto/PTY sink is replaced.
 */
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Question,
  type QuestionOption,
  type UUID,
  createIdentity,
  generateId,
  relayV2,
} from '@remi/shared';
import { QuestionPresenceTracker } from '../../src/api/question-presence-tracker.ts';
import { IdentityStore } from '../../src/auth/identity-store.ts';
import { AutoApproveGate } from '../../src/auto-approve/auto-approve-gate.ts';
import {
  createInputHandlers,
  gateAnswerDeps,
  trackerScreenDeps,
} from '../../src/cli/handlers/input-events.ts';
import { __resetLoggerForTests, configureLogger } from '../../src/cli/logger.ts';
import { createMessageApiForSession } from '../../src/cli/session-phases/message-api-setup.ts';
import { AppServerClient } from '../../src/harness/codex/app-server-client.ts';
import { CodexDecisions } from '../../src/harness/codex/codex-decisions.ts';
import { ThreadTracker } from '../../src/harness/codex/thread-tracker.ts';
import type { AnswerCommit } from '../../src/harness/decision.ts';
import { HookServer } from '../../src/hooks/hook-server.ts';
import { SecurePushStore } from '../../src/notifications/secure-push-store.ts';
import { parseQuestion } from '../../src/parser/question-parser.ts';
import { PTYSession } from '../../src/pty/pty-session.ts';
import { RelayDeviceStore } from '../../src/remote/relay-device-store.ts';
import { SessionBindingStore } from '../../src/session/session-binding-store.ts';
import { SessionRegistry } from '../../src/session/session-registry.ts';
import { SessionStore } from '../../src/session/session-store.ts';
import { commandApprovalRequest } from '../helpers/codex-threads.ts';
import { FakeAppServer } from '../helpers/fake-app-server.ts';
import { WRAPPED_DIRECTORY_DIALOG } from '../parser/fixtures/claude-dialogs.ts';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  __resetLoggerForTests();
});
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
  if (!predicate()) throw new Error('owned component did not reach its boundary');
}
async function fixture() {
  configureLogger({ writeLog: () => {} });
  const dir = mkdtempSync(join(tmpdir(), 'remi-answer-authority-'));
  chmodSync(dir, 0o700);
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const trust = new IdentityStore(dir);
  const devices = new RelayDeviceStore(dir, trust);
  const store = new SecurePushStore(dir, trust);
  const identity = await createIdentity();
  await trust.addAuthorizedKey(identity.publicKey, 'owned answer recipient');
  await devices.add(identity.publicKey, 'owned answer recipient');
  const authority = store.captureAuthority(identity.publicKey);
  if (!authority) throw new Error('no captured authority');
  const pair = await relayV2.generateEcPair();
  expect(
    await store.register(authority, {
      token: 'ab'.repeat(32),
      environment: 'sandbox',
      keyVersion: 1,
      pushPublicKey: relayV2.b64u(pair.publicKey),
    }),
  ).toEqual({ success: true, keyVersion: 1 });
  const snapshot = store.listCurrent()[0];
  if (!snapshot) throw new Error('no subscription');
  let invocations = 0;
  const commit: AnswerCommit = <T>(effect: () => T) =>
    store.withCurrentSubscription(snapshot, () => {
      invocations++;
      return { kind: 'committed' as const, value: effect() };
    }) ?? { kind: 'refused' as const };
  const revoke = () =>
    expect(new IdentityStore(dir).removeAuthorizedKey(identity.fingerprint)).toBe(true);
  const registry = new SessionRegistry({ orphanTimeoutMs: 60000 });
  cleanups.push(() => registry.shutdown());
  const sid = generateId() as UUID;
  let output = '';
  const pty = new PTYSession(
    { command: '/bin/cat', args: [] },
    {
      onData: (data) => {
        output += data;
      },
    },
  );
  // Register cleanup before spawning so failures cannot strand the owned /bin/cat.
  cleanups.push(() => pty.close(2000));
  await pty.start();
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
    sid,
  );
  registry.registerSession(sid, dir, pty, messageApi);
  const bindingStore = new SessionBindingStore(new SessionStore(join(dir, 'sessions.json')));
  return {
    dir,
    store,
    registry,
    sid,
    pty,
    messageApi,
    bindingStore,
    commit,
    revoke,
    invocations: () => invocations,
    output: () => output,
  };
}
const YES: QuestionOption = {
  label: 'Yes',
  value: '1',
  isYes: true,
  isNo: false,
  isRecommended: true,
};
const NO: QuestionOption = {
  label: 'No',
  value: '2',
  isYes: false,
  isNo: true,
  isRecommended: false,
};
async function claude(f: Awaited<ReturnType<typeof fixture>>) {
  let qid: UUID | undefined;
  const gate = new AutoApproveGate(
    {
      sessionRegistry: f.registry,
      isInSubagentContext: () => false,
      holdMs: 60000,
      hasLocalTerminal: true,
      escalate: () => {
        qid = generateId() as UUID;
        f.messageApi.handleQuestion(
          {
            id: qid,
            text: 'Allow Bash: touch x',
            options: [YES, NO],
            allowsFreeText: false,
            isAnswered: false,
          },
          { held: true },
        );
        return qid;
      },
    },
    f.sid,
  );
  cleanups.push(() => {
    gate.forceRelease('owned test cleanup');
  });
  const server = new HookServer({ port: 0 });
  server.setPermissionResolver((input, signal) => gate.resolvePermission(input, signal));
  server.start();
  cleanups.push(() => server.stop());
  const response = fetch(server.url, {
    method: 'POST',
    body: JSON.stringify({
      session_id: 'claude-owned',
      transcript_path: join(f.dir, 'transcript.jsonl'),
      cwd: f.dir,
      permission_mode: 'default',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'touch x' },
    }),
  });
  await until(() => qid !== undefined);
  if (!qid) throw new Error('missing actual held card');
  let dismissed = 0;
  const handlers = createInputHandlers({
    sessionRegistry: f.registry,
    bindingStore: f.bindingStore,
    send: () => true,
    ...gateAnswerDeps(() => gate),
    onQuestionResolved: () => {
      // A real auth-lock read in the downstream dismissal callback must occur after unlock.
      f.store.listCurrent();
      dismissed++;
    },
  });
  return { gate, qid, response, handlers, dismissed: () => dismissed };
}
test('guarded Claude: completed durable revoke refuses and preserves actual HTTP hold/card', async () => {
  const f = await fixture();
  const c = await claude(f);
  f.revoke();
  expect(await c.handlers.guardedAnswer(f.sid, c.qid, NO.value, f.commit)).toBe('stale');
  expect(f.invocations()).toBe(0);
  expect(c.gate.hasOpenHookPrompt()).toBe(true);
  expect(f.registry.getQuestion(f.sid, c.qid)).not.toBeNull();
  expect(c.dismissed()).toBe(0);
  // Ordinary local human answer remains possible: refusal did not resolve/retire the hold.
  expect(c.gate.answerHeld(c.qid, { kind: 'option', option: NO })).toBe('resolved');
  expect(await (await c.response).json()).toMatchObject({
    hookSpecificOutput: { decision: { behavior: 'deny' } },
  });
  expect(f.output()).toBe('');
});
test('guarded Claude: accepted resolve may finish HTTP after revoke; dismissal reenters unlocked store', async () => {
  const f = await fixture();
  const c = await claude(f);
  const outcome = c.handlers.guardedAnswer(f.sid, c.qid, NO.value, f.commit);
  expect(f.invocations()).toBe(1);
  f.revoke();
  expect(await outcome).toBe('delivered');
  expect(await (await c.response).json()).toMatchObject({
    hookSpecificOutput: { decision: { behavior: 'deny' } },
  });
  expect(c.dismissed()).toBe(1);
  expect(f.registry.getQuestion(f.sid, c.qid)).toBeNull();
  expect(await c.handlers.guardedAnswer(f.sid, c.qid, NO.value, f.commit)).toBe('stale');
  expect(f.invocations()).toBe(1);
  expect(f.output()).toBe('');
});
async function codex(f: Awaited<ReturnType<typeof fixture>>) {
  const server = FakeAppServer.start();
  cleanups.push(() => server.stop());
  const thread = '00000000-0000-7000-8000-0000000000c1';
  server.createRollout(thread);
  let ready = false;
  let attached = false;
  let q: Question | undefined;
  let cleanupReads = 0;
  let noticeReads = 0;
  const client = new AppServerClient(
    {
      socketPath: () => readlinkSync(server.linkPath),
      clientInfo: { name: 'remi', title: null, version: 'test' },
      backoff: { initialMs: 5, maxMs: 20 },
    },
    (event) => {
      if (event.type === 'ready') {
        ready = true;
        tracker.handleReady();
      }
      if (event.type === 'notification') tracker.handleNotification(event.method, event.params);
      if (event.type === 'serverRequest') decisions.handleServerRequest(event);
    },
  );
  cleanups.push(() => client.stop());
  const tracker = new ThreadTracker({
    client,
    sessionCwd: f.dir,
    spawnedAtMs: Date.now(),
    expectedThreadId: thread,
    claimedByOthers: () => new Set(),
    onIdentity: () => {},
    onStatus: () => {},
    onAttached: () => {
      attached = true;
    },
    log: () => {},
    retryMs: 20,
  });
  cleanups.push(() => tracker.dispose());
  const decisions = new CodexDecisions({
    sessionId: f.sid,
    sessionDirectory: f.dir,
    client,
    sessionRegistry: f.registry,
    threadRole: (tid) => tracker.role(tid),
    present: (question) => {
      q = question;
      f.messageApi.handleQuestion(question, { held: true });
    },
    onQuestionResolved: () => {
      f.store.listCurrent();
      cleanupReads++;
    },
    notice: () => {
      f.store.listCurrent();
      noticeReads++;
    },
    log: () => {},
  });
  cleanups.push(() => decisions.dispose());
  const handlers = createInputHandlers({
    sessionRegistry: f.registry,
    bindingStore: f.bindingStore,
    send: () => true,
    ...gateAnswerDeps(() => decisions),
    onQuestionResolved: () => {
      f.store.listCurrent();
      cleanupReads++;
    },
  });
  client.start();
  await until(() => ready && attached);
  const requestId = server.request(commandApprovalRequest(thread, 'printf owned'), thread);
  await until(() => q !== undefined);
  if (!q) throw new Error('missing actual Codex card');
  const card = q;
  const option = card.options.find((o) => o.isYes);
  if (!option) throw new Error('missing captured approval meaning');
  return {
    server,
    client,
    decisions,
    handlers,
    card,
    option,
    requestId,
    responses: () =>
      server.received.filter((r) => r.frame['id'] === requestId && 'result' in r.frame),
    cleanupReads: () => cleanupReads,
    noticeReads: () => noticeReads,
  };
}
test('guarded Codex: revoked authority keeps real pending card and emits no unix socket result', async () => {
  const f = await fixture();
  const c = await codex(f);
  f.revoke();
  expect(c.decisions.answerHeld(c.card.id, { kind: 'option', option: c.option }, f.commit)).toBe(
    'authority-refused',
  );
  expect(c.decisions.isHeld(c.card.id)).toBe(true);
  expect(f.registry.getQuestion(f.sid, c.card.id)).not.toBeNull();
  expect(c.responses()).toHaveLength(0);
  expect(f.invocations()).toBe(0);
  expect(c.noticeReads()).toBe(0);
  expect(c.cleanupReads()).toBe(0);
  expect(c.decisions.answerHeld(c.card.id, { kind: 'option', option: c.option })).toBe('resolved');
  await until(() => c.responses().length === 1);
  expect(c.responses()[0]?.frame['result']).toEqual({ decision: 'accept' });
  expect(f.output()).toBe('');
});
test('guarded Codex: socket accepts before revoke; unavailable-link notice and cleanup reenter after unlock', async () => {
  const f = await fixture();
  const c = await codex(f);
  expect(c.decisions.answerHeld(c.card.id, { kind: 'option', option: c.option }, f.commit)).toBe(
    'resolved',
  );
  expect(c.responses()).toHaveLength(0);
  f.revoke();
  await until(() => c.responses().length === 1);
  expect(c.responses()[0]?.frame['result']).toEqual({ decision: 'accept' });
  expect(f.invocations()).toBe(1);
  // Separate actual pending request/current authority for the real unavailable socket case.
  const g = await fixture();
  const d = await codex(g);
  d.client.stop();
  expect(await d.handlers.guardedAnswer(g.sid, d.card.id, d.option.value, g.commit)).toBe('stale');
  expect(g.invocations()).toBe(1);
  expect(d.noticeReads()).toBe(1);
  expect(d.cleanupReads()).toBe(1);
  expect(g.registry.getQuestion(g.sid, d.card.id)).toBeNull();
  expect(d.responses()).toHaveLength(0);
});
async function terminal(f: Awaited<ReturnType<typeof fixture>>) {
  const parsed = parseQuestion(WRAPPED_DIRECTORY_DIALOG).question;
  if (!parsed) throw new Error('captured terminal menu failed to parse');
  const tracker = new QuestionPresenceTracker((q) => f.messageApi.handleQuestion(q), {
    orphanDebounceMs: 10,
  });
  cleanups.push(() => tracker.clearPending());
  tracker.onOrphanPTYPrompt(parsed);
  await until(() => f.registry.getQuestion(f.sid, parsed.id) !== null);
  let resolved = 0;
  const handlers = createInputHandlers({
    sessionRegistry: f.registry,
    bindingStore: f.bindingStore,
    send: () => true,
    ...trackerScreenDeps(() => tracker),
    onQuestionResolved: () => {
      f.store.listCurrent();
      resolved++;
    },
  });
  return { handlers, qid: parsed.id, resolved: () => resolved };
}
test('guarded PTY: completed revoke refuses before enqueue and retains actual parsed menu', async () => {
  const f = await fixture();
  const t = await terminal(f);
  f.revoke();
  expect(await t.handlers.guardedAnswer(f.sid, t.qid, '3', f.commit)).toBe('stale');
  expect(f.invocations()).toBe(0);
  expect(t.resolved()).toBe(0);
  expect(f.registry.getQuestion(f.sid, t.qid)).not.toBeNull();
  await f.pty.submitInput('owned-positive-pty');
  await until(() => f.output().includes('owned-positive-pty\r'));
  expect(f.output()).not.toContain('3\r');
});
test('guarded PTY: accepted queued enqueue finishes after revoke; no strict in-flight or resolved alias success', async () => {
  const f = await fixture();
  const t = await terminal(f);
  const first = f.pty.submitInput('owned-ahead');
  const outcome = t.handlers.guardedAnswer(f.sid, t.qid, '3', f.commit);
  expect(f.invocations()).toBe(1);
  expect(await t.handlers.guardedAnswer(f.sid, t.qid, 'No', f.commit)).toBe('stale');
  expect(f.output()).not.toContain('3\r');
  f.revoke();
  expect(await outcome).toBe('delivered');
  await first;
  await until(() => f.output().includes('3\r'));
  expect(f.output()).toContain('owned-ahead\r');
  expect(t.resolved()).toBe(1);
  expect(f.registry.getQuestion(f.sid, t.qid)).toBeNull();
  expect(await t.handlers.guardedAnswer(f.sid, t.qid, '3', f.commit)).toBe('stale');
  expect(f.invocations()).toBe(1);
});

test('guarded strict lookup never uses connection aliases or another active question', async () => {
  const f = await fixture();
  const t = await terminal(f);
  const alias = generateId() as UUID;
  f.registry.attachConnection(f.sid, alias);
  expect(await t.handlers.guardedAnswer(alias, t.qid, '3', f.commit)).toBe('session-not-found');
  expect(await t.handlers.guardedAnswer(f.sid, generateId() as UUID, '3', f.commit)).toBe('stale');
  expect(f.invocations()).toBe(0);
  expect(f.registry.getQuestion(f.sid, t.qid)).not.toBeNull();
  expect(t.resolved()).toBe(0);
  expect(f.output()).toBe('');
});
