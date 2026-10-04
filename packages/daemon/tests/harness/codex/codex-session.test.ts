/**
 * `CodexHarness` and `createCodexSession` (epic #1175, phase 3 #1177), built the
 * way the daemon builds them: a real harness over a real `SessionStore`,
 * `SessionBindingStore`, `SessionRegistry` and `MessageAPI`, the real
 * `AppServerClient` and `ThreadTracker` against the `FakeAppServer`, and (for the
 * cases that start the session) a real PTY running a fake `codex` found on a
 * PATH of fakes plus `/usr/bin:/bin`. The `cleanup` never resolves, so the PTY's
 * exit handler can never reach `process.exit` in the test runner. The
 * black-box launch is pinned by `integration/codex-launch-characterization.test.ts`.
 *
 * These pin what that test cannot easily see: the order of the state-changing
 * steps, the status the session reports from several threads, the claimed-id
 * rule against the real store, and the link watchdog.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentStatus, Message, UUID } from '@remi/shared';
import { MessageAPI } from '../../../src/api/message-api.ts';
import {
  type CodexLaunchDeps,
  CodexLaunchRefusal,
  checkCodexLaunch,
  codexLaunchRefusal,
  codexResumeCommand,
  legacyWriterRefusal,
  olderRemiNotice,
} from '../../../src/harness/codex/codex-session.ts';
import { CodexHarness } from '../../../src/harness/codex/codex.ts';
import type { HarnessSession } from '../../../src/harness/types.ts';
import { IDENTITY_SHIM_MIN_VERSION } from '../../../src/session/legacy-writers.ts';
import type { LegacyWriter } from '../../../src/session/legacy-writers.ts';
import { SessionBindingStore } from '../../../src/session/session-binding-store.ts';
import { SessionRegistryFile } from '../../../src/session/session-registry-file.ts';
import { SessionRegistry } from '../../../src/session/session-registry.ts';
import {
  AmbiguousSessionIdentityError,
  SessionStore,
  type StoredSession,
} from '../../../src/session/session-store.ts';
import { threadStartedFrame, threadStatusFrame } from '../../helpers/codex-threads.ts';
import { FakeAppServer } from '../../helpers/fake-app-server.ts';

const FAKE_CODEX = `#!/bin/sh
d="$FAKE_CODEX_DIR"
for a in "$@"; do printf '%s\\n' "$a"; done > "$d/argv"
stty size > "$d/size"
i=0
while [ ! -e "$d/release" ] && [ $i -lt 100 ]; do
  sleep 0.1
  i=$((i + 1))
done
`;

const nowSec = (): number => Math.floor(Date.now() / 1000);

/** Cases that start PTYs and wait out windows or watchdogs. */
const THREAD_FOR_AMBIGUITY = '00000000-0000-7000-8000-0000000000dd';
const slow = (name: string, fn: () => Promise<void>) => test(name, fn, 30000);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(cond: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(15);
  }
}

