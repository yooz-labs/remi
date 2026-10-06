/**
 * `ClaudeHarness.createSession` (epic #1161, phase 3 #1164), built the way the
 * daemon builds it: a real harness over real stores, registry, message API,
 * dispatcher and (for the hook-server cases) a real `HookServer`. Most cases
 * only create the session, so nothing spawns `claude`; one starts a real PTY
 * running a fake `claude`, with a `cleanup` that never resolves so the PTY's
 * exit handler can never reach `process.exit` in the test runner. The
 * black-box launch is pinned by `integration/launch-characterization.test.ts`.
 *
 * What these pin is what that test cannot see: what the launch registers in
 * the daemon's per-session maps, that it reads the daemon's changing values
 * when it launches (`PORT`, the websocket port and the hook server are only
 * known after the harness is built), what a wrapper-mode launch does (hold
 * policy, terminal size, the local-terminal feed), and that `cli.ts` passes
 * the values the harness needs.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { UUID } from '@remi/shared';
import { createIdentity, generateId, relayV2, unlockIdentity } from '@remi/shared';
import { QuestionPresenceTracker } from '../../src/api/question-presence-tracker.ts';
import { SubagentViewRegistry } from '../../src/api/subagent-view-registry.ts';
import { IdentityStore } from '../../src/auth/identity-store.ts';
import { SubagentAlerter } from '../../src/auto-approve/index.ts';
import { __resetLoggerForTests, configureLogger } from '../../src/cli/logger.ts';
import { createMessageApiForSession } from '../../src/cli/session-phases/message-api-setup.ts';
import { childRows } from '../../src/cli/status-bar.ts';
import {
  __resetWrapperStateForTests,
  setPtyStdoutFd,
  setWrapperDetached,
} from '../../src/cli/wrapper-state.ts';
import type { ClaudeLaunchDeps } from '../../src/harness/claude-session.ts';
import { ClaudeHarness } from '../../src/harness/index.ts';
import type { HarnessSession } from '../../src/harness/index.ts';
import { ForeignSessionEscalator, HookServer } from '../../src/hooks/index.ts';
import type { HookInput } from '../../src/hooks/index.ts';
import type { NotificationDispatcher } from '../../src/notifications/notification-dispatcher.ts';
import {
  NotificationDispatcher as ActualNotificationDispatcher,
  buildPushText,
} from '../../src/notifications/notification-dispatcher.ts';
import { SecurePushContexts } from '../../src/notifications/secure-push-contexts.ts';
import { SecurePushService } from '../../src/notifications/secure-push-service.ts';
import { SecurePushStore } from '../../src/notifications/secure-push-store.ts';
import { SecurePushTransport } from '../../src/notifications/secure-push-transport.ts';
import { parseQuestion } from '../../src/parser/question-parser.ts';
import { RelayDeviceStore } from '../../src/remote/relay-device-store.ts';
import { SessionBindingStore } from '../../src/session/session-binding-store.ts';
import { SessionRegistryFile } from '../../src/session/session-registry-file.ts';
import { SessionRegistry } from '../../src/session/session-registry.ts';
import { SessionStore } from '../../src/session/session-store.ts';
import { TranscriptDiscovery } from '../../src/transcript/index.ts';
import type { TranscriptWatcher } from '../../src/transcript/index.ts';
import { stripComments } from '../helpers/strip-comments.ts';
import { WRAPPED_DIRECTORY_DIALOG } from '../parser/fixtures/claude-dialogs.ts';

const SRC = path.resolve(import.meta.dir, '..', '..', 'src');

/** The source of `file` under `src`, comments removed. */
function source(...file: string[]): string {
  return stripComments(fs.readFileSync(path.join(SRC, ...file), 'utf8'));
}

/** A fake `claude`: records what a wrapper-mode launch gave it, prints a line, waits. */
const FAKE_CLAUDE = `#!/bin/sh
d="$FAKE_CLAUDE_DIR"
printf '%s' "$REMI_STATUS_BAR" > "$d/status_bar"
stty size > "$d/size"
printf 'hello-from-fake-claude\\n'
i=0
while [ ! -e "$d/release" ] && [ $i -lt 200 ]; do
  sleep 0.1
  i=$((i + 1))
done
`;

