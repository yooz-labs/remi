import { afterEach, expect, spyOn, test } from 'bun:test';
import type { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import type { ProtocolMessage } from '@remi/shared';
import { startLiveSessionsWatcher } from '../../src/cli/live-sessions-watcher.ts';
import { SessionRegistryFile } from '../../src/session/session-registry-file.ts';

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const ownedDirs: string[] = [];
afterEach(() => {
  for (const dir of ownedDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate() && Date.now() < deadline) await pause(5);
  expect(predicate(), 'the real OS watcher reached the required boundary').toBe(true);
}

async function fixture(registerBeforeArm = false) {
  const dir = fs.mkdtempSync('/private/tmp/remi-watcher-recovery-');
  ownedDirs.push(dir);
  const registry = new SessionRegistryFile(dir);
  const register = () =>
    registry.register({
      sessionId: '11111111-1111-1111-1111-111111111111',
      pid: process.pid,
      wsPort: 20050,
      hookPort: 0,
      projectPath: dir,
      name: 'sibling',
      startedAt: new Date().toISOString(),
    });
  if (registerBeforeArm) {
    register();
    // Settle the fixture's earlier native events BEFORE constructing the
    // component; otherwise macOS may deliver that queued event after arm,
    // accidentally rescuing a missing initial census. This is setup only.
    await pause(500);
  }
  const watchers: fs.FSWatcher[] = [];
  const realWatch = fs.watch;
  // Delegate every watch to the real OS. Capture its actual EventEmitter only
  // to inject a controlled OS-boundary error; no collection/registry logic is replaced.
  const recordWatch = ((...args: unknown[]): fs.FSWatcher => {
    const watcher = Reflect.apply(realWatch, fs, args) as fs.FSWatcher;
    watchers.push(watcher);
    return watcher;
  }) as typeof fs.watch;
  const recorder = spyOn(fs, 'watch').mockImplementation(recordWatch);
  const broadcasts: ProtocolMessage[] = [];
  const errors: string[] = [];
  let collects = 0;
  const close = startLiveSessionsWatcher({
    dirPath: dir,
    debounceMs: 200,
    collect: () => {
      collects++;
      return { sessions: [], newPorts: registry.getLivePorts() };
    },
    broadcast: (message) => broadcasts.push(message),
    logError: (message) => errors.push(message),
  });
  return {
    registry,
    watchers,
    broadcasts,
    errors,
    get collects() {
      return collects;
    },
    register,
    stop: close,
    dispose: () => {
      close();
      recorder.mockRestore();
    },
  };
}

function firstWatcher(watchers: fs.FSWatcher[]): fs.FSWatcher {
  const watcher = watchers[0];
  if (!watcher) throw new Error('actual OS watcher was not constructed');
  return watcher;
}

function interrupt(watcher: fs.FSWatcher): void {
  (watcher as unknown as EventEmitter).emit(
    'error',
    Object.assign(new Error('controlled OS-boundary interruption'), { code: 'ENOENT' }),
  );
}

for (const boundary of ['pending debounce', 'closed rearm window'] as const) {
  test(`reconciles a sibling registered during ${boundary} without retouch (OS-boundary error injection)`, async () => {
    const f = await fixture();
    try {
      const watcher = firstWatcher(f.watchers);
      if (boundary === 'pending debounce') {
        let observed = false;
        (watcher as unknown as EventEmitter).once('change', () => {
          observed = true;
        });
        f.register();
        await waitFor(() => observed);
        expect(f.collects, 'the real registration event is still waiting in debounce').toBe(0);
      }
      interrupt(watcher);
      if (boundary === 'closed rearm window') f.register();
      await waitFor(() => f.watchers.length === 2);
      // Once the OS watcher has actually rearmed, allow its real 200ms debounce
      // to run. No second write/event is made to rescue the lost registration.
      await pause(350);
      expect(f.registry.getLivePorts()).toEqual([20050]);
      expect(f.errors.some((error) => error.includes('re-arming'))).toBe(true);
      expect(
        f.broadcasts,
        'successful rearm reconciles the durable sibling without retouch',
      ).toHaveLength(1);
      expect(f.broadcasts[0]?.type).toBe('session_list_response');
      if (f.broadcasts[0]?.type === 'session_list_response')
        expect(f.broadcasts[0].daemonPorts).toEqual([20050]);
    } finally {
      f.dispose();
    }
  }, 30_000);
}

test('closer cancels actual pending rearm and reconciliation (OS-boundary error injection)', async () => {
  const f = await fixture();
  try {
    interrupt(firstWatcher(f.watchers));
    f.stop();
    f.register();
    await pause(600);
    expect(f.watchers, 'a stopped watcher cannot rearm').toHaveLength(1);
    expect(f.collects, 'a stopped watcher cannot reconcile').toBe(0);
    expect(f.broadcasts).toHaveLength(0);
  } finally {
    f.dispose();
  }
});

test('rearm reconciliation and a real registration event share one debounce', async () => {
  const f = await fixture();
  try {
    interrupt(firstWatcher(f.watchers));
    f.register();
    await waitFor(() => f.watchers.length === 2);
    const watcher = f.watchers[1];
    if (!watcher) throw new Error('actual replacement watcher was not constructed');
    let observed = false;
    (watcher as unknown as EventEmitter).once('change', () => {
      observed = true;
    });
    f.register();
    await waitFor(() => observed);
    await pause(350);
    expect(f.broadcasts, 'event and reconciliation produce one debounced delivery').toHaveLength(1);
  } finally {
    f.dispose();
  }
}, 30_000);

test('closer cancels reconciliation after actual watcher rearm', async () => {
  const f = await fixture();
  try {
    interrupt(firstWatcher(f.watchers));
    f.register();
    await waitFor(() => f.watchers.length === 2);
    f.stop();
    await pause(350);
    expect(f.collects, 'closing after rearm cancels its pending reconciliation').toBe(0);
    expect(f.broadcasts).toHaveLength(0);
  } finally {
    f.dispose();
  }
}, 30_000);

test('actual watcher errors exhaust the existing five-rearm budget', async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 5; index++) {
      const watcher = f.watchers[index];
      if (!watcher) throw new Error('actual OS watcher was not constructed');
      interrupt(watcher);
      await waitFor(() => f.watchers.length === index + 2);
    }
    const last = f.watchers[5];
    if (!last) throw new Error('fifth replacement watcher was not constructed');
    interrupt(last);
    await pause(350);
    expect(f.watchers, 'five retries never become an unbounded rearm loop').toHaveLength(6);
    expect(f.errors.filter((error) => error.includes('re-arming'))).toHaveLength(5);
    expect(f.errors.some((error) => error.includes('budget exhausted'))).toBe(true);
    expect(f.broadcasts).toHaveLength(0);
  } finally {
    f.dispose();
  }
}, 30_000);

// No event is required for an already durable sibling. This also pins the
// initial census used to cover registrations whose startup fs event is lost.
test('initial census discovers a durable sibling without a new filesystem event', async () => {
  const f = await fixture(true);
  try {
    await pause(350);
    expect(f.registry.getLivePorts()).toEqual([20050]);
    expect(f.errors).toEqual([]);
    expect(
      f.broadcasts,
      'initial successful arm reconciles existing live sibling state',
    ).toHaveLength(1);
    expect(f.broadcasts[0]?.type).toBe('session_list_response');
  } finally {
    f.dispose();
  }
});
