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

  test('broadcasts once when a sibling registers, carrying its port', async () => {
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

      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(errors).toEqual([]);
      expect(broadcasts).toHaveLength(1);
      const msg = broadcasts[0] as unknown as { type: string; daemonPorts?: readonly number[] };
      expect(msg.type).toBe('session_list_response');
      expect(msg.daemonPorts).toContain(20050);
    } finally {
      closer();
    }
  });

  test('onDirChange fires on every flush, including removals that broadcast nothing (#650)', async () => {
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
      await new Promise((resolve) => setTimeout(resolve, 150));
      const afterRegister = dirChanges;
      expect(afterRegister).toBeGreaterThanOrEqual(1);

      registry.unregister(entry.sessionId);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(dirChanges).toBeGreaterThan(afterRegister);
      // The whole point: the census hook fired even though no
      // session_list_response was broadcast.
      expect(broadcasts).toHaveLength(0);
    } finally {
      closer();
    }
  });

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

  test('a collect that throws is caught: logError called, no crash, no broadcast', async () => {
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

      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(broadcasts).toEqual([]);
      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(errors[0]).toContain('collect exploded');
    } finally {
      closer();
    }
  });
});
