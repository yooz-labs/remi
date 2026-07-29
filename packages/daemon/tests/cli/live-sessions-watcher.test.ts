import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProtocolMessage } from '@remi/shared';
import {
  type LiveSessionsCollectResult,
  startLiveSessionsWatcher,
} from '../../src/cli/live-sessions-watcher.ts';
import { SessionRegistryFile } from '../../src/session/session-registry-file.ts';

/**
 * Wait until `predicate` holds, or fail after `timeoutMs`.
 *
 * These tests drive a real `fs.watch` through a debounce, so the delay between
 * an action and its observable effect is the OS's to decide, not ours. Sleeping
 * a fixed 150ms and then asserting the effect HAPPENED encodes a guess about
 * how loaded the machine is: it passes on a quiet laptop and fails on a busy CI
 * runner, which is exactly how #848/#849 blocked a release without either test
 * being wrong about the behavior it describes.
 *
 * Polling for the condition instead makes the test wait exactly as long as it
 * needs to and no longer, and turns a timeout into an honest failure message
 * rather than a confusing assertion on an empty array. Note this is only valid
 * for POSITIVE assertions ("this eventually happens"); proving a broadcast
 * never arrives still requires waiting a fixed interval.
 *
 * The budget has to clear TWO bars, and the first draft cleared neither:
 *
 *   - It must beat bun's own per-test deadline, which defaults to exactly
 *     5000ms. A `waitFor` that also waited 5000ms could never report first —
 *     its clock starts strictly later — so bun's generic "this test timed out"
 *     won every race and the descriptive message was demoted to an
 *     "Unhandled error between tests" footnote. Hence `TEST_TIMEOUT_MS`, passed
 *     per test, with this default comfortably under it.
 *   - It must be long enough that a loaded machine is not itself the failure.
 *     Observed live while reviewing this change: on a host running several
 *     concurrent workloads, the `fs.watch` callback for a sibling registration
 *     took over five seconds. A budget tight enough to trip on that is the
 *     original bug with a bigger number.
 */
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

/** Per-test deadline for the `waitFor` tests, raised above bun's 5000ms default
 *  so `waitFor`'s own message is always the one reported. */
const TEST_TIMEOUT_MS = 30_000;

