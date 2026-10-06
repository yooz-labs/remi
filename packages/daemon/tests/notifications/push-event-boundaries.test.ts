/** Actual event constructors, secure service/store/codec, real Worker/DO and owned APNs HTTP/1.1. */
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentity, relayV2 as r } from '@remi/shared';
import { FakeHost } from '../../../signaling/tests/e2e/endpoints.ts';
import { startWorker } from '../../../signaling/tests/e2e/harness.ts';
import { IdentityStore } from '../../src/auth/identity-store.ts';
import type { DeviceTokenEntry } from '../../src/cli/handlers/trivial-events.ts';
import { __resetLoggerForTests, configureLogger } from '../../src/cli/logger.ts';
import {
  ForeignSessionEscalator,
  type ForeignSessionEscalatorDeps,
} from '../../src/hooks/foreign-session-escalator.ts';
import { pushHarnessDenied } from '../../src/notifications/harness-denied.ts';
import { type PushTriggerOptions, sendPushTrigger } from '../../src/notifications/push-client.ts';
import {
  SecurePushContexts,
  type SecurePushEvent,
} from '../../src/notifications/secure-push-contexts.ts';
import {
  SecurePushService,
  type SecureSessionPush,
} from '../../src/notifications/secure-push-service.ts';
import { SecurePushStore } from '../../src/notifications/secure-push-store.ts';
import { SecurePushTransport } from '../../src/notifications/secure-push-transport.ts';
import { createTurnEventSink } from '../../src/notifications/turn-events.ts';
import { RelayDeviceStore } from '../../src/remote/relay-device-store.ts';
import { QuestionStore } from '../../src/session/question-store.ts';
import { SessionBindingStore } from '../../src/session/session-binding-store.ts';
import { SessionRegistryFile } from '../../src/session/session-registry-file.ts';
import { SessionStore } from '../../src/session/session-store.ts';

