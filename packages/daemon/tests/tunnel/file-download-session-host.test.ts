/** Real Host/D2/native descriptors + actual ClaudeHarness in an owned accountless child. */
import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { MessageAPI } from '../../src/api/message-api';
import { SubagentViewRegistry } from '../../src/api/subagent-view-registry';
import { IdentityStore } from '../../src/auth/identity-store';
import { SubagentAlerter } from '../../src/auto-approve';
import { ClaudeHarness } from '../../src/harness/claude';
import type { HarnessSession } from '../../src/harness/types';
import { ForeignSessionEscalator } from '../../src/hooks';
import { SessionBindingStore } from '../../src/session/session-binding-store';
import { SessionRegistry } from '../../src/session/session-registry';
import { SessionRegistryFile } from '../../src/session/session-registry-file';
import { SessionStore } from '../../src/session/session-store';
import { TranscriptIndex } from '../../src/session/transcript-index';
import { TranscriptDiscovery } from '../../src/transcript';
import {
  FileDownloadSessionHost,
  downloadProtectionRoots,
} from '../../src/tunnel/file-download-session-host';
import { directTlsFixture } from '../helpers/direct-tls-fixture';

const selected = process.env['REMI_DOWNLOAD_HOST_CASE'];
async function component(name: string) {
  const [home, work, userHome] = process.argv.slice(2);
  assert(home && work && userHome);
  let checks = 0;
  const check = (value: unknown) => {
    checks++;
    assert.ok(value);
  };
  const same = (a: unknown, b: unknown) => {
    checks++;
    assert.strictEqual(a, b);
  };
  const id = crypto.randomUUID();
  const runtimes = new Map<string, HarnessSession>();
  const notifications: object[] = [];
  let host!: FileDownloadSessionHost;
  const sessions = new SessionRegistry(
    {},
    {
      onSessionClosed: (id) => {
        host.retireSession(id);
        void host.closeSession(id);
      },
      onAttachStateChanged: (id) => host.attachmentsChanged(id),
    },
  );
  const store = new SessionStore(join(home, 'component-sessions.json'));
  const mirror = join(home, 'component-mirror.json');
  const bindings = new SessionBindingStore(store, new TranscriptIndex(mirror), {
    beforeWrite: (id) => host.beforeBindingWrite(id),
    afterCommit: (id, expected, verified) => host.afterClaudeCommit(id, expected, verified),
    afterHarnessIdentityCommit: (id, harness, expected, row) =>
      host.afterHarnessIdentityCommit(id, harness, expected, row),
  });
  host = new FileDownloadSessionHost({
    home,
    sessions,
    bindings,
    runtimeFor: (id) => runtimes.get(id),
    directAdapter: () => undefined,
    rootsFor: (workingDirectory) =>
      downloadProtectionRoots({
        home,
        userHome,
        workingDirectory,
        harness: 'claude',
        ...(name === 'explicit-required' && { claudeConfigDirectory: 'custom-home' }),
      }),
    onReady: (id) => {
      const value = host.contextFor(id);
      if (value) notifications.push(value);
    },
  });
  let runtime: HarnessSession | undefined;
  try {
    const trust = new IdentityStore(home);
    await trust.generate();
    check(await host.open(trust));
    host.beginSession(id, work);
    check(host.contextFor(id) === null);
    if (name === 'pending-close') {
      let finished = false;
      const closing = host.closeAll().then((value) => {
        finished = true;
        return value;
      });
      await Bun.sleep(0);
      same(finished, false);
      check(await host.failed(id));
      check(await closing);
      check(host.contextFor(id) === null);
      return () => checks;
    }
    const discovery = new TranscriptDiscovery({
      projectsDir: join(userHome, '.claude', 'projects'),
    });
    const live = new SessionRegistryFile(join(home, 'component-live'));
    fs.mkdirSync(live.dirPath, { recursive: true });
    const harness = new ClaudeHarness(discovery, {
      sessionRegistry: sessions,
      sessionStore: store,
      bindingStore: bindings,
      liveSessionsRegistry: live,
      transcriptDiscovery: discovery,
      transcriptWatchers: new Map(),
      transcriptFallbackTimers: new Map(),
      subagentViews: new SubagentViewRegistry(),
      foreignSessionEscalator: new ForeignSessionEscalator({
        liveSessionsRegistry: live,
        bindingStore: bindings,
        deviceTokens: new Map(),
        pushConfig: () => ({ signalingUrl: 'http://127.0.0.1:1' }),
        currentPort: () => 1,
      }),
      subagentAlerts: { alerter: new SubagentAlerter([]), deliver: () => {} },
      onQuestionResolved: () => {},
      onHarnessDenied: () => {},
      pushTurnFailed: () => {},
      dismissTurnFailed: () => {},
      prompts: () => ({ hold_seconds: 90, daemon_hold_seconds: 3540 }),
      hookServer: () => null,
      currentPort: () => 1,
      wsPort: () => 1,
      // Component only: keep the real exit callback from exiting this child before assertions.
      // Actual shipping cleanup/exit is tested separately through file-download-cli.
      cleanup: () => new Promise<void>(() => {}),
      observeLocalPtyOutput: () => {},
      sessionNotifiers: new Map(),
    });
    const messageApi = new MessageAPI({ sessionId: id });
    runtime = await harness.createSession({
      sessionId: id,
      workingDirectory: work,
      extraArgs: [],
      passThrough: false,
      reservedRows: 0,
      messageApi,
      sendAndRecord: () => {},
      sendMessage: () => {},
    });
    runtimes.set(id, runtime);
    host.bindSession(id, runtime);
    sessions.registerSession(id, work, runtime.pty, messageApi, true);
    check(host.contextFor(id) === null);
    await runtime.start();
    assert(runtime.pty.childPid);
    fs.writeFileSync(join(home, '..', 'component-consumer-pid'), String(runtime.pty.childPid));
    host.started(id);
    const initial = host.contextFor(id);
    if (name === 'explicit-required') {
      same(initial, null);
      fs.mkdirSync(join(work, 'custom-home'), { mode: 0o700 });
      check(host.contextFor(id));
      fs.rmdirSync(join(work, 'custom-home'));
      check(host.contextFor(id) === null);
    } else {
      check(initial);
      same(initial?.runtime, runtime);
      same(host.contextFor(id), initial);
      check(initial?.protectedRootPaths.includes(home));
      check(initial?.protectedRootPaths.includes(join(userHome, '.claude')));
      same(initial?.protectedRootPaths.includes(join(userHome, '.codex')), false);
      if (name === 'binding-and-mirror') {
        const binding = bindings.getIdentity(id)?.harnessSessionId;
        if (!binding) throw new Error('Actual binding absent');
        bindings.update(id, binding);
        const adopted = host.contextFor(id);
        check(adopted && adopted !== initial);
        same(bindings.getIdentity(id)?.harnessSessionId, binding);
        fs.rmSync(mirror);
        fs.mkdirSync(mirror);
        bindings.update(id, crypto.randomUUID());
        check(host.contextFor(id) === null);
        fs.rmdirSync(mirror);
      } else if (name === 'failed-store-write') {
        const binding = bindings.getIdentity(id)?.harnessSessionId;
        if (!binding) throw new Error('Actual binding absent');
        const pathname = join(home, 'component-sessions.json');
        const backup = `${pathname}.owned-backup`;
        fs.renameSync(pathname, backup);
        fs.mkdirSync(pathname);
        let refused = false;
        try {
          bindings.update(id, binding);
        } catch {
          refused = true;
        }
        check(refused);
        fs.rmdirSync(pathname);
        fs.renameSync(backup, pathname);
        same(bindings.getIdentity(id)?.harnessSessionId, binding);
        check(host.contextFor(id) === null); // Same persisted id cannot restore a failed observation.
        bindings.update(id, binding);
        check(host.contextFor(id) !== initial);
      } else if (name === 'inactive-appearance') {
        const inactive = join(userHome, '.codex');
        fs.mkdirSync(inactive, { mode: 0o700 });
        const expanded = host.contextFor(id);
        check(expanded && expanded !== initial);
        check(expanded?.protectedRootPaths.includes(inactive));
        fs.rmdirSync(inactive);
        check(host.contextFor(id) === null);
        fs.mkdirSync(inactive, { mode: 0o700 });
        const replacement = host.contextFor(id);
        check(replacement && replacement !== expanded);
      } else if (name === 'metadata-errors') {
        const inactive = join(userHome, '.codex');
        fs.symlinkSync(work, inactive);
        check(host.contextFor(id) === null);
        fs.unlinkSync(inactive);
        check(host.contextFor(id) === null); // Seen symlink is never an ENOENT exemption later.
        fs.mkdirSync(inactive, { mode: 0o700 });
        check(host.contextFor(id));
        fs.chmodSync(inactive, 0);
        check(host.contextFor(id) === null);
        fs.chmodSync(inactive, 0o700);
        fs.rmdirSync(inactive);
        fs.writeFileSync(inactive, 'owned metadata fault');
        check(host.contextFor(id) === null);
        fs.unlinkSync(inactive);
      } else if (name === 'runtime-and-close') {
        runtimes.delete(id);
        check(host.contextFor(id) === null);
        runtimes.set(id, runtime);
        check(host.contextFor(id) !== initial);
        sessions.closeSession(id, 'forced');
        check(host.contextFor(id) === null);
        check(await host.closeAll());
        while (runtime.pty.sessionState !== 'exited') await Bun.sleep(5);
        same(runtime.pty.isRunning, false);
      } else {
        await Bun.sleep(0);
        same(notifications.length, 1);
      }
    }
    check(await host.closeAll());
    check(host.contextFor(id) === null);
    return () => checks;
  } finally {
    runtime?.dispose();
    if (runtime?.pty.isRunning) await runtime.pty.close();
    await host.failed(id);
    check(await host.closeAll());
  }
}

