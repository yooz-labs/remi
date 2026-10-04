/**
 * The `turn_failed` push (#1153): a turn ended on an API error, so Claude
 * Code fired `StopFailure` instead of `Stop`.
 *
 * Two layers, both real: the text and collapse key
 * (`notifications/turn-failed.ts`), and `NotificationDispatcher.pushTurnFailed`
 * with a recording `PushFn` as the only double (it replaces the network, and
 * nothing else).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { UUID } from '@remi/shared';
import type { DeviceTokenEntry } from '../../src/cli/handlers/trivial-events.ts';
import { __resetLoggerForTests, configureLogger } from '../../src/cli/logger.ts';
import type { StopFailureHookInput } from '../../src/hooks/hook-types.ts';
import {
  NotificationDispatcher,
  type PushFn,
} from '../../src/notifications/notification-dispatcher.ts';
import {
  buildTurnFailedText,
  createTurnFailedRoutes,
  describeTurnFailure,
  turnFailedCollapseId,
} from '../../src/notifications/turn-failed.ts';
import { shouldNotifyTurnComplete } from '../../src/notifications/turn-timer.ts';
import type { PTYSession } from '../../src/pty/pty-session.ts';
import { SessionRegistry } from '../../src/session/session-registry.ts';

const SID = 's0000000-0000-0000-0000-000000000000' as UUID;
const OTHER_SID = 's1111111-1111-1111-1111-111111111111' as UUID;
const CID = 'c0000000-0000-0000-0000-000000000000' as UUID;

/** Every `error` value the hooks docs list for `StopFailure`
 *  (code.claude.com/docs/en/hooks), with the phrase it must read as. */
const DOCUMENTED_CODES: ReadonlyArray<readonly [string, string]> = [
  ['rate_limit', 'Rate or usage limit reached'],
  ['overloaded', 'API overloaded'],
  ['authentication_failed', 'Authentication failed'],
  ['oauth_org_not_allowed', 'Organization not allowed to sign in'],
  ['account_on_hold', 'Account on hold'],
  ['billing_error', 'Billing error'],
  ['invalid_request', 'Invalid request'],
  ['model_not_found', 'Model not found'],
  ['server_error', 'Server error'],
  ['max_output_tokens', 'Output token limit reached'],
  ['cloud_credential_error', 'Cloud credentials could not be loaded'],
  ['unknown', 'Unknown error'],
];

/** The real capture from #905 (all 3 real `StopFailure` events looked like this). */
const CAPTURED_500 = {
  error: 'server_error',
  last_assistant_message:
    'API Error: 500 Internal server error. This is a server-side issue, usually temporary — try again in a moment. If it persists, check https://status.claude.com.',
};

/** Codex's string `codexErrorInfo` values (the generated schema's `CodexErrorInfo`) with a reason, and what each reads as (#1180). */
const CODEX_CODES: ReadonlyArray<readonly [string, string]> = [
  ['usageLimitExceeded', 'Usage limit reached'],
  ['rateLimitExceeded', 'Rate limit reached'],
  ['serverOverloaded', 'API overloaded'],
  ['internalServerError', 'Server error'],
  ['unauthorized', 'Authentication failed'],
  ['badRequest', 'Invalid request'],
  ['contextWindowExceeded', 'Context window exceeded'],
  ['sessionBudgetExceeded', 'Session budget exceeded'],
  ['sandboxError', 'Sandbox error'],
  ['other', 'Unknown error'],
];

describe('describeTurnFailure: Codex codes (#1180)', () => {
  test.each(CODEX_CODES)('%s reads as "%s", as a Claude code does', (code, phrase) => {
    expect(describeTurnFailure(code)).toBe(phrase);
  });

  test('a Codex code with no phrase is shown as is, like any unknown code', () => {
    for (const code of ['cyberPolicy', 'tooManyDenials', 'flexUnavailable']) {
      expect(describeTurnFailure(code)).toBe(code);
    }
  });

  test('the phrases Claude Code has are the ones it always had', () => {
    for (const [code, phrase] of DOCUMENTED_CODES) expect(describeTurnFailure(code)).toBe(phrase);
  });
});

