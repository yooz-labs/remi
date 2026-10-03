/**
 * The Claude launch feeds its PTY output to its own `OutputProcessor`
 * (#1176 item 5).
 *
 * `createPtySessionForSession` takes a neutral `outputSink`, and
 * `createClaudeSession` must hand it the session's `OutputProcessor`. Nothing
 * else pinned that, so a launch that passed a no-op sink (the Codex one) would
 * have run Claude with no PTY parsing at all and passed every other test. This
 * starts a real PTY running a fake `claude` that prints the tool-output error
 * line Claude Code prints when its login lapses, a line `streamStatusOnly`
 * still lets through, and waits for the resulting message to reach the
 * session's message API.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { UUID } from '@remi/shared';
import { generateId } from '@remi/shared';
import { SubagentViewRegistry } from '../../src/api/subagent-view-registry.ts';
import { SubagentAlerter } from '../../src/auto-approve/index.ts';
import { __resetLoggerForTests, configureLogger } from '../../src/cli/logger.ts';
import { createMessageApiForSession } from '../../src/cli/session-phases/message-api-setup.ts';
import { __resetWrapperStateForTests } from '../../src/cli/wrapper-state.ts';
import { ClaudeHarness } from '../../src/harness/index.ts';
import { ForeignSessionEscalator } from '../../src/hooks/index.ts';
import { SessionBindingStore } from '../../src/session/session-binding-store.ts';
import { SessionRegistryFile } from '../../src/session/session-registry-file.ts';
import { SessionRegistry } from '../../src/session/session-registry.ts';
import { SessionStore } from '../../src/session/session-store.ts';
import { TranscriptDiscovery } from '../../src/transcript/index.ts';

const FAKE_CLAUDE = `#!/bin/sh
printf '  \\342\\216\\277 OAuth token revoked \\302\\267 Please run /login\\n'
i=0
while [ $i -lt 30 ]; do
  sleep 0.1
  i=$((i + 1))
done
`;

describe('the Claude launch feeds PTY output to its OutputProcessor (#1176)', () => {
  let tmpDir: string;
  let sessionRegistry: SessionRegistry;
  let savedPath: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-claude-pty-output-'));
    sessionRegistry = new SessionRegistry({ orphanTimeoutMs: 60000 });
    savedPath = process.env['PATH'];
    configureLogger({ writeLog: () => {} });
  });

  afterEach(async () => {
    if (savedPath === undefined) Reflect.deleteProperty(process.env, 'PATH');
    else process.env['PATH'] = savedPath;
    __resetWrapperStateForTests();
    __resetLoggerForTests();
    await sessionRegistry.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('a tool-output error line printed by claude reaches the session message API', async () => {
    const fakeBin = path.join(tmpDir, 'fake-bin');
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, 'claude'), FAKE_CLAUDE);
    fs.chmodSync(path.join(fakeBin, 'claude'), 0o755);
    // Only the fake and the system directories: a test never starts a real `claude`.
    process.env['PATH'] = `${fakeBin}:/usr/bin:/bin`;

    const sessionStore = new SessionStore(path.join(tmpDir, 'sessions.json'));
    const liveSessionsRegistry = new SessionRegistryFile(path.join(tmpDir, 'live-sessions'));
    fs.mkdirSync(liveSessionsRegistry.dirPath, { recursive: true });
    const harness = new ClaudeHarness(
      new TranscriptDiscovery({ projectsDir: path.join(tmpDir, 'projects') }),
      {
        sessionRegistry,
        sessionStore,
        bindingStore: new SessionBindingStore(sessionStore),
        liveSessionsRegistry,
        transcriptDiscovery: new TranscriptDiscovery({ projectsDir: path.join(tmpDir, 'p') }),
        transcriptWatchers: new Map(),
        transcriptFallbackTimers: new Map(),
        subagentViews: new SubagentViewRegistry(),
        foreignSessionEscalator: new ForeignSessionEscalator({
          liveSessionsRegistry,
          bindingStore: new SessionBindingStore(sessionStore),
          deviceTokens: new Map(),
          pushConfig: () => ({ signalingUrl: 'http://127.0.0.1:1' }),
          currentPort: () => 0,
        }),
        subagentAlerts: { alerter: new SubagentAlerter([]), deliver: () => {} },
        onQuestionResolved: () => {},
        onHarnessDenied: () => {},
        pushTurnFailed: () => {},
        dismissTurnFailed: () => {},
        prompts: () => ({ hold_seconds: 90, daemon_hold_seconds: 3540 }),
        hookServer: () => null,
        currentPort: () => 0,
        wsPort: () => 19999,
        // Never resolves: the PTY's exit handler can never reach process.exit.
        cleanup: () => new Promise<void>(() => {}),
        observeLocalPtyOutput: () => {},
        sessionNotifiers: new Map(),
      },
    );

    const sessionId: UUID = generateId();
    const { messageApi, sendAndRecord } = createMessageApiForSession(
      {
        sessionRegistry,
        transcriptWatchers: new Map(),
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
      passThrough: false,
      reservedRows: 0,
      messageApi,
      sendAndRecord,
      sendMessage: () => {},
    });
    sessionRegistry.registerSession(sessionId, tmpDir, session.pty, messageApi, false, false);
    try {
      await session.start();
      const deadline = Date.now() + 5000;
      const seen = () =>
        messageApi.getAllMessages().some((m) => JSON.stringify(m).includes('OAuth token revoked'));
      while (!seen() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(seen()).toBe(true);
    } finally {
      session.pty.signal('SIGKILL');
      session.dispose();
    }
  });
});