describe('CodexHarness', () => {
  let tmpDir: string;
  let workDir: string;
  let fakeDir: string;
  let sessionStore: SessionStore;
  let bindingStore: SessionBindingStore;
  let registries: SessionRegistry[];
  let launched: HarnessSession[];
  let servers: FakeAppServer[];
  let logs: string[];
  let legacy: LegacyWriter[];
  let originalPath: string | undefined;

  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remi-codex-session-')));
    workDir = path.join(tmpDir, 'work');
    fakeDir = path.join(tmpDir, 'fake');
    fs.mkdirSync(workDir);
    fs.mkdirSync(path.join(tmpDir, 'bin'));
    fs.mkdirSync(fakeDir);
    fs.writeFileSync(path.join(tmpDir, 'bin', 'codex'), FAKE_CODEX);
    fs.chmodSync(path.join(tmpDir, 'bin', 'codex'), 0o755);
    // No real `codex` can resolve: the PATH is the fake plus the system directories.
    originalPath = process.env['PATH'];
    process.env['PATH'] = `${path.join(tmpDir, 'bin')}:/usr/bin:/bin`;
    process.env['FAKE_CODEX_DIR'] = fakeDir;
    sessionStore = new SessionStore(path.join(tmpDir, 'sessions.json'));
    bindingStore = new SessionBindingStore(sessionStore);
    registries = [];
    launched = [];
    servers = [];
    logs = [];
    legacy = [];
  });

  afterEach(async () => {
    for (const session of launched) {
      if (session.pty.isRunning) session.pty.signal('SIGKILL');
      session.dispose();
    }
    for (const server of servers) await server.stop();
    for (const registry of registries) await registry.shutdown();
    process.env['PATH'] = originalPath ?? '/usr/bin:/bin';
    Reflect.deleteProperty(process.env, 'FAKE_CODEX_DIR');
    // The PTY's exit handler writes `sessions.json` and the live-sessions file under `tmpDir`
    // (it runs synchronously once `isRunning` turns false), so the child must be gone before the
    // directory is removed, or the late write recreates it and it is never cleaned up.
    await until(
      () => launched.every((session) => !session.pty.isRunning),
      'the fake codex children to exit',
      10000,
    );
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function startServer(): FakeAppServer {
    const server = FakeAppServer.start();
    servers.push(server);
    return server;
  }

  function buildDeps(
    server: FakeAppServer | null,
    over: Partial<CodexLaunchDeps> = {},
  ): CodexLaunchDeps {
    const sessionRegistry = new SessionRegistry({ orphanTimeoutMs: 60000 });
    registries.push(sessionRegistry);
    const liveSessionsRegistry = new SessionRegistryFile(path.join(tmpDir, 'live-sessions'));
    fs.mkdirSync(liveSessionsRegistry.dirPath, { recursive: true });
    return {
      sessionRegistry,
      sessionStore,
      bindingStore,
      liveSessionsRegistry,
      currentPort: () => 19999,
      wsPort: () => 19999,
      cleanup: () => new Promise<void>(() => {}),
      env: () => ({ CODEX_HOME: server ? server.codexHome : path.join(tmpDir, 'no-codex-home') }),
      legacyWriters: () => legacy,
      remiVersion: 'test',
      onQuestionResolved: () => {},
      log: (m) => logs.push(m),
      appServer: { backoff: { initialMs: 10, maxMs: 40 } },
      ...over,
    };
  }

  /** Build (not start) a Codex session the way `createNewSession` asks the harness for one. */
  function create(
    deps: CodexLaunchDeps,
    args: string[] = [],
    passThrough = false,
    directory = workDir,
  ) {
    const sessionId = crypto.randomUUID() as UUID;
    const messages: Message[] = [];
    const statuses: AgentStatus[] = [];
    const messageApi = new MessageAPI(
      { sessionId, initialBulletId: 1, maxBulletLength: 500 },
      {
        onStructuredMessage: (m) => messages.push(m),
        onStatusChange: (s) => statuses.push(s),
      },
    );
    const session = new CodexHarness(deps).createSession({
      sessionId,
      workingDirectory: directory,
      extraArgs: args,
      passThrough,
      reservedRows: 5,
      messageApi,
      sendAndRecord: () => {},
      sendMessage: () => {},
    });
    launched.push(session);
    return { session, sessionId, messages, statuses };
  }

  const record = (over: Partial<StoredSession>): StoredSession => ({
    remiSessionId: crypto.randomUUID() as UUID,
    claudeSessionId: null,
    harness: 'codex',
    harnessSessionId: null,
    projectPath: workDir,
    port: 19998,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    exitedAt: null,
    exitCode: null,
    ...over,
  });

  const legacyWriter = (over: Partial<LegacyWriter> = {}): LegacyWriter => ({
    source: 'live-session',
    pid: 4242,
    version: '0.7.15',
    file: '/state/live-sessions/abc.json',
    pidIdentity: 'verified',
    ...over,
  });

  describe('the launch order', () => {
    test('a launch records a codex session with no Claude id and no thread yet, and a resume names its thread', () => {
      const deps = buildDeps(null);
      const fresh = create(deps);
      const threadId = crypto.randomUUID();
      const resumed = create(deps, ['resume', threadId]);

      expect(bindingStore.getIdentity(fresh.sessionId)).toEqual({
        harness: 'codex',
        harnessSessionId: null,
      });
      expect(sessionStore.findByRemiSessionId(fresh.sessionId)?.claudeSessionId).toBeNull();
      expect(bindingStore.getIdentity(resumed.sessionId)).toEqual({
        harness: 'codex',
        harnessSessionId: threadId,
      });
      expect(sessionStore.findByRemiSessionId(fresh.sessionId)?.projectPath).toBe(workDir);
      expect(sessionStore.findByRemiSessionId(fresh.sessionId)?.pid).toBe(process.pid);
    });

    test('a refused argument exits 2 and writes nothing', () => {
      let error: unknown;
      try {
        create(buildDeps(null), ['-c', 'model=x']);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(CodexLaunchRefusal);
      expect((error as CodexLaunchRefusal).exitCode).toBe(2);
      expect((error as Error).message).toContain('-c');
      expect(fs.existsSync(path.join(tmpDir, 'sessions.json'))).toBe(false);
    });

    test('an older live remi refuses with exit 1 before any record is written, naming the file, the version and the fix', () => {
      legacy = [
        legacyWriter(),
        legacyWriter({
          source: 'hub',
          pid: 77,
          version: undefined,
          file: '/state/daemon-status.json',
          pidIdentity: 'unverified',
        }),
      ];
      let error: unknown;
      try {
        create(buildDeps(null));
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(CodexLaunchRefusal);
      expect((error as CodexLaunchRefusal).exitCode).toBe(1);
      const message = (error as Error).message;
      expect(message).toContain('/state/live-sessions/abc.json');
      expect(message).toContain('pid 4242');
      expect(message).toContain('version 0.7.15');
      expect(message).toContain('/state/daemon-status.json');
      expect(message).toContain('no version recorded');
      expect(message).toContain('remi stop --all');
      expect(message).toContain(IDENTITY_SHIM_MIN_VERSION);
      // What the fix costs and how a version is read (W17d, decision D7).
      expect(message).toContain('also ends interactive remi sessions');
      expect(message).toContain('does not parse');
      expect(message).toContain('PR-stamped');
      expect(message).toContain('counts as older');
      expect(fs.existsSync(path.join(tmpDir, 'sessions.json'))).toBe(false);
    });

    test('a verified writer reads as live, an unverified one says to delete its file', () => {
      const verified = legacyWriterRefusal([legacyWriter()]);
      expect(verified).not.toContain('unverified');
      expect(verified).not.toContain('delete');
      const unverified = legacyWriterRefusal([legacyWriter({ pidIdentity: 'unverified' })]);
      expect(unverified).toContain('unverified');
      expect(unverified).toContain('delete /state/live-sessions/abc.json');
    });

    test('the gate comes before the store is touched: a refused launch leaves a stale record unpurged', () => {
      sessionStore.save(
        record({ pid: 2_147_483_000, harnessSessionId: '00000000-0000-7000-8000-0000000000aa' }),
      );
      const before = fs.readFileSync(path.join(tmpDir, 'sessions.json'), 'utf8');
      legacy = [legacyWriter()];
      const checked = checkCodexLaunch(
        buildDeps(null),
        ['resume', '00000000-0000-7000-8000-0000000000aa'],
        workDir,
      );
      expect(checked.ok).toBe(false);
      expect(fs.readFileSync(path.join(tmpDir, 'sessions.json'), 'utf8')).toBe(before);
    });

    test('a working directory that does not exist is refused by the check, before any record (W7)', () => {
      const checked = checkCodexLaunch(buildDeps(null), [], path.join(tmpDir, 'gone'));
      expect(checked.ok).toBe(false);
      if (!checked.ok) {
        expect(checked.exitCode).toBe(1);
        expect(checked.message).toContain('does not exist');
      }
      expect(fs.existsSync(path.join(tmpDir, 'sessions.json'))).toBe(false);
    });

    test('an argument refusal still comes first, with exit 2, whatever the directory (W7)', () => {
      const checked = checkCodexLaunch(buildDeps(null), ['--bogus'], path.join(tmpDir, 'gone'));
      expect(checked.ok).toBe(false);
      if (!checked.ok) expect(checked.exitCode).toBe(2);
    });

    test('two sessions racing for one thread: the loser is a refusal with exit 1, not a crash (W7)', () => {
      // A real store that lets a competing session record the thread between the preflight's
      // read and this session's own write: the window a race lives in.
      const THREAD = '00000000-0000-7000-8000-0000000000cc';
      class RacingStore extends SessionStore {
        raced = false;
        override list(): StoredSession[] {
          const rows = super.list();
          if (!this.raced) {
            this.raced = true;
            this.save(record({ harnessSessionId: THREAD }));
          }
          return rows;
        }
      }
      const racing = new RacingStore(path.join(tmpDir, 'sessions.json'));
      const deps = buildDeps(null, {
        sessionStore: racing,
        bindingStore: new SessionBindingStore(racing),
      });
      let error: unknown;
      let created: ReturnType<typeof create> | undefined;
      try {
        created = create(deps, ['resume', THREAD]);
      } catch (e) {
        error = e;
      }
      expect(created).toBeUndefined();
      expect(error).toBeInstanceOf(CodexLaunchRefusal);
      expect((error as CodexLaunchRefusal).exitCode).toBe(1);
      expect((error as Error).message).toContain('Ambiguous');
      // Only the winner's record is left active.
      expect(racing.list().filter((s) => s.exitedAt === null)).toHaveLength(1);
    });

    test('codexLaunchRefusal reads the errors a launch may end in, and nothing else (W7)', () => {
      expect(codexLaunchRefusal(new CodexLaunchRefusal('no', 2))).toEqual({
        message: 'no',
        exitCode: 2,
      });
      const ambiguous = new AmbiguousSessionIdentityError('codex', THREAD_FOR_AMBIGUITY, 2);
      expect(codexLaunchRefusal(ambiguous)).toEqual({ message: ambiguous.message, exitCode: 1 });
      expect(codexLaunchRefusal(new Error('boom'))).toBeNull();
      expect(codexLaunchRefusal('text')).toBeNull();
    });

    test('the resume command changes into the directory first, quoting it as one shell word (W20)', () => {
      const id = '00000000-0000-7000-8000-0000000000ee';
      expect(codexResumeCommand('/work/project', id)).toBe(
        `cd /work/project && remi codex resume ${id}`,
      );
      const quoted: Array<[string, string]> = [
        ['/work/my project', "'/work/my project'"],
        ["/work/it's", "'/work/it'\\''s'"],
        ['/work/$HOME', "'/work/$HOME'"],
        ['/work/`id`', "'/work/`id`'"],
        ['/work/a;b', "'/work/a;b'"],
        ['/work/a\nb', "'/work/a\nb'"],
        ['', "''"],
      ];
      for (const [dir, word] of quoted) {
        expect(codexResumeCommand(dir, id), JSON.stringify(dir)).toBe(
          `cd ${word} && remi codex resume ${id}`,
        );
      }
    });

    test('a thread id that is not one word is quoted in the command line too (R3)', () => {
      expect(codexResumeCommand('/work', 'x; touch /tmp/pwned')).toBe(
        "cd /work && remi codex resume 'x; touch /tmp/pwned'",
      );
      expect(codexResumeCommand('/work', "it's")).toBe("cd /work && remi codex resume 'it'\\''s'");
    });

    test('the notice for the user names the minimum version and what is lost', () => {
      expect(olderRemiNotice()).toContain(IDENTITY_SHIM_MIN_VERSION);
      expect(olderRemiNotice()).toContain('erases');
    });
  });

  describe('resume', () => {
    const THREAD = '00000000-0000-7000-8000-0000000000bb';

    test('a thread already open in a live remi session is refused, naming that session', () => {
      const open = record({ harnessSessionId: THREAD });
      sessionStore.save(open);
      const checked = checkCodexLaunch(buildDeps(null), ['resume', THREAD], workDir);
      expect(checked.ok).toBe(false);
      if (!checked.ok) {
        expect(checked.exitCode).toBe(1);
        expect(checked.message).toContain(open.remiSessionId.slice(0, 8));
        expect(checked.message).toContain('remi attach');
      }
    });

    test('a thread with several exited records and no active one resumes (W3)', () => {
      // Two exited rows for one thread, as two earlier resumes leave. A lookup that treats
      // them as an ambiguity would refuse every later resume until the 7-day purge.
      for (const hoursAgo of [3, 2]) {
        sessionStore.save(
          record({
            harnessSessionId: THREAD,
            pid: null,
            startedAt: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
            exitedAt: new Date(Date.now() - (hoursAgo - 0.5) * 3_600_000).toISOString(),
            exitCode: 0,
          }),
        );
      }
      expect(checkCodexLaunch(buildDeps(null), ['resume', THREAD], workDir)).toEqual({
        ok: true,
        args: ['resume', THREAD],
        resumeThreadId: THREAD,
        directory: workDir,
      });
    });

    test('exited history beside one active holder still refuses, naming the holder (W3)', () => {
      sessionStore.save(
        record({ harnessSessionId: THREAD, pid: null, exitedAt: new Date().toISOString() }),
      );
      const open = record({ harnessSessionId: THREAD });
      sessionStore.save(open);
      const checked = checkCodexLaunch(buildDeps(null), ['resume', THREAD], workDir);
      expect(checked.ok).toBe(false);
      if (!checked.ok) expect(checked.message).toContain(open.remiSessionId.slice(0, 8));
    });

    test('an exited record of the thread is history, not a holder', () => {
      sessionStore.save(
        record({
          harnessSessionId: THREAD,
          pid: null,
          exitedAt: new Date().toISOString(),
          exitCode: 0,
        }),
      );
      const checked = checkCodexLaunch(buildDeps(null), ['resume', THREAD], workDir);
      expect(checked).toEqual({
        ok: true,
        args: ['resume', THREAD],
        resumeThreadId: THREAD,
        directory: workDir,
      });
    });

    test('a record whose process died without exiting cleanly is purged first, so the resume goes ahead', () => {
      // Saved as running, pid long dead: only a purge turns it into history.
      sessionStore.save(record({ harnessSessionId: THREAD, pid: 2_147_483_000 }));
      const created = create(buildDeps(null), ['resume', THREAD]);
      expect(bindingStore.getIdentity(created.sessionId)).toEqual({
        harness: 'codex',
        harnessSessionId: THREAD,
      });
      const holders = sessionStore
        .list()
        .filter((s) => s.harnessSessionId === THREAD && s.exitedAt === null);
      expect(holders.map((s) => s.remiSessionId)).toEqual([created.sessionId]);
    });

    test('a fresh launch has no resume check and a prompt goes after an inserted --', () => {
      expect(checkCodexLaunch(buildDeps(null), ['fix', 'it'], workDir)).toEqual({
        ok: true,
        args: ['--', 'fix', 'it'],
        resumeThreadId: null,
        directory: workDir,
      });
    });
  });

  describe('the child', () => {
    test('spawns codex --no-alt-screen with the validated arguments after it', async () => {
      const a = create(buildDeps(startServer()), ['-m', 'some-model']);
      await a.session.start();
      await until(() => fs.existsSync(path.join(fakeDir, 'argv')), 'the fake codex');
      expect(fs.readFileSync(path.join(fakeDir, 'argv'), 'utf8')).toBe(
        '--no-alt-screen\n-m\nsome-model\n',
      );
    });

    test('a wrapper session gets the whole terminal: Codex reserves no status row', async () => {
      // A terminal of a size nothing else would give, so the default 120x40 cannot pass for it.
      const original = {
        rows: Object.getOwnPropertyDescriptor(process.stdout, 'rows'),
        columns: Object.getOwnPropertyDescriptor(process.stdout, 'columns'),
      };
      Object.defineProperty(process.stdout, 'rows', {
        value: 33,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(process.stdout, 'columns', {
        value: 77,
        configurable: true,
        writable: true,
      });
      try {
        // The shell asks for a reserved row (5 here); the Codex launch never takes one.
        const a = create(buildDeps(startServer()), [], true);
        await a.session.start();
        await until(
          () =>
            fs.existsSync(path.join(fakeDir, 'size')) &&
            fs.readFileSync(path.join(fakeDir, 'size'), 'utf8').trim() !== '',
          'the terminal size',
        );
        expect(fs.readFileSync(path.join(fakeDir, 'size'), 'utf8').trim()).toBe('33 77');
      } finally {
        for (const key of ['rows', 'columns'] as const) {
          const descriptor = original[key];
          if (descriptor) Object.defineProperty(process.stdout, key, descriptor);
          else Reflect.deleteProperty(process.stdout, key);
        }
      }
    });

    test('a prompt is passed after --, and a resume as the subcommand last', async () => {
      const a = create(buildDeps(startServer()), ['--yolo', 'hello', 'there']);
      await a.session.start();
      await until(() => fs.existsSync(path.join(fakeDir, 'argv')), 'the fake codex');
      expect(fs.readFileSync(path.join(fakeDir, 'argv'), 'utf8')).toBe(
        '--no-alt-screen\n--yolo\n--\nhello\nthere\n',
      );
    });

    test('a resumed thread is attached as soon as the link is ready, with no thread/started', async () => {
      const server = startServer();
      const threadId = crypto.randomUUID();
      server.createRollout(threadId);
      const a = create(buildDeps(server), ['resume', threadId]);
      await a.session.start();
      await until(
        () => server.received.some((r) => r.frame['method'] === 'thread/resume'),
        'thread/resume',
      );
      const frame = server.received.find((r) => r.frame['method'] === 'thread/resume');
      expect(frame?.frame['params']).toStrictEqual({ threadId, excludeTurns: true });
    });

    test('a session of nothing held answers nothing and never claims a prompt is up', () => {
      const { session } = create(buildDeps(null));
      expect(session.decisions.hasMainHold()).toBe(false);
      expect(session.decisions.hasOpenHookPrompt()).toBe(false);
      expect(session.decisions.isHeld(crypto.randomUUID() as UUID)).toBe(false);
      expect(session.decisions.forceRelease('test')).toEqual({ resolved: 0 });
      expect(session.decisions.screen).toBeUndefined();
    });
  });

  describe('status from the app-server', () => {
    /** Start a session on a fake app-server and wait for its client and tracker to be up. */
    async function startedSession(args: string[] = [], over: Partial<CodexLaunchDeps> = {}) {
      const server = startServer();
      const created = create(buildDeps(server, over), args);
      await created.session.start();
      await until(
        () =>
          server.clientIds().length === 1 &&
          server
            .framesFrom(server.clientIds()[0] as number)
            .some((f) => f['method'] === 'initialized'),
        'the client handshake',
      );
      return { server, ...created };
    }

    const tui = (id: string) =>
      threadStartedFrame('tui', { id, cwd: workDir, createdAtSec: nowSec() });

    test('the TUI thread is recorded, and the title helper and a stray thread are not', async () => {
      const { server, sessionId } = await startedSession();
      const id = crypto.randomUUID();
      // A user thread of another Codex window, in another directory.
      server.emit(
        threadStartedFrame('tui', { id: crypto.randomUUID(), cwd: tmpDir, createdAtSec: nowSec() }),
        { broadcast: true },
      );
      server.emit(tui(id), { broadcast: true });
      server.emit(
        threadStartedFrame('title', {
          id: crypto.randomUUID(),
          cwd: workDir,
          createdAtSec: nowSec(),
        }),
        { broadcast: true },
      );
      await until(
        () => bindingStore.getIdentity(sessionId)?.harnessSessionId === id,
        'the identity',
      );
      await sleep(500);
      expect(bindingStore.getIdentity(sessionId)).toEqual({
        harness: 'codex',
        harnessSessionId: id,
      });
    });

    test('waiting on approval is waiting, active is thinking, idle is idle, and a repeat reports nothing new', async () => {
      const { server, statuses } = await startedSession();
      const id = crypto.randomUUID();
      server.emit(tui(id), { broadcast: true });
      server.emit(threadStatusFrame(id, { type: 'active', activeFlags: ['waitingOnApproval'] }), {
        broadcast: true,
      });
      await until(() => statuses.at(-1) === 'waiting', 'waiting');
      server.emit(threadStatusFrame(id, { type: 'active', activeFlags: ['waitingOnApproval'] }), {
        broadcast: true,
      });
      server.emit(threadStatusFrame(id, { type: 'active', activeFlags: [] }), { broadcast: true });
      await until(() => statuses.at(-1) === 'thinking', 'thinking');
      server.emit(threadStatusFrame(id, { type: 'idle' }), { broadcast: true });
      await until(() => statuses.at(-1) === 'idle', 'idle');
      server.emit(threadStatusFrame(id, { type: 'systemError' }), { broadcast: true });
      server.emit(threadStatusFrame(id, { type: 'notLoaded' }), { broadcast: true });
      await sleep(300);
      expect(statuses).toEqual(['waiting', 'thinking', 'idle']);
    });

    test('a subagent waiting makes the session wait, and a subagent going idle does not end the main thread work', async () => {
      const { server, statuses } = await startedSession();
      const main = crypto.randomUUID();
      const child = crypto.randomUUID();
      server.emit(tui(main), { broadcast: true });
      server.emit(
        threadStartedFrame('tui', { id: child, cwd: workDir, createdAtSec: nowSec() }, (t) => {
          t['parentThreadId'] = main;
        }),
        { broadcast: true },
      );
      server.emit(threadStatusFrame(main, { type: 'active', activeFlags: [] }), {
        broadcast: true,
      });
      await until(() => statuses.at(-1) === 'thinking', 'thinking');

      server.emit(
        threadStatusFrame(child, { type: 'active', activeFlags: ['waitingOnApproval'] }),
        { broadcast: true },
      );
      await until(() => statuses.at(-1) === 'waiting', 'waiting from the child');
      server.emit(threadStatusFrame(child, { type: 'idle' }), { broadcast: true });
      await until(
        () => statuses.at(-1) === 'thinking',
        'thinking again: the main thread is still active',
      );
      expect(statuses).toEqual(['thinking', 'waiting', 'thinking']);
    });

    test('a subagent that waits keeps the session waiting while the main thread reports active', async () => {
      const { server, statuses, sessionId } = await startedSession();
      const main = crypto.randomUUID();
      const child = crypto.randomUUID();
      server.emit(tui(main), { broadcast: true });
      await until(
        () => bindingStore.getIdentity(sessionId)?.harnessSessionId === main,
        'the identity',
      );
      server.emit(
        threadStartedFrame('tui', { id: child, cwd: workDir, createdAtSec: nowSec() }, (t) => {
          t['parentThreadId'] = main;
        }),
        { broadcast: true },
      );
      // The subagent reports first, the main thread after it: the order must not matter.
      server.emit(
        threadStatusFrame(child, { type: 'active', activeFlags: ['waitingOnApproval'] }),
        { broadcast: true },
      );
      await until(() => statuses.at(-1) === 'waiting', 'waiting from the subagent');
      server.emit(threadStatusFrame(main, { type: 'active', activeFlags: [] }), {
        broadcast: true,
      });
      await sleep(400);
      expect(statuses.at(-1)).toBe('waiting');
    });

    test("a rotation onto a thread that reports no status clears the old subagent's wait at once (W8)", async () => {
      const { server, statuses, sessionId } = await startedSession();
      const first = crypto.randomUUID();
      const child = crypto.randomUUID();
      const second = crypto.randomUUID();
      server.emit(tui(first), { broadcast: true });
      await until(
        () => bindingStore.getIdentity(sessionId)?.harnessSessionId === first,
        'the identity',
      );
      server.emit(
        threadStartedFrame('tui', { id: child, cwd: workDir, createdAtSec: nowSec() }, (t) => {
          t['parentThreadId'] = first;
        }),
        { broadcast: true },
      );
      server.emit(threadStatusFrame(first, { type: 'idle' }), { broadcast: true });
      server.emit(
        threadStatusFrame(child, { type: 'active', activeFlags: ['waitingOnApproval'] }),
        { broadcast: true },
      );
      await until(() => statuses.at(-1) === 'waiting', 'waiting from the subagent');

      // The new thread's frame carries no status, so nothing else would republish.
      server.emit(
        threadStartedFrame('tui', { id: second, cwd: workDir, createdAtSec: nowSec() }, (t) => {
          t['status'] = null;
        }),
        { broadcast: true },
      );
      await until(
        () => bindingStore.getIdentity(sessionId)?.harnessSessionId === second,
        'the rotation',
      );
      await until(() => statuses.at(-1) === 'idle', 'idle once the old wait is forgotten');
    });

    test("a dropped link takes the subagents' statuses with it and keeps the tracked thread's (W8)", async () => {
      // The reconnect is 4 s away, so only the drop itself can be what clears the wait.
      const { server, statuses } = await startedSession([], {
        appServer: { backoff: { initialMs: 4000, maxMs: 4000 } },
      });
      const main = crypto.randomUUID();
      const child = crypto.randomUUID();
      server.emit(tui(main), { broadcast: true });
      server.emit(
        threadStartedFrame('tui', { id: child, cwd: workDir, createdAtSec: nowSec() }, (t) => {
          t['parentThreadId'] = main;
        }),
        { broadcast: true },
      );
      server.emit(threadStatusFrame(main, { type: 'active', activeFlags: [] }), {
        broadcast: true,
      });
      await until(() => statuses.at(-1) === 'thinking', 'thinking');
      server.emit(
        threadStatusFrame(child, { type: 'active', activeFlags: ['waitingOnApproval'] }),
        { broadcast: true },
      );
      await until(() => statuses.at(-1) === 'waiting', 'waiting from the subagent');

      // While the link is down nothing says the subagent is still waiting. The tracked thread's
      // own status stays until the attach after the reconnect reports it again.
      const client = server.clientIds()[0] as number;
      server.dropClient(client);
      await until(() => statuses.at(-1) === 'thinking', 'the subagent wait to be dropped', 2500);
      expect(server.clientIds()).toEqual([]);
    });

    test("a thread that is not the session's changes nothing: the session reports only its own thread's idle", async () => {
      const { server, statuses } = await startedSession();
      const main = crypto.randomUUID();
      server.emit(tui(main), { broadcast: true });
      server.emit(
        threadStatusFrame(crypto.randomUUID(), {
          type: 'active',
          activeFlags: ['waitingOnApproval'],
        }),
        { broadcast: true },
      );
      await sleep(500);
      // The only report is the TUI thread's own `idle`, from its thread/started frame.
      expect(statuses).toEqual(['idle']);
    });

    test("a rotation forgets what the old thread's subagents were doing", async () => {
      const { server, statuses, sessionId } = await startedSession();
      const first = crypto.randomUUID();
      const child = crypto.randomUUID();
      const second = crypto.randomUUID();
      server.emit(tui(first), { broadcast: true });
      server.emit(
        threadStartedFrame('tui', { id: child, cwd: workDir, createdAtSec: nowSec() }, (t) => {
          t['parentThreadId'] = first;
        }),
        { broadcast: true },
      );
      await until(
        () => bindingStore.getIdentity(sessionId)?.harnessSessionId === first,
        'the identity',
      );
      server.emit(threadStatusFrame(first, { type: 'idle' }), { broadcast: true });
      server.emit(
        threadStatusFrame(child, { type: 'active', activeFlags: ['waitingOnApproval'] }),
        { broadcast: true },
      );
      await until(() => statuses.at(-1) === 'waiting', 'waiting from the subagent');

      // `/new`: the old thread is not active, so the new one takes over, and the old subagent's
      // wait does not follow the session there.
      server.emit(tui(second), { broadcast: true });
      await until(
        () => bindingStore.getIdentity(sessionId)?.harnessSessionId === second,
        'the rotation',
      );
      await until(() => statuses.at(-1) === 'idle', 'idle on the new thread');
      server.emit(threadStatusFrame(second, { type: 'active', activeFlags: [] }), {
        broadcast: true,
      });
      await until(() => statuses.at(-1) === 'thinking', 'thinking on the new thread');
    });
  });

  describe('two sessions in one directory (W2)', () => {
    /** Wait until `n` clients have finished their handshake with the fake app-server. */
    const handshakes = (server: FakeAppServer, n: number) =>
      until(
        () =>
          server.clientIds().length === n &&
          server
            .clientIds()
            .every((c) => server.framesFrom(c).some((f) => f['method'] === 'initialized')),
        `${n} client handshake(s)`,
      );
    const startFrame = (id: string, dir = workDir) =>
      threadStartedFrame('tui', { id, cwd: dir, createdAtSec: nowSec() });
    const holder = (sessionId: UUID) => bindingStore.getIdentity(sessionId)?.harnessSessionId;
    const FIRST_BIND_NOTICE =
      'another remi codex session in this directory is starting or has no thread yet; this session did not bind. Restart one of them if this persists.';
    const ROTATION_NOTICE =
      'a new thread appeared; another remi codex session shares this directory; not following it';

    /** A is bound to T1 and idle; B has just started in the same directory with no thread. */
    async function boundAndFresh(windows: { a: number; b: number }) {
      const server = startServer();
      const a = create(buildDeps(server, { tracker: { ambiguityMs: windows.a } }));
      await a.session.start();
      await handshakes(server, 1);
      const t1 = crypto.randomUUID();
      server.emit(startFrame(t1), { broadcast: true });
      await until(() => holder(a.sessionId) === t1, 'A to bind T1');
      server.emit(threadStatusFrame(t1, { type: 'idle' }), { broadcast: true });
      const b = create(buildDeps(server, { tracker: { ambiguityMs: windows.b } }));
      await b.session.start();
      await handshakes(server, 2);
      return { server, a, b, t1 };
    }

    for (const [order, windows] of [
      ['A commits first', { a: 120, b: 600 }],
      ['B commits first', { a: 600, b: 120 }],
    ] as const) {
      slow(
        `${order}: the idle session keeps its thread and the new session takes the new one`,
        async () => {
          const { server, a, b, t1 } = await boundAndFresh(windows);
          const t2 = crypto.randomUUID();
          server.emit(startFrame(t2), { broadcast: true });
          await until(() => holder(b.sessionId) === t2, 'B to bind T2', 8000);
          await sleep(900);
          // The store, which is what every consumer reads, and not only what each tracker thinks.
          expect(holder(a.sessionId)).toBe(t1);
          expect(holder(b.sessionId)).toBe(t2);
          const rows = sessionStore.list().filter((s) => s.exitedAt === null);
          expect(rows.map((s) => [s.remiSessionId, s.harnessSessionId]).sort()).toEqual(
            [
              [a.sessionId, t1],
              [b.sessionId, t2],
            ].sort(),
          );
          expect(logs.some((l) => l.includes('could not record'))).toBe(false);
        },
      );
    }

    slow(
      'two sessions that both wait for a thread bind neither, and each says so once',
      async () => {
        const server = startServer();
        const a = create(buildDeps(server, { tracker: { ambiguityMs: 100 } }));
        const b = create(buildDeps(server, { tracker: { ambiguityMs: 100 } }));
        await a.session.start();
        await b.session.start();
        await handshakes(server, 2);
        server.emit(startFrame(crypto.randomUUID()), { broadcast: true });
        await sleep(900);
        expect(holder(a.sessionId)).toBeNull();
        expect(holder(b.sessionId)).toBeNull();
        for (const s of [a, b]) {
          const notices = s.messages.filter((m) => m.sender === 'system');
          expect(notices.map((m) => m.content)).toEqual([FIRST_BIND_NOTICE]);
        }
      },
    );

    slow(
      '/new in one of two bound idle sessions in a directory is followed by neither: the thread cannot be attributed (R1, E1)',
      async () => {
        const { server, a, b, t1 } = await boundAndFresh({ a: 150, b: 150 });
        const t2 = crypto.randomUUID();
        server.emit(startFrame(t2), { broadcast: true });
        await until(() => holder(b.sessionId) === t2, 'B to bind T2', 8000);
        server.emit(threadStatusFrame(t2, { type: 'idle' }), { broadcast: true });
        await sleep(200);
        const before = JSON.stringify(sessionStore.list());

        // The user types /new in B: Codex announces the new thread to every connection.
        // (A already declined T2 above, when B's first thread appeared, and told its user once.)
        logs.length = 0;
        const t3 = crypto.randomUUID();
        server.emit(startFrame(t3), { broadcast: true });
        await sleep(1200);
        expect(holder(a.sessionId)).toBe(t1);
        expect(holder(b.sessionId)).toBe(t2);
        // The store, which is what every consumer reads, is untouched.
        expect(JSON.stringify(sessionStore.list())).toBe(before);
        expect(logs.some((l) => l.includes('rotated from'))).toBe(false);
        // One log line from each session, and one notice each over the whole run.
        expect(logs.filter((l) => l.includes(ROTATION_NOTICE))).toHaveLength(2);
        for (const s of [a, b]) {
          expect(
            s.messages.filter((m) => m.sender === 'system').map((m) => m.content),
            'one notice each',
          ).toEqual([ROTATION_NOTICE]);
        }
      },
    );

    slow(
      'a sibling that has no thread and started long ago no longer blocks a first bind (R2, E2)',
      async () => {
        const server = startServer();
        // Alive, in this directory, with no thread, but started two minutes ago: its first-thread
        // window is long over, so it is not who the new thread is for.
        sessionStore.save(
          record({
            harnessSessionId: null,
            startedAt: new Date(Date.now() - 120_000).toISOString(),
          }),
        );
        const a = create(buildDeps(server, { tracker: { ambiguityMs: 100 } }));
        await a.session.start();
        await handshakes(server, 1);
        const t1 = crypto.randomUUID();
        server.emit(startFrame(t1), { broadcast: true });
        await until(
          () => holder(a.sessionId) === t1,
          'A to bind T1 despite the old unbound sibling',
        );
        expect(a.messages.filter((m) => m.sender === 'system')).toEqual([]);
      },
    );

    slow(
      'a sibling that has no thread and started a moment ago does block it, and the notice says what to do (R2, E2)',
      async () => {
        const server = startServer();
        sessionStore.save(
          record({
            harnessSessionId: null,
            startedAt: new Date(Date.now() - 50_000).toISOString(),
          }),
        );
        const a = create(buildDeps(server, { tracker: { ambiguityMs: 100 } }));
        await a.session.start();
        await handshakes(server, 1);
        server.emit(startFrame(crypto.randomUUID()), { broadcast: true });
        await sleep(900);
        expect(holder(a.sessionId)).toBeNull();
        expect(a.messages.filter((m) => m.sender === 'system').map((m) => m.content)).toEqual([
          FIRST_BIND_NOTICE,
        ]);
      },
    );

    slow(
      'a sibling whose start time cannot be read counts as young: it fails closed (R2)',
      async () => {
        const server = startServer();
        sessionStore.save(record({ harnessSessionId: null, startedAt: 'not a time' }));
        const a = create(buildDeps(server, { tracker: { ambiguityMs: 100 } }));
        await a.session.start();
        await handshakes(server, 1);
        server.emit(startFrame(crypto.randomUUID()), { broadcast: true });
        await sleep(900);
        expect(holder(a.sessionId)).toBeNull();
      },
    );

    slow(
      'a sibling in another directory, an exited one and a Claude one do not count',
      async () => {
        const server = startServer();
        const otherDir = path.join(tmpDir, 'other');
        fs.mkdirSync(otherDir);
        create(buildDeps(server), [], false, otherDir);
        sessionStore.save(
          record({ harnessSessionId: null, pid: null, exitedAt: new Date().toISOString() }),
        );
        sessionStore.save(record({ harness: undefined, claudeSessionId: crypto.randomUUID() }));
        const a = create(buildDeps(server, { tracker: { ambiguityMs: 100 } }));
        await a.session.start();
        await handshakes(server, 1);
        const t1 = crypto.randomUUID();
        server.emit(startFrame(t1), { broadcast: true });
        await until(() => holder(a.sessionId) === t1, 'A to bind T1 despite them');

        // Nor do they keep an idle session from following a /new (a rotation asks about any
        // sibling, but only one in this directory).
        server.emit(threadStatusFrame(t1, { type: 'idle' }), { broadcast: true });
        await sleep(100);
        const t2 = crypto.randomUUID();
        server.emit(startFrame(t2), { broadcast: true });
        await until(() => holder(a.sessionId) === t2, 'A to rotate onto T2 despite them');
      },
    );

    slow(
      'a plain window opened by hand in the directory while the session is idle rebinds it, and says so',
      async () => {
        // The residual that cannot be told from a /new in the TUI (decision D2): documented, not silent.
        const server = startServer();
        const a = create(buildDeps(server, { tracker: { ambiguityMs: 100 } }));
        await a.session.start();
        await handshakes(server, 1);
        const t1 = crypto.randomUUID();
        const t2 = crypto.randomUUID();
        server.emit(startFrame(t1), { broadcast: true });
        await until(() => holder(a.sessionId) === t1, 'A to bind T1');
        server.emit(threadStatusFrame(t1, { type: 'idle' }), { broadcast: true });
        await sleep(100);
        server.emit(startFrame(t2), { broadcast: true });
        await until(() => holder(a.sessionId) === t2, 'A to rotate onto T2');
        expect(logs).toContain(`[Codex] rotated from ${t1.slice(-8)} to ${t2.slice(-8)}`);
      },
    );
  });

  describe('claimed threads', () => {
    async function startedSession() {
      const server = startServer();
      const created = create(buildDeps(server));
      await created.session.start();
      await until(
        () =>
          server.clientIds().length === 1 &&
          server
            .framesFrom(server.clientIds()[0] as number)
            .some((f) => f['method'] === 'initialized'),
        'the client handshake',
      );
      return { server, ...created };
    }

    test('a thread held by another live remi session is never taken, and a stale holder does not count', async () => {
      const { server, sessionId } = await startedSession();
      const held = crypto.randomUUID();
      const stale = crypto.randomUUID();
      sessionStore.save(record({ harnessSessionId: held }));
      sessionStore.save(record({ harnessSessionId: stale, pid: 2_147_483_000 }));

      server.emit(threadStartedFrame('tui', { id: held, cwd: workDir, createdAtSec: nowSec() }), {
        broadcast: true,
      });
      await sleep(600);
      expect(bindingStore.getIdentity(sessionId)?.harnessSessionId).toBeNull();

      server.emit(threadStartedFrame('tui', { id: stale, cwd: workDir, createdAtSec: nowSec() }), {
        broadcast: true,
      });
      await until(
        () => bindingStore.getIdentity(sessionId)?.harnessSessionId === stale,
        'the stale thread to bind',
      );
    });

    test('a holder the claim check could not see is still refused by the store, and not retried (W2)', async () => {
      // The check reads `deps.sessionStore`; the write goes through the binding store. Another
      // remi process writing between the two is the only way the write can find a holder the
      // check did not, so the check is given a store that sees no one, over the same file.
      class BlindStore extends SessionStore {
        override list(): StoredSession[] {
          return [];
        }
      }
      const server = startServer();
      const created = create(
        buildDeps(server, { sessionStore: new BlindStore(path.join(tmpDir, 'sessions.json')) }),
      );
      await created.session.start();
      await until(() => server.clientIds().length === 1, 'the connection');
      const held = crypto.randomUUID();
      sessionStore.save(record({ harnessSessionId: held, projectPath: tmpDir }));

      const frame = threadStartedFrame('tui', { id: held, cwd: workDir, createdAtSec: nowSec() });
      server.emit(frame, { broadcast: true });
      await until(() => logs.some((l) => l.includes('is claimed by another session')), 'the log');
      expect(bindingStore.getIdentity(created.sessionId)?.harnessSessionId).toBeNull();
      expect(logs.some((l) => l.includes('could not record the thread id'))).toBe(false);

      // The same thread again: it is not tried (and refused) a second time.
      const tries = logs.filter((l) => l.includes('is claimed by another session')).length;
      server.emit(frame, { broadcast: true });
      await sleep(600);
      expect(logs.filter((l) => l.includes('is claimed by another session'))).toHaveLength(tries);
      expect(logs.some((l) => l.includes('could not record the thread id'))).toBe(false);
    });

    test('a store that refuses over a different duplicate is a failed write, not a claim, and the thread binds once it is fixed (R9)', async () => {
      // The store refuses a write while ANY thread has two active holders. That is no reason to
      // call the free thread claimed: it is logged as what it is and the thread stays bindable.
      class BlindStore extends SessionStore {
        override list(): StoredSession[] {
          return [];
        }
      }
      const server = startServer();
      const created = create(
        buildDeps(server, { sessionStore: new BlindStore(path.join(tmpDir, 'sessions.json')) }),
      );
      await created.session.start();
      await until(() => server.clientIds().length === 1, 'the connection');
      const file = path.join(tmpDir, 'sessions.json');
      const rows = JSON.parse(fs.readFileSync(file, 'utf8')) as { sessions: StoredSession[] };
      const other = crypto.randomUUID();
      const withDuplicate = [
        ...rows.sessions,
        record({ harnessSessionId: other, projectPath: tmpDir }),
        record({ harnessSessionId: other, projectPath: tmpDir }),
      ];
      fs.writeFileSync(file, JSON.stringify({ ...rows, sessions: withDuplicate }));

      const free = crypto.randomUUID();
      const frame = threadStartedFrame('tui', { id: free, cwd: workDir, createdAtSec: nowSec() });
      server.emit(frame, { broadcast: true });
      await until(() => logs.some((l) => l.includes('could not record the thread id')), 'the log');
      expect(logs.some((l) => l.includes('is claimed by another session'))).toBe(false);
      expect(logs.some((l) => l.includes(other.slice(-8)))).toBe(true);

      fs.writeFileSync(file, JSON.stringify({ ...rows, sessions: rows.sessions }));
      server.emit(frame, { broadcast: true });
      await until(
        () => bindingStore.getIdentity(created.sessionId)?.harnessSessionId === free,
        'the thread to bind once the store is fixed',
      );
    });

    test('a Claude record, an exited record and a thread this very session holds do not claim', async () => {
      const { server, sessionId } = await startedSession();
      const id = crypto.randomUUID();
      sessionStore.save(record({ harness: undefined, claudeSessionId: id, harnessSessionId: id }));
      sessionStore.save(
        record({
          harnessSessionId: id,
          pid: null,
          exitedAt: new Date().toISOString(),
          exitCode: 0,
        }),
      );
      server.emit(threadStartedFrame('tui', { id, cwd: workDir, createdAtSec: nowSec() }), {
        broadcast: true,
      });
      await until(
        () => bindingStore.getIdentity(sessionId)?.harnessSessionId === id,
        'the thread to bind',
      );
    });
  });

  describe('a session that never learns its thread, by where it runs (G12)', () => {
    const systemTexts = (messages: Message[]) =>
      messages.filter((m) => m.sender === 'system').map((m) => m.content);

    test('with no terminal the notice also names an Update or Trust prompt and remi attach', async () => {
      const server = startServer();
      const { session, sessionId, messages } = create(
        buildDeps(server, { tracker: { noIdentityMs: 150 } }),
        [],
        false,
      );
      await session.start();
      await until(() => systemTexts(messages).length === 1, 'the notice');
      const text = systemTexts(messages)[0] as string;
      expect(text).toStartWith("remi could not find this session's Codex thread");
      expect(text).toContain('Update or Trust prompt');
      expect(text).toContain(`\`remi attach <host>:19999/${sessionId.slice(0, 8)}\``);
    });

    test('a wrapper session, which has the terminal, keeps the plain notice', async () => {
      const server = startServer();
      const { session, messages } = create(
        buildDeps(server, { tracker: { noIdentityMs: 150 } }),
        [],
        true,
      );
      await session.start();
      await until(() => systemTexts(messages).length === 1, 'the notice');
      expect(systemTexts(messages)).toEqual(["remi could not find this session's Codex thread"]);
    });
  });

  describe('the link watchdog', () => {
    const noticeCount = (messages: Message[]) =>
      messages.filter((m) => m.sender === 'system').length;

    test('with no app-server it logs once and sends one system message, and the session carries on', async () => {
      const { session, messages } = create(buildDeps(null, { linkWatchdogMs: 200 }));
      await session.start();
      await until(() => noticeCount(messages) === 1, 'the notice');
      await sleep(500);
      expect(noticeCount(messages)).toBe(1);
      const text = messages.find((m) => m.sender === 'system')?.content ?? '';
      expect(text).toContain('cannot reach the shared Codex app-server');
      expect(text).not.toContain('not private');
      expect(logs.filter((l) => l.includes('not reachable'))).toHaveLength(1);
      expect(session.pty.isRunning).toBe(true);
    });

    test('a session with no terminal points at remi attach, not at a terminal (G12)', async () => {
      const { session, sessionId, messages } = create(
        buildDeps(null, { linkWatchdogMs: 200 }),
        [],
        false,
      );
      await session.start();
      await until(() => noticeCount(messages) === 1, 'the notice');
      const text = messages.find((m) => m.sender === 'system')?.content ?? '';
      expect(text).toContain(`\`remi attach <host>:19999/${sessionId.slice(0, 8)}\``);
      expect(text).not.toContain('in the terminal');
    });

    test('a wrapper session, which has the terminal, keeps saying the session works in it (G12)', async () => {
      const { session, messages } = create(buildDeps(null, { linkWatchdogMs: 200 }), [], true);
      await session.start();
      await until(() => noticeCount(messages) === 1, 'the notice');
      const text = messages.find((m) => m.sender === 'system')?.content ?? '';
      expect(text).toContain('the session still works in the terminal');
      expect(text).not.toContain('remi attach');
    });

    test('an untrusted control directory says the same about where the session is (G12)', async () => {
      const server = startServer();
      fs.chmodSync(path.join(server.codexHome, 'app-server-control'), 0o755);
      const { session, sessionId, messages } = create(
        buildDeps(server, { linkWatchdogMs: 300 }),
        [],
        false,
      );
      await session.start();
      await until(() => noticeCount(messages) === 1, 'the notice');
      const text = messages.find((m) => m.sender === 'system')?.content ?? '';
      expect(text).toContain('its control directory is not private');
      expect(text).toContain(`remi attach <host>:19999/${sessionId.slice(0, 8)}`);
      expect(text).not.toContain('in the terminal');
    });

    test('a control directory open to others is never connected through, and the notice says so (W12, W17b)', async () => {
      // The socket trust check runs inside the client's socketPath(): without it the client
      // connects to a socket anyone on the machine could answer approvals through.
      const server = startServer();
      fs.chmodSync(path.join(server.codexHome, 'app-server-control'), 0o755);
      const { session, messages } = create(buildDeps(server, { linkWatchdogMs: 300 }));
      await session.start();
      await until(() => logs.some((l) => l.includes('open to group or others')), 'the refusal log');
      await until(() => noticeCount(messages) === 1, 'the notice');
      expect(server.clientIds()).toEqual([]);
      const text = messages.find((m) => m.sender === 'system')?.content ?? '';
      expect(text).toContain('its control directory is not private');
      expect(text).not.toContain('cannot reach');
      expect(session.pty.isRunning).toBe(true);
    });

    test('a private control directory connects (the control for the case above)', async () => {
      const server = startServer();
      fs.chmodSync(path.join(server.codexHome, 'app-server-control'), 0o700);
      const { session, messages } = create(buildDeps(server, { linkWatchdogMs: 300 }));
      await session.start();
      await until(() => server.clientIds().length === 1, 'the connection');
      expect(logs.some((l) => l.includes('open to group or others'))).toBe(false);
      expect(noticeCount(messages)).toBe(0);
    });

    /** The client reached `ready` (it logs the app-server's version then). */
    const linkWasUp = () => logs.some((l) => l.includes('app-server '));

    slow('a link that comes up in time and stays up sends nothing', async () => {
      // The watchdog is long against a PTY spawn, a connect and an initialize, and the link
      // counts as up for good once it has stayed up for linkStableMs.
      const { session, messages } = create(
        buildDeps(startServer(), { linkWatchdogMs: 2000, linkStableMs: 200 }),
      );
      await session.start();
      await until(linkWasUp, 'the link to come up');
      await sleep(2600);
      expect(noticeCount(messages)).toBe(0);
    });

    slow(
      'a link that keeps dropping inside the stable period still fires the watchdog (W17c)',
      async () => {
        const server = startServer();
        const { session, messages } = create(
          buildDeps(server, {
            linkWatchdogMs: 700,
            linkStableMs: 500,
            appServer: { backoff: { initialMs: 10, maxMs: 40 } },
          }),
        );
        await session.start();
        await until(linkWasUp, 'the link to come up once');
        // It accepts and drops every 100 ms, so it is never up for 500 ms.
        const flap = setInterval(() => {
          for (const client of server.clientIds()) server.dropClient(client);
        }, 100);
        try {
          await until(() => noticeCount(messages) === 1, 'the notice for a flapping link', 6000);
        } finally {
          clearInterval(flap);
        }
      },
    );

    slow(
      'a link that drops inside the stable period and stays down still fires the watchdog (W17c)',
      async () => {
        // The drop arms the watchdog; the stable timer of the connection that just ended must
        // not outlive it and cancel what the drop armed.
        const server = startServer();
        const { session, messages } = create(
          buildDeps(server, { linkWatchdogMs: 1000, linkStableMs: 700 }),
        );
        await session.start();
        await until(linkWasUp, 'the link to come up');
        await server.stop();
        await until(() => noticeCount(messages) === 1, 'the notice after the early drop', 8000);
      },
    );

    slow(
      'a socket that resolved after an untrusted attempt does not keep the untrusted wording (W12)',
      async () => {
        // The first attempts are refused as not private; then the directory is fixed and the link
        // flaps (accepts and drops), so the watchdog fires after attempts that resolved fine. What
        // it says must come from those, not from the refusal long gone.
        const server = startServer();
        const control = path.join(server.codexHome, 'app-server-control');
        fs.chmodSync(control, 0o755);
        const { session, messages } = create(
          buildDeps(server, {
            linkWatchdogMs: 1500,
            linkStableMs: 700,
            appServer: { backoff: { initialMs: 10, maxMs: 40 } },
          }),
        );
        await session.start();
        await until(() => logs.some((l) => l.includes('open to group or others')), 'the refusal');
        fs.chmodSync(control, 0o700);
        await until(linkWasUp, 'the link to come up once the directory is private');
        const flap = setInterval(() => {
          for (const client of server.clientIds()) server.dropClient(client);
        }, 100);
        try {
          await until(() => noticeCount(messages) === 1, 'the notice', 8000);
        } finally {
          clearInterval(flap);
        }
        const text = messages.find((m) => m.sender === 'system')?.content ?? '';
        expect(text).toContain('cannot reach');
        expect(text).not.toContain('not private');
      },
    );

    test('with the production wait, a session is not told its thread is missing in its first moments (W11)', async () => {
      const { session, messages } = create(buildDeps(startServer()));
      await session.start();
      await until(linkWasUp, 'the link to come up');
      await sleep(500);
      expect(noticeCount(messages)).toBe(0);
      expect(logs.some((l) => l.includes('no thread/started'))).toBe(false);
    });

    slow('a link that drops and stays down sends the notice once', async () => {
      const server = startServer();
      const { session, messages } = create(
        buildDeps(server, { linkWatchdogMs: 1200, linkStableMs: 150 }),
      );
      await session.start();
      await until(linkWasUp, 'the link to come up');
      await sleep(400);
      // Up, stable, and quiet: whatever fires next comes from the drop, not from the start.
      expect(noticeCount(messages)).toBe(0);
      await server.stop();
      await until(() => noticeCount(messages) === 1, 'the notice after the drop', 8000);
      await sleep(500);
      expect(noticeCount(messages)).toBe(1);
    });

    slow('the notice is sent once per session, however many times the link drops', async () => {
      const first = startServer();
      const second = startServer();
      const home = { current: first.codexHome };
      const { session, messages } = create(
        buildDeps(null, {
          linkWatchdogMs: 1200,
          linkStableMs: 150,
          env: () => ({ CODEX_HOME: home.current }),
        }),
      );
      await session.start();
      await until(() => first.clientIds().length === 1, 'the first connection');
      await until(linkWasUp, 'the link to come up');
      await sleep(400);
      expect(noticeCount(messages)).toBe(0);
      await first.stop();
      await until(() => noticeCount(messages) === 1, 'the first notice', 8000);

      // The link comes back on another socket, stays up, then drops again for good.
      home.current = second.codexHome;
      await until(() => second.clientIds().length === 1, 'the second connection', 8000);
      await sleep(400);
      await second.stop();
      await sleep(2000);
      expect(noticeCount(messages)).toBe(1);
    });

    test('dispose closes the connection to the app-server', async () => {
      const server = startServer();
      const { session } = create(buildDeps(server));
      await session.start();
      await until(() => server.clientIds().length === 1, 'the connection');
      session.dispose();
      await until(() => server.clientIds().length === 0, 'the connection to close');
      await sleep(300);
      expect(server.clientIds()).toEqual([]);
    });

    test('dispose after the link was up leaves no timer and sends no notice (W6)', async () => {
      // Dispose stops the client, which reports a drop; that must not re-arm the watchdog. The
      // watchdog is long against a slow connect, and the link has stayed up long enough (100 ms)
      // to have canceled it before dispose, so only the drop dispose causes could fire it.
      const server = startServer();
      const { session, messages } = create(
        buildDeps(server, { linkWatchdogMs: 1500, linkStableMs: 100 }),
      );
      await session.start();
      await until(() => logs.some((l) => l.includes('app-server ')), 'the client to be ready');
      await sleep(300);
      session.dispose();
      await sleep(2000);
      expect(noticeCount(messages)).toBe(0);
      expect(logs.some((l) => l.includes('not reachable'))).toBe(false);
    });

    test('dispose cancels the watchdog and is safe to call twice', async () => {
      const { session, messages } = create(buildDeps(null, { linkWatchdogMs: 200 }));
      await session.start();
      session.dispose();
      session.dispose();
      await sleep(500);
      expect(noticeCount(messages)).toBe(0);
    });
  });

  describe('as a Harness', () => {
    test('it types nothing to stop, names no transcript file, and resumes with the subcommand', () => {
      const harness = new CodexHarness();
      expect(harness.gracefulExitInput).toBeNull();
      expect(harness.transcriptPath()).toBeNull();
      expect(harness.resumeArgs('abc')).toEqual(['resume', 'abc']);
    });

    test('built without launch dependencies it refuses to launch or preflight', () => {
      const harness = new CodexHarness();
      expect(() => harness.preflight([], workDir)).toThrow('without launch dependencies');
      expect(() =>
        harness.createSession({
          sessionId: crypto.randomUUID() as UUID,
          workingDirectory: '/',
          extraArgs: [],
          passThrough: false,
          reservedRows: 0,
          messageApi: new MessageAPI({ sessionId: crypto.randomUUID() as UUID }),
          sendAndRecord: () => {},
          sendMessage: () => {},
        }),
      ).toThrow('without launch dependencies');
    });

    test('preflight is the check, with nothing written', () => {
      const harness = new CodexHarness(buildDeps(null));
      expect(harness.preflight(['--bogus'], workDir).ok).toBe(false);
      expect(harness.preflight([], workDir)).toEqual({
        ok: true,
        args: [],
        resumeThreadId: null,
        directory: workDir,
      });
      expect(fs.existsSync(path.join(tmpDir, 'sessions.json'))).toBe(false);
    });
  });
});