describe('describeTurnFailure', () => {
  test.each(DOCUMENTED_CODES)('%s reads as "%s"', (code, phrase) => {
    expect(describeTurnFailure(code)).toBe(phrase);
  });

  test('an unknown code is shown as is', () => {
    expect(describeTurnFailure('some_new_code')).toBe('some_new_code');
  });

  test('an unknown code is one line and bounded', () => {
    const shown = describeTurnFailure(`bad\ncode ${'x'.repeat(200)}`);
    expect(shown).not.toContain('\n');
    expect(shown.length).toBeLessThanOrEqual(41);
    expect(shown.endsWith('…')).toBe(true);
  });

  test('a code that names an Object prototype member is not mistaken for a known one', () => {
    for (const code of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(describeTurnFailure(code)).toBe(code);
    }
  });

  test('a missing, empty, blank or non-string code reads as Unknown error, never undefined or null', () => {
    for (const bad of [undefined, null, '', '   ', 0, 42, false, {}, [], ['rate_limit']]) {
      const shown = describeTurnFailure(bad);
      expect(shown).toBe('Unknown error');
      expect(shown).not.toMatch(/undefined|null/);
    }
  });
});

describe('buildTurnFailedText', () => {
  test('the title names the session and says Claude stopped', () => {
    expect(buildTurnFailedText('remi', { error: 'rate_limit' }).title).toBe('remi: Claude stopped');
  });

  test('a blank session name falls back to Agent, a long one is capped', () => {
    expect(buildTurnFailedText('  ', { error: 'rate_limit' }).title).toBe('Agent: Claude stopped');
    expect(buildTurnFailedText('s'.repeat(300), { error: 'rate_limit' }).title.length).toBe(120);
  });

  test('a known code reads as a sentence-case phrase, then the excerpt', () => {
    const { body } = buildTurnFailedText('remi', {
      error: 'rate_limit',
      last_assistant_message: "You've hit your session limit · resets 3:50am",
    });
    expect(body).toBe("Rate or usage limit reached. You've hit your session limit · resets 3:50am");
  });

  test('the #905 capture: server_error with its 500 message, excerpt truncated at about 140 characters', () => {
    const { title, body } = buildTurnFailedText('remi', CAPTURED_500);
    expect(title).toBe('remi: Claude stopped');
    expect(body.startsWith('Server error. API Error: 500 Internal server error.')).toBe(true);
    expect(body.endsWith('…')).toBe(true);
    const excerpt = body.slice('Server error. '.length);
    // 140 characters of the message plus the ellipsis.
    expect(excerpt.length).toBe(141);
    expect(CAPTURED_500.last_assistant_message.startsWith(excerpt.slice(0, 140))).toBe(true);
    expect(body.length).toBeLessThanOrEqual(200);
  });

  test('a short message is not truncated and gets no ellipsis', () => {
    const { body } = buildTurnFailedText('remi', {
      error: 'authentication_failed',
      last_assistant_message: 'Please run /login',
    });
    expect(body).toBe('Authentication failed. Please run /login');
  });

  test('an unknown code is shown as is, case and all', () => {
    const { body } = buildTurnFailedText('remi', {
      error: 'quota_exhausted',
      last_assistant_message: 'try later',
    });
    expect(body).toBe('quota_exhausted. try later');
  });

  test('with no last_assistant_message, a string error_details is the excerpt', () => {
    const { body } = buildTurnFailedText('remi', {
      error: 'invalid_request',
      error_details: 'messages.3: tool_use ids must be unique',
    });
    expect(body).toBe('Invalid request. messages.3: tool_use ids must be unique');
  });

  test('last_assistant_message wins over error_details when both are strings', () => {
    const { body } = buildTurnFailedText('remi', {
      error: 'server_error',
      error_details: 'details text',
      last_assistant_message: 'message text',
    });
    expect(body).toBe('Server error. message text');
  });

  test('a blank last_assistant_message falls through to error_details', () => {
    const { body } = buildTurnFailedText('remi', {
      error: 'server_error',
      error_details: 'details text',
      last_assistant_message: '   \n ',
    });
    expect(body).toBe('Server error. details text');
  });

  test('a structured error_details is not printed: no [object Object], no JSON', () => {
    const { body } = buildTurnFailedText('remi', {
      error: 'overloaded',
      error_details: { status: 529, type: 'overloaded_error' },
    });
    expect(body).toBe('API overloaded');
  });

  test('missing fields: no error, no message, no details reads as Unknown error, never undefined or null', () => {
    const { title, body } = buildTurnFailedText('remi', {});
    expect(title).toBe('remi: Claude stopped');
    expect(body).toBe('Unknown error');
    for (const text of [title, body]) expect(text).not.toMatch(/undefined|null/);
  });

  test('null-ish wire values read the same as absent ones', () => {
    const { body } = buildTurnFailedText('remi', {
      error: null,
      error_details: null,
      last_assistant_message: null,
    } as unknown as Parameters<typeof buildTurnFailedText>[1]);
    expect(body).toBe('Unknown error');
  });

  test('newlines and runs of whitespace in the message collapse to single spaces', () => {
    const { body } = buildTurnFailedText('remi', {
      error: 'server_error',
      last_assistant_message: 'API Error:\n\n  500   boom',
    });
    expect(body).toBe('Server error. API Error: 500 boom');
  });

  test('a subagent failure names the agent type first', () => {
    const { body } = buildTurnFailedText('remi', {
      error: 'rate_limit',
      agent_type: 'code-reviewer',
    });
    expect(body).toBe('code-reviewer · Rate or usage limit reached');
  });

  test('the agent is Claude unless the caller names another: Codex reads as Codex stopped (#1180)', () => {
    expect(buildTurnFailedText('remi', { error: 'rate_limit' }, 'Codex').title).toBe(
      'remi: Codex stopped',
    );
    expect(buildTurnFailedText('remi', { error: 'rate_limit' }, 'Claude').title).toBe(
      'remi: Claude stopped',
    );
    expect(buildTurnFailedText('remi', { error: 'rate_limit' }).title).toBe('remi: Claude stopped');
  });

  test('the agent name is one line, never empty, and the title stays capped (#1180)', () => {
    expect(buildTurnFailedText('remi', {}, 'Co\ndex').title).toBe('remi: Co dex stopped');
    expect(buildTurnFailedText('remi', {}, '  ').title).toBe('remi: Agent stopped');
    expect(buildTurnFailedText('remi', {}, 'a'.repeat(300)).title.length).toBe(120);
  });

  test('the agent name changes the title and nothing else (#1180)', () => {
    const claude = buildTurnFailedText('remi', CAPTURED_500);
    const codex = buildTurnFailedText('remi', CAPTURED_500, 'Codex');
    expect(codex.body).toBe(claude.body);
    expect(codex.title).not.toBe(claude.title);
  });

  test('the body never exceeds the 200-character cap, whatever the inputs', () => {
    const { body } = buildTurnFailedText('remi', {
      error: 'e'.repeat(500),
      agent_type: 'a'.repeat(500),
      last_assistant_message: 'm'.repeat(500),
    });
    expect(body.length).toBeLessThanOrEqual(200);
  });
});