if (selected) {
  const checks = await component(selected);
  console.log(JSON.stringify({ case: selected, checks: checks(), passed: true }));
  process.exit(0);
} else {
  test('actual Codex binding observer preserves same-id writes, missing rows and failed persistence', () => {
    const files = directTlsFixture();
    try {
      const pathname = join(files.home, 'observer-sessions.json');
      const store = new SessionStore(pathname);
      const events: {
        phase: string;
        expected?: string | null;
        row?: string | null;
        fresh?: string | null;
      }[] = [];
      const bindings = new SessionBindingStore(store, undefined, {
        beforeWrite: () => events.push({ phase: 'before' }),
        afterCommit: () => {
          throw new Error('Codex must not fabricate Claude mirror evidence');
        },
        afterHarnessIdentityCommit: (id, harness, expected, row) => {
          expect(harness).toBe('codex');
          events.push({
            phase: 'after',
            expected,
            row: row?.harnessSessionId ?? null,
            fresh: bindings.getIdentity(id)?.harnessSessionId ?? null,
          });
        },
      });
      const id = crypto.randomUUID();
      const thread = crypto.randomUUID();
      bindings.preAssign({
        remiSessionId: id,
        claudeSessionId: null,
        harness: 'codex',
        harnessSessionId: thread,
        projectPath: files.work,
        port: 1,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        exitedAt: null,
        exitCode: null,
      });
      expect(events).toEqual([
        { phase: 'before' },
        { phase: 'after', expected: thread, row: thread, fresh: thread },
      ]);
      events.length = 0;
      bindings.updateHarnessIdentity(id, 'codex', thread);
      expect(events).toEqual([
        { phase: 'before' },
        { phase: 'after', expected: thread, row: thread, fresh: thread },
      ]);
      events.length = 0;
      bindings.updateHarnessIdentity(crypto.randomUUID(), 'codex', thread);
      expect(events).toEqual([
        { phase: 'before' },
        { phase: 'after', expected: thread, row: null, fresh: null },
      ]);
      events.length = 0;
      const backup = `${pathname}.owned-backup`;
      fs.renameSync(pathname, backup);
      fs.mkdirSync(pathname);
      expect(() => bindings.updateHarnessIdentity(id, 'codex', thread)).toThrow();
      expect(events).toEqual([{ phase: 'before' }]);
      fs.rmdirSync(pathname);
      fs.renameSync(backup, pathname);
      expect(bindings.getIdentity(id)?.harnessSessionId).toBe(thread);
    } finally {
      files.cleanup();
    }
  });
  for (const name of [
    'ready-stable',
    'binding-and-mirror',
    'failed-store-write',
    'inactive-appearance',
    'metadata-errors',
    'explicit-required',
    'runtime-and-close',
    'pending-close',
  ])
    test(`actual host/HarnessSession metadata and lifecycle: ${name}`, async () => {
      const files = directTlsFixture();
      let child: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
      const pidFile = join(files.directory, 'component-consumer-pid');
      let safelyEnded = false;
      let terminated = false;
      const errors: unknown[] = [];
      async function exited(milliseconds: number): Promise<boolean> {
        if (!child || child.exitCode !== null) return true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            child.exited.then(() => true),
            new Promise<false>((resolve) => {
              timer = setTimeout(() => resolve(false), milliseconds);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }
      try {
        const bin = join(files.directory, 'bin');
        fs.mkdirSync(bin);
        fs.mkdirSync(join(files.userHome, '.claude'), { mode: 0o700 });
        fs.writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexec /bin/cat\n', { mode: 0o700 });
        child = Bun.spawn(
          [
            process.execPath,
            '--no-env-file',
            import.meta.path,
            files.home,
            files.work,
            files.userHome,
          ],
          {
            env: { ...files.env, PATH: `${bin}:/usr/bin:/bin`, REMI_DOWNLOAD_HOST_CASE: name },
            stdin: 'ignore',
            stdout: 'pipe',
            stderr: 'pipe',
          },
        );
        const collected = Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        if (!(await exited(15000)))
          throw new Error('Owned component child exceeded its bounded run');
        const [stdout, stderr, code] = await collected;
        expect(code, stderr).toBe(0);
        const receipt = stdout
          .trim()
          .split('\n')
          .map((line) => {
            try {
              return JSON.parse(line);
            } catch {
              return null;
            }
          })
          .find((row) => row?.case === name);
        expect(receipt?.passed).toBe(true);
        expect(receipt?.checks).toBeGreaterThanOrEqual(5);
        console.info('Owned download host child receipt', JSON.stringify(receipt));
      } catch (error) {
        errors.push(error);
      } finally {
        if (child && child.exitCode === null) {
          terminated = true;
          try {
            child.kill('SIGTERM');
          } catch (error) {
            errors.push(error);
          }
          if (!(await exited(1500))) {
            try {
              child.kill('SIGKILL');
            } catch (error) {
              errors.push(error);
            }
            if (!(await exited(1000))) errors.push(new Error('Owned component child did not reap'));
          }
        }
        safelyEnded = !child || child.exitCode !== null;
        try {
          if (!fs.existsSync(pidFile) && terminated) safelyEnded = false;
          if (fs.existsSync(pidFile)) {
            const raw = fs.readFileSync(pidFile, 'utf8');
            if (!/^[1-9][0-9]*$/u.test(raw)) safelyEnded = false;
            else {
              const pid = Number(raw);
              const end = performance.now() + 1000;
              for (;;) {
                try {
                  process.kill(pid, 0);
                  safelyEnded = false;
                } catch (error) {
                  safelyEnded = (error as NodeJS.ErrnoException).code === 'ESRCH';
                }
                if (safelyEnded || performance.now() >= end) break;
                await Bun.sleep(5);
              }
            }
          }
        } catch (error) {
          safelyEnded = false;
          errors.push(error);
        }
        if (safelyEnded) {
          try {
            files.cleanup();
          } catch (error) {
            errors.push(error);
          }
        } else
          errors.push(new Error('Owned component consumer death unconfirmed; fixture retained'));
      }
      if (errors.length) throw new AggregateError(errors, 'Owned component run/cleanup failed');
    }, 20000);
}
