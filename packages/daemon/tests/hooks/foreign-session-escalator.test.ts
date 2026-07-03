import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { UUID } from '@remi/shared';
import type { DeviceTokenEntry } from '../../src/cli/handlers/trivial-events.ts';
import { __resetLoggerForTests, configureLogger } from '../../src/cli/logger.ts';
import {
  ForeignSessionEscalator,
  type ForeignSessionEscalatorDeps,
} from '../../src/hooks/foreign-session-escalator.ts';
import type { PermissionRequestHookInput } from '../../src/hooks/hook-types.ts';
import type { PushTriggerOptions } from '../../src/notifications/push-client.ts';
import { SessionBindingStore } from '../../src/session/session-binding-store.ts';
import { SessionRegistryFile } from '../../src/session/session-registry-file.ts';
import { SessionStore } from '../../src/session/session-store.ts';

/**
 * No-mock unit tests for ForeignSessionEscalator (#672). Real SessionStore /
 * SessionBindingStore / SessionRegistryFile on tmp files; a fake push
 * transport capturing calls instead of hitting the network.
 */

const OUR_SESSION_ID = 'aaaaaaaa-0000-0000-0000-000000000001' as UUID;

describe('ForeignSessionEscalator (#672)', () => {
  let tmpDir: string;
  let sessionStore: SessionStore;
  let bindingStore: SessionBindingStore;
  let liveSessionsRegistry: SessionRegistryFile;
  let deviceTokens: Map<string, DeviceTokenEntry>;
  let pushCalls: Array<{ token: string; opts: PushTriggerOptions }>;
  let nowMs: number;
  /** A real, unmarked, well-aged (60s old) transcript file -- the default
   *  transcript_path for `permissionInput()`, so "unclaimed" tests exercise
   *  a genuinely markerless, settled file rather than a nonexistent path
   *  (which would always classify as 'undetermined' -- see the dedicated
   *  "marker-not-yet-provable" describe block below). */
  let staleUnmarkedPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-foreign-escalator-'));
    sessionStore = new SessionStore(path.join(tmpDir, 'sessions.json'));
    bindingStore = new SessionBindingStore(sessionStore);
    liveSessionsRegistry = new SessionRegistryFile(path.join(tmpDir, 'live-sessions'));
    fs.mkdirSync(liveSessionsRegistry.dirPath, { recursive: true });
    deviceTokens = new Map();
    pushCalls = [];
    nowMs = 1_000_000;
    staleUnmarkedPath = writeUnmarkedTranscript('stale-unmarked.jsonl', 60_000);
    configureLogger({ writeLog: () => {} });
  });

  afterEach(() => {
    __resetLoggerForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function permissionInput(
    overrides: Partial<PermissionRequestHookInput> = {},
  ): PermissionRequestHookInput {
    return {
      session_id: 'foreign-claude-id',
      transcript_path: staleUnmarkedPath,
      cwd: '/tmp/some-project',
      permission_mode: 'default',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      ...overrides,
    };
  }

  function deps(overrides: Partial<ForeignSessionEscalatorDeps> = {}): ForeignSessionEscalatorDeps {
    return {
      liveSessionsRegistry,
      bindingStore,
      deviceTokens,
      pushConfig: () => ({ signalingUrl: 'https://example.test' }),
      currentPort: () => 8765,
      pushFn: async (_signalingUrl, token, opts) => {
        pushCalls.push({ token, opts });
      },
      now: () => nowMs,
      ...overrides,
    };
  }

  function registerToken(token = 'device-token-1'): void {
    deviceTokens.set(token, {
      token,
      platform: 'ios',
      registeredAt: Date.now(),
      connectionId: 'conn-1' as UUID,
    });
  }

  /** Wait a tick so the fire-and-forget push promise inside handleUnadmitted
   *  has a chance to settle before assertions run. */
  async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  function writeMarkedTranscript(name: string, port: number): string {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(
      p,
      `${JSON.stringify({ type: 'custom-title', customTitle: `remi:${port}`, sessionId: 's' })}\n`,
    );
    return p;
  }

  /** A transcript with NO remi:<port> marker, backdated by `ageMs` (0 = just
   *  written / "fresh"). Used to exercise the marker-unreadable tie-breaker:
   *  a fresh markerless file is 'undetermined' (still possibly flushing); a
   *  stale one is genuinely 'unclaimed'. */
  function writeUnmarkedTranscript(name: string, ageMs = 0): string {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, `${JSON.stringify({ type: 'user', message: 'hi' })}\n`);
    if (ageMs > 0) {
      const backdated = new Date(Date.now() - ageMs);
      fs.utimesSync(p, backdated, backdated);
    }
    return p;
  }

  // -------------------------------------------------------------------------
  // Ladder step 1: sibling live daemon claims it -> silent.
  // -------------------------------------------------------------------------

  describe('sibling claim -> silent, no push', () => {
    test('claimed via the durable binding store reverse lookup + a live registry entry', async () => {
      registerToken();
      bindingStore.preAssign({
        remiSessionId: 'sibling-remi-session' as UUID,
        claudeSessionId: 'foreign-claude-id',
        projectPath: tmpDir,
        port: 9999,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        exitedAt: null,
        exitCode: null,
      });
      liveSessionsRegistry.register({
        sessionId: 'sibling-remi-session',
        pid: process.pid,
        wsPort: 9999,
        hookPort: 10099,
        projectPath: tmpDir,
        name: 'sibling',
        startedAt: new Date().toISOString(),
      });

      const escalator = new ForeignSessionEscalator(deps());
      escalator.handleUnadmitted(
        permissionInput({ session_id: 'foreign-claude-id' }),
        OUR_SESSION_ID,
      );
      await flush();

      expect(pushCalls).toHaveLength(0);
    });

    test('claimed via the transcript port marker naming a live sibling wsPort', async () => {
      registerToken();
      liveSessionsRegistry.register({
        sessionId: 'sibling-remi-session',
        pid: process.pid,
        wsPort: 9999,
        hookPort: 10099,
        projectPath: tmpDir,
        name: 'sibling',
        startedAt: new Date().toISOString(),
      });
      const markedPath = writeMarkedTranscript('sibling.jsonl', 9999);

      const escalator = new ForeignSessionEscalator(deps());
      escalator.handleUnadmitted(
        permissionInput({ session_id: 'unrelated-claude-id', transcript_path: markedPath }),
        OUR_SESSION_ID,
      );
      await flush();

      expect(pushCalls).toHaveLength(0);
    });

    test('a binding-store record for a DEAD remi session is NOT treated as a live sibling claim', async () => {
      registerToken();
      bindingStore.preAssign({
        remiSessionId: 'dead-remi-session' as UUID,
        claudeSessionId: 'foreign-claude-id',
        projectPath: tmpDir,
        port: 9999,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        exitedAt: null,
        exitCode: null,
      });
      // No liveSessionsRegistry entry for 'dead-remi-session' at all -> not live.

      const escalator = new ForeignSessionEscalator(deps());
      escalator.handleUnadmitted(
        permissionInput({ session_id: 'foreign-claude-id' }),
        OUR_SESSION_ID,
      );
      await flush();

      // Unclaimed by any LIVE daemon -> escalates (pushes), not silent.
      expect(pushCalls).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Ladder step 2: unclaimed -> informational, dismiss-only push.
  // -------------------------------------------------------------------------

  describe('unclaimed -> rate-limited informational push', () => {
    test('pushes a title/body with tool name + short session hash + cwd hint, no category/options/questionId', async () => {
      registerToken();
      const escalator = new ForeignSessionEscalator(deps());
      escalator.handleUnadmitted(
        permissionInput({
          session_id: 'foreign-claude-id',
          tool_name: 'Bash',
          cwd: '/Users/dev/my-project',
        }),
        OUR_SESSION_ID,
      );
      await flush();

      expect(pushCalls).toHaveLength(1);
      const { opts } = pushCalls[0]!;
      expect(opts.title).toContain('foreign-'); // short hash of the session id
      expect(opts.body).toContain('Bash');
      expect(opts.body).toContain('my-project');
      expect(opts.category).toBeUndefined();
      expect(opts.options).toBeUndefined();
      expect(opts.questionId).toBeUndefined();
      expect(opts.sessionId).toBe(OUR_SESSION_ID);
    });

    test('no device tokens registered -> no push attempted, no throw', async () => {
      const escalator = new ForeignSessionEscalator(deps());
      expect(() => escalator.handleUnadmitted(permissionInput(), OUR_SESSION_ID)).not.toThrow();
      await flush();
      expect(pushCalls).toHaveLength(0);
    });

    test('rate-limits repeated escalations for the SAME foreign session_id', async () => {
      registerToken();
      const escalator = new ForeignSessionEscalator(deps({ rateLimitMs: 60_000 }));
      const input = permissionInput({ session_id: 'busy-foreign-session' });

      escalator.handleUnadmitted(input, OUR_SESSION_ID);
      await flush();
      escalator.handleUnadmitted(input, OUR_SESSION_ID);
      await flush();
      escalator.handleUnadmitted(input, OUR_SESSION_ID);
      await flush();

      expect(pushCalls).toHaveLength(1);

      // Advance the clock past the rate-limit window -> escalates again.
      nowMs += 60_001;
      escalator.handleUnadmitted(input, OUR_SESSION_ID);
      await flush();
      expect(pushCalls).toHaveLength(2);
    });

    test('rate-limit is keyed per foreign session_id, not global', async () => {
      registerToken();
      const escalator = new ForeignSessionEscalator(deps({ rateLimitMs: 60_000 }));

      escalator.handleUnadmitted(permissionInput({ session_id: 'foreign-A' }), OUR_SESSION_ID);
      await flush();
      escalator.handleUnadmitted(permissionInput({ session_id: 'foreign-B' }), OUR_SESSION_ID);
      await flush();

      expect(pushCalls).toHaveLength(2);
    });

    test('rate-limit map evicts the oldest entries once the tracked-session cap is exceeded', async () => {
      // Small cap via a dedicated escalator would require exposing the
      // constant; instead exercise the REAL 500-cap end-to-end with a burst
      // of distinct session ids, then confirm the oldest was evicted (a
      // repeat of it re-escalates instead of staying rate-limited).
      registerToken();
      const escalator = new ForeignSessionEscalator(deps({ rateLimitMs: 10 * 60_000 }));
      const firstId = 'burst-session-0000';
      escalator.handleUnadmitted(permissionInput({ session_id: firstId }), OUR_SESSION_ID);
      await flush();
      expect(pushCalls).toHaveLength(1);

      for (let i = 1; i <= 500; i++) {
        nowMs += 1;
        escalator.handleUnadmitted(
          permissionInput({ session_id: `burst-session-${i}` }),
          OUR_SESSION_ID,
        );
      }
      await flush();

      // The very first id should have been evicted by the size cap (not by
      // age -- rateLimitMs is 10 minutes and only ~500ms have elapsed), so
      // it is no longer tracked and escalates again immediately: 1 (firstId)
      // + 500 (burst, all unique) + 1 (firstId re-fired after eviction).
      nowMs += 1;
      escalator.handleUnadmitted(permissionInput({ session_id: firstId }), OUR_SESSION_ID);
      await flush();
      expect(pushCalls).toHaveLength(502);
    });
  });

  // -------------------------------------------------------------------------
  // Ladder step 3a: registry/store read failure -> undetermined, error-only.
  // -------------------------------------------------------------------------

  describe('undetermined ownership (registry read error) -> no escalation', () => {
    test('a sessions.json read failure logs and returns without pushing', async () => {
      registerToken();
      // Make sessions.json a DIRECTORY so SessionStore.read()'s fs.readFileSync
      // throws a real (non-ENOENT, non-SyntaxError) I/O error, exercising the
      // genuine failure path rather than a mock.
      const brokenSessionsPath = path.join(tmpDir, 'broken-sessions.json');
      fs.mkdirSync(brokenSessionsPath);
      const brokenStore = new SessionBindingStore(new SessionStore(brokenSessionsPath));

      const escalator = new ForeignSessionEscalator(deps({ bindingStore: brokenStore }));
      expect(() => escalator.handleUnadmitted(permissionInput(), OUR_SESSION_ID)).not.toThrow();
      await flush();

      expect(pushCalls).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Ladder step 3b (#672 review, critical 2): marker-not-yet-provable ->
  // undetermined, NOT unclaimed. Regression coverage for the rotation-race
  // false "unbound session" push about the user's OWN session.
  // -------------------------------------------------------------------------

  describe('undetermined ownership (marker not yet provable) -> no false-alarm push', () => {
    test('a FRESH markerless transcript (possibly mid-flush) does NOT escalate', async () => {
      registerToken();
      // No sibling registered at all -- this is exactly the rotation-race
      // shape: our own SessionStart just fired, the marker has not flushed
      // yet, and there happens to be a sibling in the directory (irrelevant
      // to classifyOwnership itself, which only sees the hook input).
      const freshPath = writeUnmarkedTranscript('fresh-unmarked.jsonl', 0);
      const escalator = new ForeignSessionEscalator(deps({ markerSettleMs: 10_000 }));

      escalator.handleUnadmitted(
        permissionInput({ session_id: 'our-own-rotating-session', transcript_path: freshPath }),
        OUR_SESSION_ID,
      );
      await flush();

      expect(pushCalls).toHaveLength(0);
    });

    test('a markerless transcript older than the settle window DOES escalate (genuinely foreign)', async () => {
      registerToken();
      const stalePath = writeUnmarkedTranscript('old-unmarked.jsonl', 20_000);
      const escalator = new ForeignSessionEscalator(deps({ markerSettleMs: 10_000 }));

      escalator.handleUnadmitted(
        permissionInput({ session_id: 'genuinely-foreign-session', transcript_path: stalePath }),
        OUR_SESSION_ID,
      );
      await flush();

      expect(pushCalls).toHaveLength(1);
    });

    test('a missing transcript file is treated as undetermined, not unclaimed', async () => {
      registerToken();
      const escalator = new ForeignSessionEscalator(deps({ markerSettleMs: 10_000 }));

      escalator.handleUnadmitted(
        permissionInput({
          session_id: 'session-with-vanished-transcript',
          transcript_path: path.join(tmpDir, 'does-not-exist.jsonl'),
        }),
        OUR_SESSION_ID,
      );
      await flush();

      expect(pushCalls).toHaveLength(0);
    });
  });
});