async function until(cond: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('ClaudeHarness.createSession', () => {
  let tmpDir: string;
  let sessionRegistry: SessionRegistry;
  let sessionStore: SessionStore;
  let bindingStore: SessionBindingStore;
  let transcriptWatchers: Map<UUID, TranscriptWatcher>;
  let transcriptFallbackTimers: Map<UUID, ReturnType<typeof setInterval>>;
  let sessionNotifiers: Map<UUID, NotificationDispatcher>;
  let hookServer: HookServer | null;
  let port: number;
  let wsPort: number;
  let prompts: { hold_seconds: number; daemon_hold_seconds: number };
  let observed: string[];
  let launched: HarnessSession[];
  let servers: HookServer[];
  let registries: SessionRegistry[];
  let restoreEnv: Array<() => void>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-claude-session-'));
    configureLogger({ writeLog: () => {} });
    sessionRegistry = new SessionRegistry({ orphanTimeoutMs: 60000 });
    sessionStore = new SessionStore(path.join(tmpDir, 'sessions.json'));
    bindingStore = new SessionBindingStore(sessionStore);
    transcriptWatchers = new Map();
    transcriptFallbackTimers = new Map();
    sessionNotifiers = new Map();
    hookServer = null;
    port = 0;
    wsPort = 19999;
    prompts = { hold_seconds: 90, daemon_hold_seconds: 3540 };
    observed = [];
    launched = [];
    servers = [];
    registries = [sessionRegistry];
    restoreEnv = [];
  });

  afterEach(async () => {
    for (const session of launched) {
      if (session.pty.isRunning) session.pty.signal('SIGKILL');
    }
    for (const restore of restoreEnv) restore();
    __resetWrapperStateForTests();
    for (const session of launched) session.dispose();
    for (const timer of transcriptFallbackTimers.values()) clearInterval(timer);
    for (const server of servers) server.stop();
    __resetLoggerForTests();
    for (const registry of registries) await registry.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function buildDeps(): ClaudeLaunchDeps {
    const liveSessionsRegistry = new SessionRegistryFile(path.join(tmpDir, 'live-sessions'));
    fs.mkdirSync(liveSessionsRegistry.dirPath, { recursive: true });
    return {
      sessionRegistry,
      sessionStore,
      bindingStore,
      liveSessionsRegistry,
      transcriptDiscovery: new TranscriptDiscovery({ projectsDir: path.join(tmpDir, 'p') }),
      transcriptWatchers,
      transcriptFallbackTimers,
      subagentViews: new SubagentViewRegistry(),
      foreignSessionEscalator: new ForeignSessionEscalator({
        liveSessionsRegistry,
        bindingStore,
        deviceTokens: new Map(),
        pushConfig: () => ({ signalingUrl: 'http://127.0.0.1:1' }),
        currentPort: () => port,
      }),
      subagentAlerts: { alerter: new SubagentAlerter([]), deliver: () => {} },
      onQuestionResolved: () => {},
      onHarnessDenied: () => {},
      pushTurnFailed: () => {},
      dismissTurnFailed: () => {},
      prompts: () => prompts,
      hookServer: () => hookServer,
      currentPort: () => port,
      wsPort: () => wsPort,
      // Never resolves: the PTY's exit handler then never reaches `process.exit`.
      cleanup: () => new Promise<void>(() => {}),
      observeLocalPtyOutput: (data) => {
        observed.push(Buffer.from(data).toString('utf8'));
      },
      sessionNotifiers,
    };
  }

  function newHarness(): ClaudeHarness {
    return new ClaudeHarness(new TranscriptDiscovery({ projectsDir: tmpDir }), buildDeps());
  }

  function newHookServer(): HookServer {
    const server = new HookServer({ port: 0 }, { onError: () => {} });
    servers.push(server);
    return server;
  }

  /** A registry that has no session yet (a registry hosts one), for the next harness. */
  function freshRegistry(): void {
    sessionRegistry = new SessionRegistry({ orphanTimeoutMs: 60000 });
    registries.push(sessionRegistry);
  }

  function launch(
    harness: ClaudeHarness,
    opts: { passThrough?: boolean; reservedRows?: number; register?: boolean } = {},
  ) {
    const sessionId: UUID = generateId();
    const { messageApi, sendAndRecord } = createMessageApiForSession(
      {
        sessionRegistry,
        transcriptWatchers,
        deviceTokens: new Map(),
        pushConfig: () => ({ signalingUrl: 'http://127.0.0.1:1' }),
        updateRemiStatus: () => {},
        maxBulletLength: 500,
        sendMessage: () => {},
      },
      sessionId,
    );
    const session = harness.createSession({
      sessionId,
      workingDirectory: tmpDir,
      extraArgs: [],
      passThrough: opts.passThrough ?? false,
      reservedRows: opts.reservedRows ?? 0,
      messageApi,
      sendAndRecord,
      sendMessage: () => {},
    });
    launched.push(session);
    // The shell registers the PTY between createSession and start(); a held
    // prompt needs the registered session to land its card in.
    if (opts.register) {
      sessionRegistry.registerSession(sessionId, tmpDir, session.pty, messageApi, false, false);
    }
    return { session, sessionId, messageApi };
  }

  function claudeSessionIdOf(sessionId: UUID): string {
    const id = bindingStore.get(sessionId)?.claudeSessionId;
    if (!id) throw new Error('no binding was persisted');
    return id;
  }

  /** The Stop event Claude Code would send for `sessionId`'s own Claude session. */
  function stopEventFor(sessionId: UUID): HookInput {
    return {
      session_id: claudeSessionIdOf(sessionId),
      cwd: tmpDir,
      hook_event_name: 'Stop',
    } as HookInput;
  }

  /** POST a PermissionRequest the way Claude Code does; the response waits on the hold. */
  function postPermissionRequest(server: HookServer, claudeSessionId: string): Promise<Response> {
    return fetch(`http://127.0.0.1:${server.port}/hooks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hook_event_name: 'PermissionRequest',
        session_id: claudeSessionId,
        cwd: tmpDir,
        permission_mode: 'default',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        permission_suggestions: [],
      }),
    }).catch(() => new Response(null, { status: 499 }));
  }

  /**
   * Launch a session on a fresh registry and hook server, POST a
   * PermissionRequest, and wait until the session holds it. Returns the held
   * card and the pending hook response.
   */
  async function holdPrompt(passThrough: boolean) {
    hookServer = newHookServer();
    hookServer.start();
    freshRegistry();
    const { session, sessionId, messageApi } = launch(newHarness(), {
      passThrough,
      register: true,
    });
    const response = postPermissionRequest(hookServer, claudeSessionIdOf(sessionId));
    await until(() => session.decisions.hasMainHold(), 'the prompt to be held');
    const card = [...(sessionRegistry.getSession(sessionId)?.currentQuestions.values() ?? [])][0];
    if (!card) throw new Error('the held prompt did not reach the registry as a card');
    return { decisions: session.decisions, card, response, sessionId, messageApi };
  }

  /** Feed a captured real permission dialog into the session's real tracker. */
  function visiblePrompt(terminalOnly = false) {
    const launched = launch(newHarness(), { register: true });
    const tracker = launched.session.decisions.screen;
    if (!(tracker instanceof QuestionPresenceTracker)) throw new Error('no real screen tracker');
    const parsed = parseQuestion(WRAPPED_DIRECTORY_DIALOG).question;
    if (!parsed) throw new Error('the captured permission dialog did not parse');
    const question = { ...parsed, terminalOnly };
    tracker.onPTYPromptVisible(question);
    expect(sessionRegistry.getQuestion(launched.sessionId, question.id)).not.toBeNull();
    return { ...launched, tracker, question };
  }

  async function pushRecipient() {
    const dir = path.join(tmpDir, generateId());
    const trust = new IdentityStore(dir);
    await trust.generate();
    const device = await unlockIdentity(await createIdentity());
    await trust.addAuthorizedKey(device.publicKeyRaw, 'owned context recipient');
    await new RelayDeviceStore(dir, trust).add(device.publicKeyRaw, 'owned context recipient');
    const pair = await relayV2.generateEcPair();
    const store = new SecurePushStore(dir, trust);
    const authority = store.captureAuthority(device.publicKeyRaw);
    if (!authority) throw new Error('context recipient authority missing');
    const result = await store.register(authority, {
      token: 'ab'.repeat(32),
      environment: 'sandbox',
      pushPublicKey: relayV2.b64u(pair.publicKey),
      keyVersion: 1,
    });
    if (!result.success) throw new Error('context recipient registration missing');
    const snapshot = store.listCurrent()[0];
    if (!snapshot) throw new Error('context recipient snapshot missing');
    return { snapshot, store, trust, pair };
  }

  test('secure push context floors the actual held deadline, keeps identical event authority and never settles its hook', async () => {
    const { decisions, card, sessionId, response } = await holdPrompt(false);
    const contexts = new SecurePushContexts({
      questionFor: (sid, qid) => sessionRegistry.getQuestion(sid, qid),
      validityFor: (_sid, qid) => decisions.answerValidity(qid),
    });
    const runtime = contexts.begin(sessionId);
    const { snapshot } = await pushRecipient();
    const event = {
      kind: 'question' as const,
      logicalId: card.id,
      question: card,
      title: 'Remi',
      body: card.text,
    };
    const context = contexts.capture(runtime, snapshot, event);
    expect(context).not.toBeNull();
    if (!context) return;
    const validity = decisions.answerValidity(card.id);
    expect(validity.kind).toBe('deadline');
    if (validity.kind !== 'deadline') return;
    expect(context.content.expiresAt).toBe(Math.floor(validity.expiresAtMs / 1000));
    expect(context.payload.actionable).toBe(true);
    expect(context.content.collapseId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(context.content.collapseId).not.toContain(card.id);
    expect(contexts.capture(runtime, snapshot, event)).toBe(context);
    expect(contexts.isCurrent(context)).toBe(true);
    expect(contexts.bindDigest(context, 'ab'.repeat(32))).toBe(true);
    expect(contexts.latestAction(runtime, card.id, snapshot.publicKey)).toEqual({
      context,
      contentDigest: 'ab'.repeat(32),
    });
    expect(decisions.isHeld(card.id)).toBe(true);
    expect(decisions.answerHeld(card.id, { kind: 'cancel' })).toBe('resolved');
    await response;
    expect(contexts.isCurrent(context)).toBe(false);
  });

  test('secure push context cannot retain action after actual option meaning changes, registry removal or launch replacement', async () => {
    const { decisions, sessionId, card: question, response } = await holdPrompt(false);
    const contexts = new SecurePushContexts({
      questionFor: (sid, qid) => sessionRegistry.getQuestion(sid, qid),
      validityFor: (_sid, qid) => decisions.answerValidity(qid),
    });
    const runtime = contexts.begin(sessionId);
    const { snapshot } = await pushRecipient();
    const event = {
      kind: 'question' as const,
      logicalId: question.id,
      question,
      title: 'Remi',
      body: question.text,
    };
    const first = contexts.capture(runtime, snapshot, event);
    expect(first).not.toBeNull();
    if (!first) return;
    expect(first.payload.actionable).toBe(true);
    expect(contexts.bindDigest(first, 'ab'.repeat(32))).toBe(true);
    expect(contexts.latestAction(runtime, question.id, snapshot.publicKey)?.context).toBe(first);
    const changed = {
      ...question,
      options: question.options.map((o, i) =>
        i === 0 ? { ...o, description: 'changed meaning' } : o,
      ),
    };
    sessionRegistry.addQuestion(sessionId, changed);
    expect(contexts.isCurrent(first)).toBe(false);
    expect(contexts.latestAction(runtime, question.id, snapshot.publicKey)).toBeNull();
    const next = contexts.capture(runtime, snapshot, { ...event, question: changed });
    expect(next).not.toBeNull();
    if (!next) return;
    expect(next.content.collapseId).toBe(first.content.collapseId);
    expect(next.content.revision).toBe(first.content.revision + 1);
    sessionRegistry.removeQuestion(sessionId, question.id);
    expect(contexts.isCurrent(next)).toBe(false);
    const replacement = contexts.begin(sessionId);
    expect(replacement.instance).not.toBe(runtime.instance);
    expect(relayV2.fromB64u(replacement.instance)).toHaveLength(32);
    expect(contexts.capture(runtime, snapshot, event)).toBeNull();
    expect(decisions.answerHeld(question.id, { kind: 'cancel' })).toBe('resolved');
    await response;
  });

  test('secure push context capacity refuses another current recipient without evicting the first', async () => {
    const { session, sessionId, question } = visiblePrompt();
    const contexts = new SecurePushContexts(
      {
        questionFor: (sid, qid) => sessionRegistry.getQuestion(sid, qid),
        validityFor: (_sid, qid) => session.decisions.answerValidity(qid),
      },
      1,
      1,
    );
    const runtime = contexts.begin(sessionId);
    const { snapshot: firstRecipient } = await pushRecipient();
    const { snapshot: secondRecipient } = await pushRecipient();
    const event = {
      kind: 'question' as const,
      logicalId: question.id,
      question,
      title: 'Remi',
      body: question.text,
    };
    const first = contexts.capture(runtime, firstRecipient, event);
    expect(first).not.toBeNull();
    if (!first) return;
    expect(contexts.capture(runtime, secondRecipient, event)).toBeNull();
    expect(contexts.isCurrent(first)).toBe(true);
    contexts.finish(runtime);
    expect(contexts.isCurrent(first)).toBe(false);
  });

  for (const deliveryPath of [
    'service',
    'dispatcher',
    'terminal-notice',
    'turn-failed',
    'turn-failed-recovery',
    'dismiss',
    'runtime-finished-during-sign',
    'question-removed-during-sign',
    'options-changed-during-sign',
    'reauthorized-during-sign',
    'subscription-rotated-during-sign',
    'held-deadline-during-sign',
  ] as const) {
    test(`secure-only ${deliveryPath} sends authenticated sealed content through the real Worker and owned APNs`, async () => {
      const retiring = deliveryPath.endsWith('-during-sign');
      if (deliveryPath === 'held-deadline-during-sign')
        prompts = { hold_seconds: 5, daemon_hold_seconds: 5 };
      const { decisions, card, sessionId, response } = await holdPrompt(false);
      const { snapshot, store, trust, pair } = await pushRecipient();
      const { createServer } = await import('node:http');
      const { startWorker } = await import('../../../signaling/tests/e2e/harness.ts');
      const bodies: string[] = [];
      const apns = createServer(async (request, reply) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        bodies.push(Buffer.concat(chunks).toString('utf8'));
        reply.writeHead(200);
        reply.end();
      });
      await new Promise<void>((resolve) => apns.listen(0, '127.0.0.1', resolve));
      const address = apns.address();
      if (!address || typeof address === 'string') throw new Error('owned APNs listener missing');
      const signing = await crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['sign', 'verify'],
      );
      const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', signing.privateKey));
      const pem = `-----BEGIN PRIVATE KEY-----\n${der
        .toString('base64')
        .match(/.{1,64}/g)
        ?.join('\n')}\n-----END PRIVATE KEY-----`;
      let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
      try {
        worker = await startWorker(
          {
            APNS_KEY_ID: 'OWNEDTEST1',
            APNS_TEAM_ID: 'OWNEDTEAM1',
            APNS_PRIVATE_KEY: pem,
            APNS_BUNDLE_ID: 'owned.synthetic.topic',
            TEST_APNS_ENDPOINT: `http://127.0.0.1:${address.port}`,
          },
          true,
        );
        const machine = await trust.unlock();
        const signer = await relayV2.signerFromKey(
          machine.privateKey,
          new Uint8Array(Buffer.from(machine.publicKeyRaw, 'base64')),
        );
        const rid = Buffer.from(await relayV2.ridOf(signer.publicKey)).toString('hex');
        const { FakeHost } = await import('../../../signaling/tests/e2e/endpoints.ts');
        const host = await FakeHost.start(worker, {
          signer,
          publicKey: signer.publicKey,
          rid: await relayV2.ridOf(signer.publicKey),
          ridHex: rid,
        });
        try {
          expect(
            (await host.enroll(new Uint8Array(Buffer.from(snapshot.publicKey, 'base64'))))['ok'],
          ).toBe(true);
          const signalingUrl = worker.url;
          const contexts = new SecurePushContexts({
            questionFor: (sid, qid) => sessionRegistry.getQuestion(sid, qid),
            validityFor: (_sid, qid) => decisions.answerValidity(qid),
          });
          const runtime = contexts.begin(sessionId);
          let signingPaused = false;
          let signingReached = false;
          let releaseSigning: () => void = () => {};
          const signingGate = new Promise<void>((resolve) => {
            releaseSigning = resolve;
          });
          // The engine's real signature completes unchanged; only returning it is delayed.
          const observedSigner: relayV2.Signer = {
            publicKey: signer.publicKey,
            async sign(input) {
              const signed = await signer.sign(input);
              if (retiring && !signingPaused) {
                signingPaused = true;
                signingReached = true;
                await signingGate;
              }
              return signed;
            },
          };
          const service = new SecurePushService({
            store,
            contexts,
            transport: SecurePushTransport.forOwnedLoopbackTest({
              store,
              signer: observedSigner,
              audience: worker.url,
              ownedOrigin: worker.url,
            }),
            machinePublicKey: relayV2.b64u(signer.publicKey),
            rid,
            log: () => {},
          });
          const secure = service.forRuntime(runtime);
          const dispatcher = new ActualNotificationDispatcher(
            {
              sessionRegistry,
              deviceTokens: new Map(),
              pushConfig: () => ({ signalingUrl }),
              getPrimarySessionId: () => sessionId,
              securePush: secure,
            },
            sessionId,
          );
          const text = buildPushText(sessionRegistry.getSession(sessionId)?.name || 'Agent', card);
          if (retiring) {
            const pending = dispatcher.maybePush(sessionId, card, { held: true });
            try {
              await until(() => signingReached, 'actual content signature to complete');
              if (deliveryPath === 'runtime-finished-during-sign') contexts.finish(runtime);
              else if (deliveryPath === 'question-removed-during-sign')
                sessionRegistry.removeQuestion(sessionId, card.id, 'owned-retirement');
              else if (deliveryPath === 'options-changed-during-sign')
                sessionRegistry.addQuestion(sessionId, {
                  ...card,
                  options: card.options.map((option) => ({
                    ...option,
                    description: 'changed meaning',
                  })),
                });
              else if (deliveryPath === 'reauthorized-during-sign') {
                trust.removeAuthorizedKey(snapshot.fingerprint);
                await trust.addAuthorizedKey(snapshot.publicKey, 'owned reauthorization');
              } else if (deliveryPath === 'subscription-rotated-during-sign') {
                const authority = store.captureAuthority(snapshot.publicKey);
                if (!authority) throw new Error('owned authority missing');
                const replacement = await relayV2.generateEcPair();
                expect(
                  await store.register(authority, {
                    token: snapshot.token,
                    environment: snapshot.environment,
                    pushPublicKey: relayV2.b64u(replacement.publicKey),
                    keyVersion: snapshot.keyVersion + 1,
                  }),
                ).toEqual({ success: true, keyVersion: snapshot.keyVersion + 1 });
              } else await until(() => !decisions.isHeld(card.id), 'real held deadline');
            } finally {
              releaseSigning();
            }
            await expect(pending).resolves.toBe('failed');
            expect(bodies).toHaveLength(0);
            if (decisions.isHeld(card.id))
              expect(decisions.answerHeld(card.id, { kind: 'cancel' })).toBe('resolved');
            await response;
            return;
          }
          const expectedCount =
            deliveryPath === 'dismiss' ? 2 : deliveryPath === 'turn-failed-recovery' ? 3 : 1;
          if (deliveryPath === 'dismiss')
            await expect(dispatcher.maybePush(sessionId, card, { held: true })).resolves.toBe(
              'pushed',
            );
          const deliver = async () => {
            if (deliveryPath === 'service')
              return secure.send({ kind: 'question', logicalId: card.id, question: card, ...text });
            if (deliveryPath === 'dispatcher')
              return dispatcher.maybePush(sessionId, card, { held: true });
            if (deliveryPath === 'turn-failed')
              return dispatcher.pushTurnFailed({ error: 'rate_limit' });
            if (deliveryPath === 'turn-failed-recovery') {
              if (bodies.length === expectedCount)
                return dispatcher.pushTurnFailed({ error: 'authentication' });
              await expect(dispatcher.pushTurnFailed({ error: 'rate_limit' })).resolves.toBe(
                'pushed',
              );
              dispatcher.dismissTurnFailed();
              const deadline = Date.now() + 3000;
              while (bodies.length < 2 && Date.now() < deadline) await Bun.sleep(10);
              expect(bodies).toHaveLength(2);
              return dispatcher.pushTurnFailed({ error: 'authentication' });
            }
            if (deliveryPath === 'terminal-notice')
              dispatcher.pushTerminalNotice(sessionId, card, 'released_no_terminal');
            else dispatcher.dismiss(sessionId, card.id);
            const deadline = Date.now() + 3000;
            while (bodies.length < expectedCount && Date.now() < deadline) await Bun.sleep(10);
            return bodies.length === expectedCount ? 'pushed' : 'failed';
          };
          await expect(deliver()).resolves.toBe('pushed');
          expect(bodies).toHaveLength(expectedCount);
          const raw = bodies[expectedCount - 1];
          const outer = JSON.parse(raw ?? '');
          expect(outer.aps.category ?? '').toBe('');
          expect(raw).not.toContain(card.text);
          expect(raw).not.toContain(sessionId);
          expect(raw).not.toContain(card.id);
          const opened = await relayV2.openPushContent(
            pair,
            outer.remiPush,
            {
              machinePublicKey: relayV2.b64u(signer.publicKey),
              devicePublicKey: Buffer.from(snapshot.publicKey, 'base64').toString('base64url'),
              pushPublicKey: snapshot.pushPublicKey,
              keyVersion: snapshot.keyVersion,
            },
            Math.floor(Date.now() / 1000),
          );
          if (deliveryPath === 'service' || deliveryPath === 'dispatcher') {
            expect(opened.payload).toMatchObject({
              type: 'question',
              actionable: true,
              sessionId,
              questionId: card.id,
              runtimeInstance: runtime.instance,
            });
            expect(contexts.latestAction(runtime, card.id, snapshot.publicKey)?.contentDigest).toBe(
              opened.contentDigest,
            );
          } else {
            expect(opened.payload).toMatchObject({
              type: deliveryPath === 'dismiss' ? 'dismiss' : 'informational',
              actionable: false,
            });
          }
          await deliver();
          expect(bodies).toHaveLength(expectedCount);
        } finally {
          host.control.close();
          await host.control.closed;
        }
        expect(decisions.answerHeld(card.id, { kind: 'cancel' })).toBe('resolved');
        await response;
      } finally {
        await worker?.stop();
        apns.closeAllConnections();
        await new Promise<void>((resolve) => apns.close(() => resolve()));
      }
    }, 15000);
  }
  test('secure push context real held slot fans out without eviction and dismissal remains absorbing', async () => {
    const { decisions, card, sessionId, response } = await holdPrompt(false);
    const contexts = new SecurePushContexts(
      {
        questionFor: (sid, qid) => sessionRegistry.getQuestion(sid, qid),
        validityFor: (_sid, qid) => decisions.answerValidity(qid),
      },
      4,
      1,
    );
    const runtime = contexts.begin(sessionId);
    const { snapshot: firstRecipient } = await pushRecipient();
    const { snapshot: secondRecipient } = await pushRecipient();
    const event = {
      kind: 'question' as const,
      logicalId: card.id,
      question: card,
      title: 'Remi',
      body: card.text,
    };
    const first = contexts.capture(runtime, firstRecipient, event);
    const second = contexts.capture(runtime, secondRecipient, event);
    if (!first || !second) throw new Error('missing held recipient context');
    expect(first?.payload.actionable).toBe(true);
    expect(second?.payload.actionable).toBe(true);
    expect(
      contexts.capture(runtime, firstRecipient, { kind: 'turn_complete', logicalId: generateId() }),
    ).toBeNull();
    expect(contexts.isCurrent(first)).toBe(true);
    const host = await relayV2.generateIdentity();
    const metadata = {
      ...first.content,
      machinePublicKey: relayV2.b64u(host.signer.publicKey),
      rid: Buffer.from(await relayV2.ridOf(host.signer.publicKey)).toString('hex'),
    };
    const payload = relayV2.buildPushPayload(first.payload);
    const signature = await host.signer.sign(
      await relayV2.buildPushContentSigningInput(metadata, payload),
    );
    expect(
      relayV2.encodeSignedPushContent(metadata, payload, signature).length - payload.length,
    ).toBe(324);
    const dismiss = contexts.capture(runtime, firstRecipient, {
      kind: 'dismiss',
      logicalId: card.id,
    });
    expect(dismiss?.payload).toEqual({ type: 'dismiss', actionable: false });
    expect(dismiss?.content.collapseId).toBe(first.content.collapseId);
    expect(contexts.isCurrent(first)).toBe(false);
    expect(contexts.capture(runtime, firstRecipient, event)).toBeNull();
    expect(contexts.capture(runtime, firstRecipient, { kind: 'dismiss', logicalId: card.id })).toBe(
      dismiss,
    );
    expect(contexts.isCurrent(second)).toBe(true);
    expect(decisions.isHeld(card.id)).toBe(true);
    expect(decisions.answerHeld(card.id, { kind: 'cancel' })).toBe('resolved');
    await response;
  });

  test('secure push context real held cards refuse action for truncated and structured content', async () => {
    const { decisions, card, sessionId, response } = await holdPrompt(false);
    const contexts = new SecurePushContexts({
      questionFor: (sid, qid) => sessionRegistry.getQuestion(sid, qid),
      validityFor: (_sid, qid) => decisions.answerValidity(qid),
    });
    const runtime = contexts.begin(sessionId);
    const { snapshot: recipient } = await pushRecipient();
    const event = {
      kind: 'question' as const,
      logicalId: card.id,
      question: card,
      title: 'Remi',
      body: card.text,
    };
    const truncated = contexts.capture(runtime, recipient, { ...event, body: '😀'.repeat(140) });
    expect(truncated?.payload.type).toBe('informational');
    expect(truncated?.payload.actionable).toBe(false);
    if (truncated?.payload.type !== 'informational') throw new Error('no informational fallback');
    expect(new TextEncoder().encode(truncated.payload.body).length).toBeLessThanOrEqual(512);
    const structured = { ...card, kind: 'multi_question' as const, questions: [] };
    sessionRegistry.addQuestion(sessionId, structured);
    const noActions = contexts.capture(runtime, recipient, { ...event, question: structured });
    expect(noActions?.payload.type).toBe('informational');
    expect(noActions?.payload.actionable).toBe(false);
    expect(contexts.isCurrent(truncated)).toBe(false);
    expect(decisions.isHeld(card.id)).toBe(true);
    expect(decisions.answerHeld(card.id, { kind: 'cancel' })).toBe('resolved');
    await response;
  });

  test('push validity: an actual held hook keeps its captured deadline after configuration changes and closes on answer', async () => {
    const { decisions, card, response } = await holdPrompt(false);
    const captured = decisions.answerValidity(card.id);
    expect(captured.kind).toBe('deadline');
    if (captured.kind !== 'deadline') throw new Error('no held deadline');
    expect(captured.expiresAtMs).toBeGreaterThan(Date.now());
    prompts = { hold_seconds: 5, daemon_hold_seconds: 5 };
    await Bun.sleep(5);
    expect(decisions.answerValidity(card.id)).toEqual(captured);
    expect(decisions.answerHeld(card.id, { kind: 'cancel' })).toBe('resolved');
    expect(JSON.stringify(await (await response).json())).toContain('"deny"');
    expect(decisions.answerValidity(card.id)).toEqual({ kind: 'closed' });
  });

  test('push validity: removing the actual registered card closes authority while its hook is still held', async () => {
    const { decisions, card, response, sessionId } = await holdPrompt(false);
    expect(decisions.answerValidity(card.id).kind).toBe('deadline');
    sessionRegistry.removeQuestion(sessionId, card.id, 'push-validity-test');
    expect(decisions.isHeld(card.id)).toBe(true);
    expect(decisions.answerValidity(card.id)).toEqual({ kind: 'closed' });
    // Reading validity did not decide the pending hook.
    expect(decisions.answerHeld(card.id, { kind: 'cancel' })).toBe('resolved');
    expect(JSON.stringify(await (await response).json())).toContain('"deny"');
  });

  test('push validity: a real hookless prompt requires both its registry entry and current screen, including an unchanged redraw', () => {
    const { session, sessionId, tracker, question } = visiblePrompt();
    expect(session.decisions.answerValidity(question.id)).toEqual({ kind: 'current-prompt' });
    const redraw = parseQuestion(WRAPPED_DIRECTORY_DIALOG).question;
    if (!redraw) throw new Error('the captured redraw did not parse');
    expect(redraw.id).not.toBe(question.id);
    tracker.onPTYPromptVisible(redraw);
    // Actual content dedup retains the first card while the same dialog redraws.
    expect(sessionRegistry.getQuestion(sessionId, question.id)).not.toBeNull();
    expect(session.decisions.answerValidity(question.id)).toEqual({ kind: 'current-prompt' });
    tracker.clearPending();
    expect(sessionRegistry.getQuestion(sessionId, question.id)).not.toBeNull();
    expect(session.decisions.answerValidity(question.id)).toEqual({ kind: 'closed' });
    tracker.onPTYPromptVisible(question);
    expect(session.decisions.answerValidity(question.id)).toEqual({ kind: 'current-prompt' });
    sessionRegistry.removeQuestion(sessionId, question.id, 'push-validity-test');
    expect(tracker.isPromptCurrent(question.id)).toBe(true);
    expect(session.decisions.answerValidity(question.id)).toEqual({ kind: 'closed' });
  });

  test('push validity: a held-stamped card with no gate never gains authority from a matching real screen', () => {
    const { session, sessionId, messageApi, tracker, question } = visiblePrompt();
    messageApi.handleQuestion(question, { held: true });
    expect(sessionRegistry.getQuestion(sessionId, question.id)?.held).toBe(true);
    expect(tracker.isPromptCurrent(question.id)).toBe(true);
    expect(session.decisions.isHeld(question.id)).toBe(false);
    expect(session.decisions.answerValidity(question.id)).toEqual({ kind: 'closed' });
  });

  test('push validity: a terminal-only or answered registry card and a disposed session have no action authority', () => {
    const terminal = visiblePrompt(true);
    expect(terminal.session.decisions.answerValidity(terminal.question.id)).toEqual({
      kind: 'closed',
    });
    freshRegistry();
    const { session, sessionId, tracker, question } = visiblePrompt();
    const current = sessionRegistry.getQuestion(sessionId, question.id);
    if (!current) throw new Error('no current card');
    current.isAnswered = true;
    expect(session.decisions.answerValidity(question.id)).toEqual({ kind: 'closed' });
    current.isAnswered = false;
    expect(session.decisions.answerValidity(question.id)).toEqual({ kind: 'current-prompt' });
    session.dispose();
    // Neither lingering registry state nor the prior observed dialog revives a closed launch.
    expect(sessionRegistry.getQuestion(sessionId, question.id)).not.toBeNull();
    expect(tracker.isPromptCurrent(question.id)).toBe(true);
    expect(session.decisions.answerValidity(question.id)).toEqual({ kind: 'closed' });
    expect(session.decisions.answerValidity(generateId())).toEqual({ kind: 'closed' });
  });

  test('a harness built without launch dependencies refuses to create a session', () => {
    const harness = new ClaudeHarness(new TranscriptDiscovery({ projectsDir: tmpDir }));
    expect(() => launch(harness)).toThrow('without launch dependencies');
  });

  test('returns an unstarted session, leaves the notifier to the shell and exposes its screen, and binds the port read at launch', () => {
    const harness = newHarness();
    // PORT is reassigned by port probing after the harness exists; the launch
    // must read it when it runs, not when the harness was built.
    port = 19123;

    const { session, sessionId } = launch(harness);

    expect(session.pty.isRunning).toBe(false);
    expect(session.pty.childPid).toBeNull();
    // The shell (`createNewSession`) registers the dispatcher before it calls
    // `createSession` (#1165 E); the launch no longer does.
    expect(sessionNotifiers.has(sessionId)).toBe(false);
    expect(session.decisions.screen).toBeDefined();
    const stored = sessionStore.findByRemiSessionId(sessionId);
    expect(stored?.port).toBe(19123);
    expect(stored?.pid).toBe(process.pid);
    expect(stored?.exitedAt).toBeNull();
    expect(stored?.claudeSessionId).toMatch(/^[0-9a-f-]{36}$/);
    // No hook server: the bridge is never built, so no turn filter registers.
    expect(harness.admitsAnySession(stopEventFor(sessionId))).toBe(false);
  });

  test('reads the hook server and the websocket port when it launches, and with a server arms the binder and the turn filter', () => {
    // The daemon builds the harness before the hook server or the websocket
    // port exist; both are read per launch.
    hookServer = null;
    wsPort = 0;
    const harness = newHarness();
    wsPort = 19999;

    const before = launch(harness);
    expect(harness.admitsAnySession(stopEventFor(before.sessionId))).toBe(false);

    hookServer = newHookServer();
    const { sessionId } = launch(harness);

    // preAssign ran before the bridge read the binding: the binder armed its
    // fallback poll for the pre-assigned id.
    expect(transcriptFallbackTimers.has(sessionId)).toBe(true);
    const own = stopEventFor(sessionId);
    expect(harness.admitsAnySession(own)).toBe(true);
    expect(harness.admitsAnySession({ ...own, session_id: generateId() } as HookInput)).toBe(false);
  });

  test('a wrapper session runs claude on the reduced terminal and feeds the local-terminal observer', async () => {
    const fakeDir = path.join(tmpDir, 'fake');
    const fakeBin = path.join(tmpDir, 'fake-bin');
    fs.mkdirSync(fakeDir);
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, 'claude'), FAKE_CLAUDE);
    fs.chmodSync(path.join(fakeBin, 'claude'), 0o755);
    for (const [name, value] of [
      // Only the fake and the system directories: a test never starts a real `claude`.
      ['PATH', `${fakeBin}:/usr/bin:/bin`],
      ['FAKE_CLAUDE_DIR', fakeDir],
    ] as const) {
      const previous = process.env[name];
      process.env[name] = value;
      restoreEnv.push(() => {
        if (previous === undefined) Reflect.deleteProperty(process.env, name);
        else process.env[name] = previous;
      });
    }
    // The wrapper's real terminal, here a file: `onRawData` writes to it and
    // then feeds the observer with the same bytes.
    const terminal = fs.openSync(path.join(tmpDir, 'terminal.out'), 'w');
    restoreEnv.push(() => fs.closeSync(terminal));
    setPtyStdoutFd(terminal);
    setWrapperDetached(false);
    hookServer = newHookServer();

    const { session } = launch(newHarness(), { passThrough: true, reservedRows: 2 });
    await session.start();

    // The fake creates `size` when its shell opens the redirect and fills it a
    // moment later (`stty` writes it), so the file existing is not the file
    // having its content (#1185): wait for the content.
    await until(
      () =>
        fs.existsSync(path.join(fakeDir, 'size')) &&
        fs.readFileSync(path.join(fakeDir, 'size'), 'utf8').trim() !== '',
      'the fake claude to report its terminal size',
    );
    // reservedRows > 0 makes the child's statusLine drop the remi prefix, and
    // passThrough sizes the child from the wrapper's own terminal minus the bar.
    expect(fs.readFileSync(path.join(fakeDir, 'status_bar'), 'utf8')).toBe('1');
    expect(fs.readFileSync(path.join(fakeDir, 'size'), 'utf8').trim()).toBe(
      `${childRows(process.stdout.rows || 40, true)} ${process.stdout.columns || 120}`,
    );
    await until(
      () => observed.join('').includes('hello-from-fake-claude'),
      'the local-terminal observer to see the PTY output',
    );
    expect(fs.readFileSync(path.join(tmpDir, 'terminal.out'), 'utf8')).toContain(
      'hello-from-fake-claude',
    );
  });

  test('the hold deadline follows passThrough: a wrapper session hands a prompt back after hold_seconds, a daemon session keeps it', async () => {
    prompts = { hold_seconds: 1, daemon_hold_seconds: 3540 };

    /** What a session still reports 1.5 s after it was held. */
    async function afterDeadline(passThrough: boolean) {
      const { decisions } = await holdPrompt(passThrough);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return { held: decisions.hasMainHold(), open: decisions.hasOpenHookPrompt() };
    }

    // The wrapper's dialog is on its own terminal: no longer held, still open.
    expect(await afterDeadline(true)).toEqual({ held: false, open: true });
    expect(await afterDeadline(false)).toEqual({ held: true, open: true });
  });

  test('with a hook server its decisions answer the prompt that server holds', async () => {
    const { decisions, card, response } = await holdPrompt(false);
    const yes = card.options.find((option) => option.isYes);
    if (!yes) throw new Error('the held card has no Yes option');

    expect(decisions.isHeld(card.id as UUID)).toBe(true);
    expect(decisions.isHeld(generateId())).toBe(false);
    expect(decisions.answerHeld(card.id as UUID, { kind: 'option', option: yes })).toBe('resolved');

    expect(JSON.stringify(await (await response).json())).toContain('"allow"');
    expect(decisions.hasMainHold()).toBe(false);
    expect(decisions.isHeld(card.id as UUID)).toBe(false);
  });

  test('retire, force release and a terminal Escape reach the gate through the decisions', async () => {
    // A retired live hold ends with the empty response, never a decision.
    const retired = await holdPrompt(false);
    retired.decisions.retireQuestion(retired.card.id as UUID);
    expect(retired.decisions.hasMainHold()).toBe(false);
    expect(await (await retired.response).text()).not.toMatch(/allow|deny/);

    // `remi unstick` hands a live hold to the terminal.
    const forced = await holdPrompt(false);
    expect(typeof forced.decisions.forceRelease('test').resolved).toBe('number');
    expect(forced.decisions.hasMainHold()).toBe(false);
    expect(await (await forced.response).text()).not.toMatch(/allow|deny/);

    // A prompt released at the wrapper's deadline stays open until an Escape
    // sent through remi resolves it.
    prompts = { hold_seconds: 1, daemon_hold_seconds: 3540 };
    const wrapper = await holdPrompt(true);
    await until(() => !wrapper.decisions.hasMainHold(), 'the wrapper hold to reach its deadline');
    expect(wrapper.decisions.hasOpenHookPrompt()).toBe(true);
    wrapper.decisions.noteTerminalEscape();
    expect(wrapper.decisions.hasOpenHookPrompt()).toBe(false);
  });

  test('a session with no hook server reads as nothing held', () => {
    const { session } = launch(newHarness());
    const { decisions } = session;

    expect(decisions.hasMainHold()).toBe(false);
    expect(decisions.hasOpenHookPrompt()).toBe(false);
    expect(decisions.isHeld(generateId())).toBe(false);
    expect(decisions.answerHeld(generateId(), { kind: 'cancel' })).toBe('unknown');
    expect(decisions.forceRelease('test')).toEqual({ resolved: 0 });
    expect(() => decisions.retireQuestion(generateId())).not.toThrow();
    expect(() => decisions.noteTerminalEscape()).not.toThrow();
  });

  test('each session claims only its own events, and dispose releases the binder and the filter (#914)', () => {
    hookServer = newHookServer();
    const harness = newHarness();
    const a = launch(harness);
    const b = launch(harness);
    const eventA = stopEventFor(a.sessionId);
    const eventB = stopEventFor(b.sessionId);

    expect(transcriptFallbackTimers.has(a.sessionId)).toBe(true);
    expect(harness.admitsAnySession(eventA)).toBe(true);
    expect(harness.admitsAnySession(eventB)).toBe(true);
    expect(harness.admitsAnySession({ ...eventA, session_id: generateId() } as HookInput)).toBe(
      false,
    );

    a.session.dispose();
    expect(transcriptFallbackTimers.has(a.sessionId)).toBe(false);
    // A second dispose must not close the binder again: a sentinel timer
    // registered under the id survives it (a second `binder.close()` would
    // delete the entry).
    const sentinel = setInterval(() => {}, 1e6);
    transcriptFallbackTimers.set(a.sessionId, sentinel);
    a.session.dispose();
    expect(transcriptFallbackTimers.get(a.sessionId)).toBe(sentinel);
    clearInterval(sentinel);
    transcriptFallbackTimers.delete(a.sessionId);

    expect(harness.admitsAnySession(eventA)).toBe(false);
    expect(harness.admitsAnySession(eventB)).toBe(true);
    expect(transcriptFallbackTimers.has(b.sessionId)).toBe(true);
  });

  test('a binder that fails to close still loses its turn filter', () => {
    // The binder's close looks its fallback timer up first; make that throw.
    let failLookup = false;
    class FlakyTimers extends Map<UUID, ReturnType<typeof setInterval>> {
      override get(key: UUID) {
        if (failLookup) throw new Error('binder close failed');
        return super.get(key);
      }
    }
    transcriptFallbackTimers = new FlakyTimers();
    hookServer = newHookServer();
    const harness = newHarness();
    const { session, sessionId } = launch(harness);
    const own = stopEventFor(sessionId);
    expect(harness.admitsAnySession(own)).toBe(true);

    failLookup = true;
    expect(() => session.dispose()).toThrow('binder close failed');
    failLookup = false;

    expect(harness.admitsAnySession(own)).toBe(false);
  });
});