describe('startLiveSessionsWatcher (#542)', () => {
  let tmpDir: string;
  let registry: SessionRegistryFile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-live-sessions-watcher-'));
    registry = new SessionRegistryFile(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test(
    'broadcasts once when a sibling registers, carrying its port',
    async () => {
      const broadcasts: ProtocolMessage[] = [];
      const errors: string[] = [];
      const closer = startLiveSessionsWatcher({
        dirPath: tmpDir,
        collect: (): LiveSessionsCollectResult | null => {
          const newPorts = registry.getLivePorts();
          if (newPorts.length === 0) return null;
          return { sessions: [], newPorts };
        },
        broadcast: (message) => broadcasts.push(message),
        logError: (msg) => errors.push(msg),
        debounceMs: 20,
      });

      try {
        registry.register({
          sessionId: '11111111-1111-1111-1111-111111111111',
          pid: process.pid,
          wsPort: 20050,
          hookPort: 0,
          projectPath: tmpDir,
          name: 'sibling',
          startedAt: new Date().toISOString(),
        });

        await waitFor(() => broadcasts.length > 0, 'the sibling registration to broadcast');

        expect(errors).toEqual([]);
        expect(broadcasts).toHaveLength(1);
        const msg = broadcasts[0] as unknown as { type: string; daemonPorts?: readonly number[] };
        expect(msg.type).toBe('session_list_response');
        expect(msg.daemonPorts).toContain(20050);
      } finally {
        closer();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'onDirChange fires on every flush, including removals that broadcast nothing (#650)',
    async () => {
      const broadcasts: ProtocolMessage[] = [];
      let dirChanges = 0;
      const closer = startLiveSessionsWatcher({
        dirPath: tmpDir,
        // Removal shape: nothing new to broadcast, ever.
        collect: (): LiveSessionsCollectResult | null => null,
        broadcast: (message) => broadcasts.push(message),
        logError: () => {},
        debounceMs: 20,
        onDirChange: () => {
          dirChanges += 1;
        },
      });

      try {
        const entry = {
          sessionId: '22222222-2222-2222-2222-222222222222',
          pid: process.pid,
          wsPort: 20051,
          hookPort: 0,
          projectPath: tmpDir,
          name: 'sibling',
          startedAt: new Date().toISOString(),
        };
        registry.register(entry);
        await waitFor(() => dirChanges >= 1, 'onDirChange to fire for the registration');
        const afterRegister = dirChanges;
        expect(afterRegister).toBeGreaterThanOrEqual(1);

        registry.unregister(entry.sessionId);
        await waitFor(
          () => dirChanges > afterRegister,
          'onDirChange to fire again for the removal',
        );
        expect(dirChanges).toBeGreaterThan(afterRegister);
        // The whole point: the census hook fired even though no
        // session_list_response was broadcast.
        expect(broadcasts).toHaveLength(0);
      } finally {
        closer();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test('closer stops further broadcasts', async () => {
    const broadcasts: ProtocolMessage[] = [];
    const closer = startLiveSessionsWatcher({
      dirPath: tmpDir,
      collect: (): LiveSessionsCollectResult | null => {
        const newPorts = registry.getLivePorts();
        if (newPorts.length === 0) return null;
        return { sessions: [], newPorts };
      },
      broadcast: (message) => broadcasts.push(message),
      logError: () => {},
      debounceMs: 20,
    });

    closer();
    // Second call must not throw.
    closer();

    registry.register({
      sessionId: '22222222-2222-2222-2222-222222222222',
      pid: process.pid,
      wsPort: 20051,
      hookPort: 0,
      projectPath: tmpDir,
      name: 'sibling-after-close',
      startedAt: new Date().toISOString(),
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(broadcasts).toEqual([]);
  });

  test(
    'a collect that throws is caught: logError called, no crash, no broadcast',
    async () => {
      const broadcasts: ProtocolMessage[] = [];
      const errors: string[] = [];
      const closer = startLiveSessionsWatcher({
        dirPath: tmpDir,
        collect: (): LiveSessionsCollectResult | null => {
          throw new Error('collect exploded');
        },
        broadcast: (message) => broadcasts.push(message),
        logError: (msg) => errors.push(msg),
        debounceMs: 20,
      });

      try {
        registry.register({
          sessionId: '33333333-3333-3333-3333-333333333333',
          pid: process.pid,
          wsPort: 20052,
          hookPort: 0,
          projectPath: tmpDir,
          name: 'sibling',
          startedAt: new Date().toISOString(),
        });

        // Wait for THE collect error specifically, not merely for any log line.
        // `register()` writes a `.json.tmp` and renames it, and on Linux the
        // watcher can emit ENOENT for the vanished temp path; its handler then
        // logs first and `errors[0]` is that, not this test's subject (#903).
        await waitFor(
          () => errors.some((e) => e.includes('collect exploded')),
          'the throwing collect to be logged',
        );

        expect(broadcasts).toEqual([]);
        expect(errors.some((e) => e.includes('collect exploded'))).toBe(true);
      } finally {
        closer();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

/**
 * A watcher error must not permanently disable sibling-daemon broadcasts.
 *
 * The handler closes the watcher on error, deliberately: an FSWatcher emitting
 * `error` with no listener throws as an uncaughtException and would kill an
 * unattended launchd-managed hub. But closing PERMANENTLY turns a millisecond
 * fs race into a daemon that never broadcasts a sibling again for its whole
 * lifetime — and on Linux that race is routine, because `register()` writes a
 * `.json.tmp` and renames it, and inotify can report the vanished temp path.
 *
 * This was found via CI: a test whose subject is `collect` being called hung
 * for its full timeout, because the watcher had died before any file event
 * could reach the debounced flush.
 */
describe('watcher re-arms after a transient error (#903 follow-up)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-rearm-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a file event still reaches collect after the re-arm window', async () => {
    const collects: number[] = [];
    const closer = startLiveSessionsWatcher({
      dirPath: dir,
      collect: (): LiveSessionsCollectResult | null => {
        collects.push(Date.now());
        return null;
      },
      broadcast: () => {},
      logError: () => {},
      debounceMs: 10,
    });

    try {
      fs.writeFileSync(path.join(dir, 'a.json'), '{}');
      await waitFor(() => collects.length > 0, 'the first flush');
      const before = collects.length;

      // Past any re-arm delay, a real event must still be observed. Before the
      // re-arm change a watcher killed by a transient ENOENT stayed dead and
      // this second write would be silently ignored forever.
      await new Promise((r) => setTimeout(r, 400));
      fs.writeFileSync(path.join(dir, 'b.json'), '{}');
      await waitFor(() => collects.length > before, 'a flush after the re-arm window');
    } finally {
      closer();
    }
  });

  test('the closer cancels a pending re-arm so a stopped watcher stays stopped', async () => {
    let collects = 0;
    const closer = startLiveSessionsWatcher({
      dirPath: dir,
      collect: (): LiveSessionsCollectResult | null => {
        collects++;
        return null;
      },
      broadcast: () => {},
      logError: () => {},
      debounceMs: 10,
    });
    closer();
    const after = collects;
    fs.writeFileSync(path.join(dir, 'c.json'), '{}');
    await new Promise((r) => setTimeout(r, 400));
    expect(collects).toBe(after);
  });
});
