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

function permissionInput(
  overrides: Partial<PermissionRequestHookInput> = {},
): PermissionRequestHookInput {
  return {
    session_id: 'foreign-claude-id',
    transcript_path: '/tmp/does-not-matter.jsonl',
    cwd: '/tmp/some-project',
    permission_mode: 'default',
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    ...overrides,
  };
}

describe('ForeignSessionEscalator (#672)', () => {
  let tmpDir: string;
  let sessionStore: SessionStore;
  let bindingStore: SessionBindingStore;
  let liveSessionsRegistry: SessionRegistryFile;
  let deviceTokens: Map<string, DeviceTokenEntry>;
  let pushCalls: Array<{ token: string; opts: PushTriggerOptions }>;
  let nowMs: number;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-foreign-escalator-'));
    sessionStore = new SessionStore(path.join(tmpDir, 'sessions.json'));
    bindingStore = new SessionBindingStore(sessionStore);
    liveSessionsRegistry = new SessionRegistryFile(path.join(tmpDir, 'live-sessions'));
    fs.mkdirSync(liveSessionsRegistry.dirPath, { recursive: true });
    deviceTokens = new Map();
    pushCalls = [];
    nowMs = 1_000_000;
    configureLogger({ writeLog: () => {} });
  });

  afterEach(() => {
    __resetLoggerForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

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
  });

  // -------------------------------------------------------------------------
  // Ladder step 3: ownership undetermined (a registry/store read failure) ->
  // error-only, no escalation storm.
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
});