describe('what cli.ts hands the harness (#1164)', () => {
  const cli = source('cli.ts');
  const claudeSession = source('harness', 'claude-session.ts');

  /** The text of `cli.ts` from `marker` to the first `end` after it. */
  function slice(marker: string, end: string): string {
    const start = cli.indexOf(marker);
    expect(start, marker).toBeGreaterThan(0);
    const stop = cli.indexOf(end, start);
    expect(stop, `${marker} ... ${end}`).toBeGreaterThan(start);
    return cli.slice(start, stop);
  }

  // Scoped to the harness's own construction: `currentPort: () => PORT` is
  // also spelled by other dependencies elsewhere in the file.
  const construction = () => slice('const claudeHarness = new ClaudeHarness(', '\n});');

  test('getters for hookServer, the port, the websocket port and [prompts]', () => {
    expect(construction()).toContain('hookServer: () => hookServer,');
    expect(construction()).toContain('currentPort: () => PORT,');
    expect(construction()).toContain('wsPort: () => remiStatus.wsPort,');
    expect(construction()).toContain('prompts: () => remiConfig.prompts,');
  });

  test('the local-terminal observer feeds the wrapper quiescence gate and status bar', () => {
    expect(construction()).toContain('observeLocalPtyOutput: (data) => {');
    expect(construction()).toContain('wrapperPtyGate.observe(data)');
    expect(construction()).toContain('statusBar?.notifyScrollRegionReset()');
  });

  test('createNewSession passes passThrough and reservedRows to createSession', () => {
    const call = slice('harness.createSession({', '});');
    expect(call).toContain('passThrough,');
    expect(call).toContain('reservedRows,');
    expect(call).toContain('extraArgs,');
  });

  test('createClaudeSession gives the PTY the context it was handed', () => {
    expect(claudeSession).toContain(
      '{ sessionId, workingDirectory, extraArgs: binding.args, passThrough, reservedRows },',
    );
  });

  test('the PTY output callbacks read hookServer when the event fires, not when the session launches', () => {
    const start = claudeSession.indexOf('new OutputProcessor(');
    const end = claudeSession.indexOf('resolveClaudeBinding(', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const callbacks = claudeSession.slice(start, end);
    expect(callbacks).toContain('if (deps.hookServer()) {');
    expect(callbacks).toContain('if (!deps.hookServer()) {');
  });

  /** The text of the top-level function `name` in `cli.ts`, to its closing brace. */
  function functionBody(name: string): string {
    return slice(`function ${name}(`, '\n}\n');
  }

  test('createNewSession stores the session after createSession returns, before it registers it', () => {
    const shell = slice('async function createNewSession(', '\n}\n');
    const created = shell.indexOf('harness.createSession({');
    const stored = shell.indexOf('harnessSessions.set(sessionId, session);');
    const registered = shell.indexOf('sessionRegistry.registerSession(');
    expect(created).toBeGreaterThan(0);
    expect(stored).toBeGreaterThan(created);
    expect(registered).toBeGreaterThan(stored);
  });

  test('remi unstick force-releases every harness session and logs the session count', () => {
    const body = functionBody('forceReleaseAllSessions');
    expect(body).toContain('harnessSessions.entries()');
    expect(body).toContain("session.decisions.forceRelease('force-release (remi unstick)')");
    // A session with no hook server counts too: it has 0 cards to resolve.
    expect(body).toContain('${harnessSessions.size} session(s)');
  });

  test('session close disposes the harness session before it drops it', () => {
    const closed = slice(
      'onSessionClosed: (sessionId, reason) => {',
      'sessionNotifiers.delete(sessionId);',
    );
    const disposed = closed.indexOf('harnessSessions.get(sessionId)?.dispose();');
    const dropped = closed.indexOf('harnessSessions.delete(sessionId);');
    expect(disposed).toBeGreaterThan(0);
    expect(dropped).toBeGreaterThan(disposed);
  });

  test('cleanup stops the hook server before it disposes the sessions, and keeps them in the map', () => {
    const body = functionBody('cleanup');
    const stopped = body.indexOf('hookServer.stop();');
    const disposed = body.indexOf('session.dispose();');
    expect(stopped).toBeGreaterThan(0);
    expect(disposed).toBeGreaterThan(stopped);
    expect(body).not.toContain('harnessSessions.clear()');
  });

  test('the answer handlers and the turn-stop listener read the harness sessions', () => {
    // The gate handlers (answer, retire, terminal Escape) read the session's decisions.
    const handlers = slice('const inputHandlers: InputHandlers = createInputHandlers({', '\n});');
    expect(handlers).toContain(
      '...gateAnswerDeps((sessionId) => harnessSessions.get(sessionId)?.decisions),',
    );
    // onTurnStop is built with the #914 session filter: it asks the harness whether any session claims the
    // event (its order against the timer is `notifications/claude-turn-stop.ts`'s, pinned in its own test).
    expect(cli).toContain('admits: (input) => claudeHarness.admitsAnySession(input),');
  });

  test('a commented-out line does not satisfy a pin', () => {
    expect(stripComments('// hookServer: () => hookServer,\nconst a = 1;')).not.toContain(
      'hookServer: () => hookServer,',
    );
    expect(stripComments('/* passThrough, */ x')).not.toContain('passThrough,');
  });
});