const SID = 'a0000000-0000-0000-0000-000000000000';
const FOREIGN = 'PRIVATE_FOREIGN_SESSION_SENTINEL';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
  __resetLoggerForTests();
});
async function fixture(muted = false, loseApnsResponse = false) {
  const directory = mkdtempSync(join(tmpdir(), 'remi-secure-events-'));
  chmodSync(directory, 0o700);
  cleanup.push(async () => rmSync(directory, { recursive: true, force: true }));
  const trust = new IdentityStore(directory);
  const devices = new RelayDeviceStore(directory, trust);
  const store = new SecurePushStore(directory, trust);
  const identity = await createIdentity();
  await trust.addAuthorizedKey(identity.publicKey, 'owned');
  await devices.add(identity.publicKey, 'owned');
  const authority = store.captureAuthority(identity.publicKey);
  if (!authority) throw new Error('owned authority missing');
  const pair = await r.generateEcPair();
  expect(
    await store.register(authority, {
      token: 'ab'.repeat(32),
      environment: 'sandbox',
      pushPublicKey: r.b64u(pair.publicKey),
      keyVersion: 1,
      pushPrefs: {
        questions: !muted,
        turnComplete: !muted,
        harnessDenied: !muted,
        turnFailed: !muted,
      },
    }),
  ).toEqual({ success: true, keyVersion: 1 });
  const received: { body: string; httpVersion: string }[] = [];
  const apns = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    received.push({ body, httpVersion: req.httpVersion });
    if (loseApnsResponse) {
      req.socket.destroy();
      return;
    }
    res.writeHead(200);
    res.end();
  });
  await new Promise<void>((resolve) => apns.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => {
    apns.closeAllConnections();
    await new Promise<void>((resolve) => apns.close(() => resolve()));
  });
  const address = apns.address();
  if (!address || typeof address === 'string') throw new Error('owned receiver missing');
  const jwt = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey('pkcs8', jwt.privateKey)).toString('base64')}\n-----END PRIVATE KEY-----`;
  const worker = await startWorker(
    {
      APNS_KEY_ID: 'OWNEDTEST1',
      APNS_TEAM_ID: 'OWNEDTEAM1',
      APNS_PRIVATE_KEY: pem,
      APNS_BUNDLE_ID: 'owned.synthetic.topic',
      TEST_APNS_ENDPOINT: `http://127.0.0.1:${address.port}`,
    },
    true,
  );
  cleanup.push(() => worker.stop());
  const { signer } = await r.generateIdentity();
  const rid = await r.ridOf(signer.publicKey);
  const ridHex = Buffer.from(rid).toString('hex');
  const host = await FakeHost.start(worker, { signer, publicKey: signer.publicKey, rid, ridHex });
  cleanup.push(async () => {
    host.control.close();
    await host.control.closed;
  });
  expect((await host.enroll(Buffer.from(identity.publicKey, 'base64')))['ok']).toBe(true);
  const questions = new QuestionStore(SID, {}, { redactText: true });
  const contexts = new SecurePushContexts({
    questionFor: (_sid, qid) => questions.questions.get(qid) ?? null,
    validityFor: () => ({ kind: 'closed' }),
  });
  const runtime = contexts.begin(SID);
  const outcomes: string[] = [];
  const events: SecurePushEvent[] = [];
  const tasks: Promise<unknown>[] = [];
  const service = new SecurePushService({
    store,
    contexts,
    transport: SecurePushTransport.forOwnedLoopbackTest({
      store,
      signer,
      audience: worker.url,
      ownedOrigin: worker.url,
    }),
    machinePublicKey: r.b64u(signer.publicKey),
    rid: ridHex,
    log: (outcome) => outcomes.push(outcome),
  });
  const actual = service.forRuntime(runtime);
  // Observation only: every method delegates to the actual production service.
  const secure: SecureSessionPush = {
    hasRecipients: (kind) => actual.hasRecipients(kind),
    send(event) {
      events.push(event);
      const task = actual.send(event);
      tasks.push(task);
      return task;
    },
  };
  const legacyCalls: PushTriggerOptions[] = [];
  const errors: unknown[] = [];
  const logs: string[] = [];
  configureLogger({ writeLog: (message) => logs.push(message) });
  const send = (url: string | undefined, token: string, opts: PushTriggerOptions) => {
    legacyCalls.push(opts);
    const task = sendPushTrigger(url, token, opts);
    tasks.push(task.catch(() => {}));
    return task;
  };
  const tokens = new Map<string, DeviceTokenEntry>();
  const token = (value: string) =>
    tokens.set(value, {
      token: value,
      platform: 'ios',
      registeredAt: 1,
      connectionId: 'owned-connection',
    });
  const policy = { legacyEnabled: true, authorityDirectory: directory, pushSecret: 'owned-secret' };
  const transcript = join(directory, 'foreign.jsonl');
  writeFileSync(transcript, '{"type":"user"}\n');
  const aged = new Date(Date.now() - 60000);
  utimesSync(transcript, aged, aged);
  const foreign = (overrides: Partial<ForeignSessionEscalatorDeps> = {}) =>
    new ForeignSessionEscalator({
      liveSessionsRegistry: new SessionRegistryFile(join(directory, 'live')),
      bindingStore: new SessionBindingStore(new SessionStore(join(directory, 'sessions.json'))),
      deviceTokens: tokens,
      pushConfig: () => ({ signalingUrl: worker.url, ...policy }),
      currentPort: () => 18765,
      pushFn: send,
      ...{ securePush: (sid: string) => (sid === SID ? secure : undefined) },
      ...overrides,
    });
  const sink = (config = { onTurnComplete: true, turnCompleteMinSeconds: 60 }) =>
    createTurnEventSink({
      config: () => config,
      deviceTokens: () => tokens.values(),
      sessionName: () => 'PRIVATE_SESSION_TITLE_SENTINEL',
      notifiers: new Map(),
      signalingUrl: () => worker.url,
      pushSecret: () => policy.pushSecret,
      send,
      log: (line) => logs.push(line),
      onError: (error) => errors.push(error),
      ...{
        securePush: (sid: string) => (sid === SID ? secure : undefined),
        legacyPolicy: () => policy,
      },
    });
  const denied = () =>
    pushHarnessDenied(
      {
        deviceTokens: tokens.values(),
        sessionId: SID,
        signalingUrl: worker.url,
        sessionName: 'PRIVATE_SESSION_TITLE_SENTINEL',
        send,
        onError: (error) => errors.push(error),
        ...policy,
        ...{ securePush: secure },
      },
      {
        tool_name: 'PRIVATE_TOOL_SENTINEL',
        tool_input: { command: 'PRIVATE_COMMAND_SENTINEL' },
        reason: 'PRIVATE_REASON_SENTINEL',
      },
    );
  const foreignInput = {
    session_id: FOREIGN,
    transcript_path: transcript,
    cwd: directory,
    permission_mode: 'default',
    hook_event_name: 'PermissionRequest' as const,
    tool_name: 'PRIVATE_TOOL_SENTINEL',
    tool_input: { command: 'PRIVATE_COMMAND_SENTINEL' },
  };
  const completed = {
    sessionId: SID,
    elapsedMs: 300000,
    lastAssistantMessage: 'PRIVATE_ASSISTANT_SENTINEL',
    reentry: false,
  };
  const flush = async () => {
    await Promise.all(tasks);
    await Bun.sleep(0);
  };
  const open = async () => {
    const carrier = JSON.parse(received[0]?.body ?? '')['remiPush'] as r.PushCarrier;
    return r.openPushContent(
      pair,
      carrier,
      {
        machinePublicKey: r.b64u(signer.publicKey),
        devicePublicKey: Buffer.from(identity.publicKey, 'base64').toString('base64url'),
        pushPublicKey: r.b64u(pair.publicKey),
        keyVersion: 1,
      },
      Math.floor(Date.now() / 1000),
    );
  };
  const preferences = (pushPrefs: {
    questions: boolean;
    turnComplete: boolean;
    harnessDenied: boolean;
    turnFailed: boolean;
  }) =>
    store.register(authority, {
      token: 'ab'.repeat(32),
      environment: 'sandbox',
      pushPublicKey: r.b64u(pair.publicKey),
      keyVersion: 1,
      pushPrefs,
    });
  cleanup.push(async () => {
    await Promise.allSettled(tasks);
    contexts.finish(runtime);
  });
  return {
    preferences,
    directory,
    received,
    events,
    tasks,
    outcomes,
    logs,
    legacyCalls,
    errors,
    policy,
    token,
    sink,
    denied,
    foreign,
    foreignInput,
    completed,
    flush,
    open,
  };
}
for (const event of ['turn', 'denied', 'foreign'] as const) {
  for (const legacyCount of [0, 2]) {
    test(`secure ${event} calls actual fan-out once with ${legacyCount} legacy tokens and keeps information private`, async () => {
      const f = await fixture();
      for (let i = 0; i < legacyCount; i++) f.token(`owned-${i}`);
      if (event === 'turn') f.sink().turnCompleted(f.completed);
      else if (event === 'denied') f.denied();
      else f.foreign().handleUnadmitted(f.foreignInput, SID);
      expect(f.events).toHaveLength(1); // Synchronous semantic boundary before actual network awaits.
      expect(f.events[0]?.question).toBeUndefined();
      expect(f.events[0]?.kind).toBe(
        event === 'turn' ? 'turn_complete' : event === 'denied' ? 'harness_denied' : 'question',
      );
      expect(f.events[0]?.logicalId).toBe(
        event === 'turn'
          ? `turn-complete-${SID}`
          : event === 'denied'
            ? `harness-denied-${SID}`
            : `foreign-session-${FOREIGN}`,
      );
      await f.flush();
      expect(f.received).toHaveLength(1);
      expect(f.received[0]?.httpVersion).toBe('1.1');
      expect(f.received[0]?.body).not.toContain('PRIVATE_');
      expect(f.received[0]?.body).not.toContain(SID);
      expect(f.outcomes).toEqual(['accepted']);
      const opened = await f.open();
      expect(opened.payload.type).toBe('informational');
      expect(opened.payload.actionable).toBe(false);
      expect(f.logs.join('\n')).not.toContain('PRIVATE_');
      expect(f.legacyCalls).toHaveLength(legacyCount);
      for (const call of f.legacyCalls) expect(call).toMatchObject(f.policy);
      expect(f.errors).toHaveLength(event === 'foreign' ? 0 : legacyCount);
      for (const error of f.errors) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(
          event === 'turn' ? 'TURN_COMPLETE_PUSH_FAILED' : 'HARNESS_DENIED_PUSH_FAILED',
        );
        expect(String(error)).not.toContain('PRIVATE_');
      }
    });
  }
}
test('secure event preferences and turn-complete gates remain authoritative without legacy tokens', async () => {
  const f = await fixture(true);
  f.sink().turnCompleted(f.completed);
  f.denied();
  f.foreign().handleUnadmitted(f.foreignInput, SID);
  await f.flush();
  expect(f.events).toHaveLength(0);
  expect(f.received).toHaveLength(0);
});
test('secure turn-complete still refuses config-off, unknown duration and reentry with actual recipients', async () => {
  const f = await fixture();
  f.sink({ onTurnComplete: false, turnCompleteMinSeconds: 60 }).turnCompleted(f.completed);
  f.sink().turnCompleted({ ...f.completed, elapsedMs: undefined });
  f.sink().turnCompleted({ ...f.completed, reentry: true });
  await f.flush();
  expect(f.events).toHaveLength(0);
  expect(f.received).toHaveLength(0);
});

