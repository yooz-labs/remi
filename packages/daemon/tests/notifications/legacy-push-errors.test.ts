/**
 * The dispatcher against the REAL legacy sender and an owned HTTP receiver (#1200, B6).
 * The classifiers read what `sendPushTrigger` actually throws, so retry and dead-token pruning
 * work end to end; a disabled or latched legacy channel is no channel, not a failure.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Question, QuestionOption, UUID } from '@remi/shared';
import type { DeviceTokenEntry } from '../../src/cli/handlers/trivial-events.ts';
import { __resetLoggerForTests, configureLogger } from '../../src/cli/logger.ts';
import {
  NotificationDispatcher,
  type PushConfig,
} from '../../src/notifications/notification-dispatcher.ts';
import type { PTYSession } from '../../src/pty/pty-session.ts';
import { SessionRegistry } from '../../src/session/session-registry.ts';

const SID = 's0000000-0000-0000-0000-000000000000' as UUID;
const QID = 'q0000000-0000-0000-0000-000000000000' as UUID;
const TOKEN = 'PRIVATE_TOKEN_SENTINEL';
const yes: QuestionOption = {
  value: 'y',
  label: 'Yes',
  isRecommended: true,
  isYes: true,
  isNo: false,
};
const no: QuestionOption = {
  value: 'n',
  label: 'No',
  isRecommended: false,
  isYes: false,
  isNo: true,
};
const question: Question = {
  id: QID,
  text: 'proceed?',
  options: [yes, no],
  allowsFreeText: false,
  isAnswered: false,
};
const pty = {
  id: 'pty',
  write: () => {},
  submitInput: async () => {},
  close: async () => {},
} as unknown as PTYSession;

let directory: string;
let server: ReturnType<typeof Bun.serve>;
let statuses: Array<{ status: number; body: string }>;
let requests: string[];
let registry: SessionRegistry;
let deviceTokens: Map<string, DeviceTokenEntry>;
let pruned: string[];
let logs: string[];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'remi-legacy-errors-'));
  chmodSync(directory, 0o700);
  statuses = [];
  requests = [];
  pruned = [];
  logs = [];
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      requests.push(await req.text());
      const next = statuses.shift() ?? { status: 200, body: '{"success":true}' };
      return new Response(next.body, { status: next.status });
    },
  });
  registry = new SessionRegistry({ orphanTimeoutMs: 60000 });
  registry.registerSession(SID, '/d', pty, {
    handleMessage: () => {},
    handleQuestion: () => {},
    handleStatusChange: () => {},
  } as never);
  deviceTokens = new Map([
    [TOKEN, { token: TOKEN, platform: 'ios', registeredAt: 1, connectionId: SID }],
  ]);
  configureLogger({ writeLog: (message) => logs.push(message) });
});
afterEach(async () => {
  await server.stop(true);
  await registry.shutdown();
  __resetLoggerForTests();
  rmSync(directory, { recursive: true, force: true });
});

/** The dispatcher's own error lines. The logger is process-wide, so in a full run other files'
 *  timers (transcript watchers) can log errors into this capture. */
const pushErrors = () =>
  logs.filter((line) =>
    /^\[error\] \[(QuestionPush|TerminalNoticePush|TurnFailedPush|DismissPush)\]/.test(line),
  );
const policy = (over: Partial<PushConfig> = {}): PushConfig => ({
  signalingUrl: server.url.origin,
  legacyEnabled: true,
  pushSecret: 'owned-secret',
  authorityDirectory: directory,
  ...over,
});
const dispatcher = (config: PushConfig) =>
  new NotificationDispatcher(
    {
      sessionRegistry: registry,
      deviceTokens,
      pushConfig: () => config,
      getPrimarySessionId: () => null,
      pruneToken: (token) => pruned.push(token),
    },
    SID,
  );

describe('legacy classification follows what the real sender throws', () => {
  test('a 429 from the receiver is retried with backoff, then the push succeeds', async () => {
    statuses.push({ status: 429, body: '{"error":"RATE_LIMITED"}' });
    expect(await dispatcher(policy()).maybePush(SID, question)).toBe('pushed');
    expect(requests).toHaveLength(2);
    expect(pruned).toEqual([]);
  });

  test('a transient 502 without tokenInvalid is retried up to the cap, then fails without pruning', async () => {
    for (let i = 0; i < 3; i++)
      statuses.push({
        status: 502,
        body: '{"success":false,"error":"APNS_REJECTED","tokenInvalid":false}',
      });
    expect(await dispatcher(policy()).maybePush(SID, question)).toBe('failed');
    expect(requests).toHaveLength(3);
    expect(pruned).toEqual([]);
  });

  test('a 502 with tokenInvalid true is not retried and prunes the dead token', async () => {
    statuses.push({
      status: 502,
      body: '{"success":false,"error":"APNS_REJECTED","tokenInvalid":true}',
    });
    expect(await dispatcher(policy()).maybePush(SID, question)).toBe('failed');
    expect(requests).toHaveLength(1);
    expect(pruned).toEqual([TOKEN]);
  });

  test('a 401 is neither retried nor pruned', async () => {
    statuses.push({ status: 401, body: '{"error":"UNAUTHORIZED"}' });
    expect(await dispatcher(policy()).maybePush(SID, question)).toBe('failed');
    expect(requests).toHaveLength(1);
    expect(pruned).toEqual([]);
  });

  test('a dismissal that meets a 429 is retried too', async () => {
    statuses.push({ status: 429, body: '{}' });
    dispatcher(policy()).dismiss(SID, QID);
    const start = Date.now();
    while (requests.length < 2 && Date.now() - start < 3000) await Bun.sleep(10);
    expect(requests).toHaveLength(2);
  });

  test('diagnostics never carry the receiver body or the token', async () => {
    statuses.push({ status: 401, body: `PRIVATE_RESPONSE_SENTINEL ${TOKEN}` });
    await dispatcher(policy()).maybePush(SID, question);
    expect(logs.join('\n')).not.toContain('PRIVATE_');
  });
});

describe('a disabled legacy channel is no channel', () => {
  test('explicit legacy_push_enabled = false with old tokens: no_channel, no request, no error log', async () => {
    const d = dispatcher(policy({ legacyEnabled: false }));
    expect(await d.maybePush(SID, question)).toBe('no_channel');
    expect(await d.maybePush(SID, question, { held: true })).toBe('no_channel');
    d.dismiss(SID, QID);
    await Bun.sleep(50);
    expect(requests).toEqual([]);
    expect(pushErrors()).toEqual([]);
  });

  test('legacy enabled but no push secret: no_channel, no error log', async () => {
    const { pushSecret: _omitted, ...withoutSecret } = policy();
    expect(await dispatcher(withoutSecret).maybePush(SID, question)).toBe('no_channel');
    expect(requests).toEqual([]);
    expect(pushErrors()).toEqual([]);
  });

  test('the secure activation latch refuses the sender: no_channel, not an error-level failure', async () => {
    writeFileSync(
      join(directory, 'secure_push_activation.json'),
      JSON.stringify({ version: 1, activated: true }),
      { mode: 0o600 },
    );
    expect(await dispatcher(policy()).maybePush(SID, question)).toBe('no_channel');
    expect(requests).toEqual([]);
    expect(pushErrors()).toEqual([]);
  });
});