describe('turnFailedCollapseId', () => {
  test('is one stable key per session, distinct across sessions', () => {
    expect(turnFailedCollapseId(SID)).toBe(turnFailedCollapseId(SID));
    expect(turnFailedCollapseId(SID)).not.toBe(turnFailedCollapseId(OTHER_SID));
  });

  test('never equals a session id or a card id, and fits APNS 64 bytes for a UUID', () => {
    const uuid = '0f6c8a52-9d7e-4b1a-8c3d-2e5f7a9b1c4d';
    expect(turnFailedCollapseId(uuid)).not.toBe(uuid);
    expect(turnFailedCollapseId(uuid).startsWith('turn-failed-')).toBe(true);
    expect(turnFailedCollapseId(uuid).length).toBeLessThanOrEqual(64);
  });
});

describe('NotificationDispatcher.pushTurnFailed', () => {
  let registry: SessionRegistry;
  let deviceTokens: Map<string, DeviceTokenEntry>;
  let sent: Array<{ token: string; opts: Record<string, unknown> }>;
  let failFor: Set<string>;
  let refreshes: number;

  const pushFn: PushFn = async (_url, token, opts) => {
    if (failFor.has(token)) throw new Error('BadDeviceToken');
    sent.push({ token, opts: opts as unknown as Record<string, unknown> });
  };

  function device(
    token: string,
    turnFailed?: boolean,
    over: { questions?: boolean; turnComplete?: boolean } = {},
  ): DeviceTokenEntry {
    return {
      token,
      platform: 'ios',
      registeredAt: 1,
      connectionId: CID,
      ...(turnFailed !== undefined && {
        pushPrefs: {
          questions: over.questions ?? true,
          turnComplete: over.turnComplete ?? true,
          harnessDenied: true,
          turnFailed,
        },
      }),
    };
  }

  function make(): NotificationDispatcher {
    return new NotificationDispatcher(
      {
        sessionRegistry: registry,
        deviceTokens,
        pushConfig: () => ({ signalingUrl: 'ws://x', pushSecret: 'secret' }),
        refreshDeviceTokens: () => {
          refreshes += 1;
        },
        getPrimarySessionId: () => null,
        pushFn,
      },
      SID,
    );
  }

  function register(attach: boolean): void {
    registry.registerSession(
      SID,
      '/d',
      {
        id: 'pty',
        write: () => {},
        submitInput: async () => {},
        close: async () => {},
      } as unknown as PTYSession,
      { handleMessage: () => {}, handleQuestion: () => {}, handleStatusChange: () => {} } as never,
    );
    if (attach) registry.attachConnection(SID, CID);
  }

  beforeEach(() => {
    registry = new SessionRegistry({ orphanTimeoutMs: 60000 });
    deviceTokens = new Map();
    sent = [];
    failFor = new Set();
    refreshes = 0;
    configureLogger({ writeLog: () => {} });
  });

  afterEach(async () => {
    __resetLoggerForTests();
    await registry.shutdown();
  });

  test('pushes one informational notification of kind turn_failed to each device', async () => {
    register(false);
    deviceTokens.set('a', device('a'));
    deviceTokens.set('b', device('b'));
    const sessionName = registry.getSession(SID)?.name ?? '';
    expect(sessionName).not.toBe('');

    const outcome = await make().pushTurnFailed({ error: 'rate_limit' });

    expect(outcome).toBe('pushed');
    expect(sent.map((p) => p.token).sort()).toEqual(['a', 'b']);
    for (const { opts } of sent) {
      expect(opts['kind']).toBe('turn_failed');
      expect(opts['title']).toBe(`${sessionName}: Claude stopped`);
      expect(opts['body']).toBe('Rate or usage limit reached');
      expect(opts['pushSecret']).toBe('secret');
      expect(opts['sessionId']).toBe(SID);
      // Informational: nothing to answer, nothing to dismiss as a card.
      expect(opts['category']).toBeUndefined();
      expect(opts['options']).toBeUndefined();
      expect(opts['dynOptions']).toBeUndefined();
      expect(opts['dismiss']).toBeUndefined();
    }
  });

  test('the agent the caller names is the one the notification says stopped (#1180)', async () => {
    register(false);
    deviceTokens.set('a', device('a'));
    const sessionName = registry.getSession(SID)?.name ?? '';

    await make().pushTurnFailed({ error: 'rate_limit' }, 'Codex');
    await make().pushTurnFailed({ error: 'rate_limit' });

    expect(sent.map((p) => p.opts['title'])).toEqual([
      `${sessionName}: Codex stopped`,
      `${sessionName}: Claude stopped`,
    ]);
  });

  test('the collapse key is the session-scoped key, never a card id, and is the same on a repeat', async () => {
    register(false);
    deviceTokens.set('a', device('a'));
    const dispatcher = make();

    await dispatcher.pushTurnFailed({ error: 'rate_limit' });
    await dispatcher.pushTurnFailed({ error: 'rate_limit' });

    expect(sent).toHaveLength(2);
    expect(sent[0]?.opts['questionId']).toBe(turnFailedCollapseId(SID));
    expect(sent[1]?.opts['questionId']).toBe(turnFailedCollapseId(SID));
  });

  test('a repeat is not deduped: the second failed turn is pushed (and replaces the first via the collapse key)', async () => {
    register(false);
    deviceTokens.set('a', device('a'));
    const dispatcher = make();

    expect(await dispatcher.pushTurnFailed({ error: 'rate_limit' })).toBe('pushed');
    expect(await dispatcher.pushTurnFailed({ error: 'rate_limit' })).toBe('pushed');
    expect(sent).toHaveLength(2);
  });

  test('a device that muted turnFailed gets nothing; the others still do', async () => {
    register(false);
    deviceTokens.set('muted', device('muted', false));
    deviceTokens.set('wants', device('wants', true));

    const outcome = await make().pushTurnFailed({ error: 'rate_limit' });

    expect(sent.map((p) => p.token)).toEqual(['wants']);
    expect(outcome).toBe('pushed');
  });

  test('every device muted reports no_channel, not pushed', async () => {
    register(false);
    deviceTokens.set('a', device('a', false));
    deviceTokens.set('b', device('b', false));

    const outcome = await make().pushTurnFailed({ error: 'rate_limit' });

    expect(sent).toEqual([]);
    expect(outcome).toBe('no_channel');
  });

  test('no device registered reports no_channel', async () => {
    register(false);
    expect(await make().pushTurnFailed({ error: 'rate_limit' })).toBe('no_channel');
    expect(sent).toEqual([]);
  });

  test('a legacy entry with no stored preferences receives it', async () => {
    register(false);
    deviceTokens.set('legacy', device('legacy'));

    expect(await make().pushTurnFailed({ error: 'rate_limit' })).toBe('pushed');
    expect(sent.map((p) => p.token)).toEqual(['legacy']);
  });

  test('muting questions or turnComplete does not mute it: turnFailed is its own preference', async () => {
    register(false);
    deviceTokens.set('quiet', device('quiet', true, { questions: false, turnComplete: false }));

    expect(await make().pushTurnFailed({ error: 'rate_limit' })).toBe('pushed');
    expect(sent.map((p) => p.token)).toEqual(['quiet']);
  });

  test('the machine-wide turn_complete gate refuses while pushTurnFailed still pushes: the two paths share no gate', async () => {
    // The machine-wide switch is read by `shouldNotifyTurnComplete`
    // (cli.ts `onTurnStop`); `pushTurnFailed` takes no config at all. Same
    // devices, same moment: the "done" gate refuses and the failure still
    // goes out. (That the cli.ts wiring adds no config check of its own is
    // `createTurnFailedRoutes`'s contract, tested below: it takes no config.)
    register(false);
    deviceTokens.set('a', device('a'));

    const turnComplete = shouldNotifyTurnComplete({
      onTurnComplete: false,
      stopHookActive: false,
      elapsedMs: 10 * 60_000,
      minSeconds: 60,
      lastAssistantMessage: 'All done',
      hasDeviceTokens: true,
    });
    const outcome = await make().pushTurnFailed({ error: 'rate_limit' });

    expect(turnComplete).toBe(false);
    expect(outcome).toBe('pushed');
    expect(sent).toHaveLength(1);
  });

  test('is sent even with a client attached: the app shows no card for a failure', async () => {
    register(true);
    deviceTokens.set('a', device('a'));

    expect(await make().pushTurnFailed({ error: 'rate_limit' })).toBe('pushed');
    expect(sent).toHaveLength(1);
  });

  test('refreshes the device tokens before deciding who to push (#690)', async () => {
    register(false);
    deviceTokens.set('a', device('a'));

    await make().pushTurnFailed({ error: 'rate_limit' });

    expect(refreshes).toBe(1);
  });

  test('reports failed when every push fails, and never rejects', async () => {
    register(false);
    deviceTokens.set('a', device('a'));
    failFor.add('a');

    expect(await make().pushTurnFailed({ error: 'rate_limit' })).toBe('failed');
    expect(sent).toEqual([]);
  });

  test('reports pushed when at least one device accepted it', async () => {
    register(false);
    deviceTokens.set('bad', device('bad'));
    deviceTokens.set('good', device('good'));
    failFor.add('bad');

    expect(await make().pushTurnFailed({ error: 'rate_limit' })).toBe('pushed');
    expect(sent.map((p) => p.token)).toEqual(['good']);
  });

  test('a session the registry no longer has is called Agent', async () => {
    deviceTokens.set('a', device('a'));

    await make().pushTurnFailed({ error: 'rate_limit' });

    expect(sent[0]?.opts['title']).toBe('Agent: Claude stopped');
  });

  describe('dismissTurnFailed (#1153)', () => {
    const flush = () => new Promise((resolve) => setTimeout(resolve, 5));
    const dismissals = () => sent.filter((p) => p.opts['kind'] === 'dismiss');

    test('sends nothing when no turn_failed push is outstanding', async () => {
      register(false);
      deviceTokens.set('a', device('a'));

      make().dismissTurnFailed();
      await flush();

      expect(sent).toEqual([]);
    });

    test('clears an outstanding notice with a quiet dismiss on the same collapse key, to every device', async () => {
      register(false);
      deviceTokens.set('wants', device('wants'));
      deviceTokens.set('muted', device('muted', false));
      const dispatcher = make();
      await dispatcher.pushTurnFailed({ error: 'rate_limit' });

      dispatcher.dismissTurnFailed();
      await flush();

      // Never filtered by preferences: the muted device may hold an older notice.
      expect(
        dismissals()
          .map((p) => p.token)
          .sort(),
      ).toEqual(['muted', 'wants']);
      for (const { opts } of dismissals()) {
        expect(opts['questionId']).toBe(turnFailedCollapseId(SID));
        expect(opts['dismiss']).toBe(true);
        expect(opts['title']).toBeUndefined();
        expect(opts['body']).toBeUndefined();
      }
    });

    test('clears once per failure, and a later failure re-arms it', async () => {
      register(false);
      deviceTokens.set('a', device('a'));
      const dispatcher = make();

      await dispatcher.pushTurnFailed({ error: 'rate_limit' });
      dispatcher.dismissTurnFailed();
      dispatcher.dismissTurnFailed();
      await flush();
      expect(dismissals()).toHaveLength(1);

      await dispatcher.pushTurnFailed({ error: 'rate_limit' });
      dispatcher.dismissTurnFailed();
      await flush();
      expect(dismissals()).toHaveLength(2);
    });

    test('a failure no device wanted leaves nothing outstanding', async () => {
      register(false);
      deviceTokens.set('muted', device('muted', false));
      const dispatcher = make();

      expect(await dispatcher.pushTurnFailed({ error: 'rate_limit' })).toBe('no_channel');
      dispatcher.dismissTurnFailed();
      await flush();

      expect(sent).toEqual([]);
    });
  });

  describe('createTurnFailedRoutes (the cli.ts wiring, #1153)', () => {
    const flush = () => new Promise((resolve) => setTimeout(resolve, 5));
    const failure = (): StopFailureHookInput => ({
      session_id: 'claude-A',
      transcript_path: '/tmp/claude-A.jsonl',
      cwd: '/tmp/project',
      permission_mode: 'default',
      hook_event_name: 'StopFailure',
      error: 'rate_limit',
    });

    function dispatcherFor(sessionId: UUID): NotificationDispatcher {
      return new NotificationDispatcher(
        {
          sessionRegistry: registry,
          deviceTokens,
          pushConfig: () => ({ signalingUrl: 'ws://x' }),
          getPrimarySessionId: () => null,
          pushFn,
        },
        sessionId,
      );
    }

    test("routes a failure to that session's dispatcher only, under that session's collapse key", async () => {
      deviceTokens.set('a', device('a'));
      const routes = createTurnFailedRoutes(
        new Map([
          [SID, dispatcherFor(SID)],
          [OTHER_SID, dispatcherFor(OTHER_SID)],
        ]),
      );

      routes.push(OTHER_SID, failure());
      await flush();

      expect(sent).toHaveLength(1);
      expect(sent[0]?.opts['kind']).toBe('turn_failed');
      expect(sent[0]?.opts['questionId']).toBe(turnFailedCollapseId(OTHER_SID));
    });

    test("routes a dismissal to that session's dispatcher, and only when its failure is outstanding", async () => {
      deviceTokens.set('a', device('a'));
      const routes = createTurnFailedRoutes(
        new Map([
          [SID, dispatcherFor(SID)],
          [OTHER_SID, dispatcherFor(OTHER_SID)],
        ]),
      );

      routes.push(SID, failure());
      await flush();
      routes.dismiss(OTHER_SID); // its own failure is not outstanding
      await flush();
      expect(sent.filter((p) => p.opts['kind'] === 'dismiss')).toEqual([]);

      routes.dismiss(SID);
      await flush();
      const cleared = sent.filter((p) => p.opts['kind'] === 'dismiss');
      expect(cleared.map((p) => p.opts['questionId'])).toEqual([turnFailedCollapseId(SID)]);
    });

    test("passes the agent's name through to the notification (#1180)", async () => {
      deviceTokens.set('a', device('a'));
      const routes = createTurnFailedRoutes(new Map([[SID, dispatcherFor(SID)]]));

      routes.push(SID, failure(), 'Codex');
      await flush();

      expect(sent).toHaveLength(1);
      expect(String(sent[0]?.opts['title']).endsWith(': Codex stopped')).toBe(true);
    });

    test('a session with no dispatcher is a no-op, not a throw', async () => {
      deviceTokens.set('a', device('a'));
      const routes = createTurnFailedRoutes(new Map());

      expect(() => routes.push(SID, failure())).not.toThrow();
      expect(() => routes.dismiss(SID)).not.toThrow();
      await flush();
      expect(sent).toEqual([]);
    });

    test('looks the dispatcher up when called, so a session added later is reached', async () => {
      deviceTokens.set('a', device('a'));
      const notifiers = new Map<UUID, NotificationDispatcher>();
      const routes = createTurnFailedRoutes(notifiers);

      routes.push(SID, failure());
      await flush();
      expect(sent).toEqual([]);

      notifiers.set(SID, dispatcherFor(SID));
      routes.push(SID, failure());
      await flush();
      expect(sent).toHaveLength(1);
    });
  });
});