test('secure preferences preserve questions versus harness-denied asymmetry', async () => {
  const f = await fixture();
  expect(
    await f.preferences({
      questions: false,
      turnComplete: false,
      harnessDenied: true,
      turnFailed: false,
    }),
  ).toEqual({ success: true, keyVersion: 1 });
  f.sink().turnCompleted(f.completed);
  f.foreign().handleUnadmitted(f.foreignInput, SID);
  f.denied();
  expect(f.events.map((event) => event.kind)).toEqual(['harness_denied']);
  await f.flush();
  expect(f.received).toHaveLength(1);
  expect((await f.open()).content.kind).toBe('harness_denied');
});
test('foreign escalation rate-limit suppresses a repeated actual foreign session before secure fan-out', async () => {
  const f = await fixture();
  const escalator = f.foreign();
  escalator.handleUnadmitted(f.foreignInput, SID);
  escalator.handleUnadmitted(f.foreignInput, SID);
  expect(f.events).toHaveLength(1);
  await f.flush();
  expect(f.received).toHaveLength(1);
  expect(f.logs.join('\n')).toContain('[ForeignSession] rate limited; push suppressed');
  expect(f.logs.join('\n')).not.toContain('PRIVATE_');
});
test('foreign ownership read failure logs fixed operation without session, tool or exception text', async () => {
  const f = await fixture();
  const broken = join(f.directory, 'PRIVATE_REGISTRY_SENTINEL');
  mkdirSync(broken);
  f.foreign({ bindingStore: new SessionBindingStore(new SessionStore(broken)) }).handleUnadmitted(
    f.foreignInput,
    SID,
  );
  await f.flush();
  expect(f.events).toHaveLength(0);
  expect(f.received).toHaveLength(0);
  expect(f.logs.join('\n')).toContain('[ForeignSession] ownership read failed; push suppressed');
  expect(f.logs.join('\n')).not.toContain('PRIVATE_');
});

test('foreign actual socket-loss delivery remains uncertain without resend or false failure', async () => {
  const f = await fixture(false, true);
  const escalator = f.foreign();
  escalator.handleUnadmitted(f.foreignInput, SID);
  await f.flush();
  expect(f.events).toHaveLength(1);
  expect(f.received).toHaveLength(1);
  expect(f.outcomes).toEqual(['uncertain']);
  expect((await f.open()).payload).toMatchObject({ type: 'informational', actionable: false });
  escalator.handleUnadmitted(f.foreignInput, SID);
  await f.flush();
  expect(f.events).toHaveLength(1);
  expect(f.received).toHaveLength(1);
  expect(f.legacyCalls).toHaveLength(0);
  expect(f.logs.join('\n')).not.toContain('[ForeignSession] informational push failed');
  expect(f.logs.join('\n')).toContain('[ForeignSession] informational push uncertain');
}, 15000);
