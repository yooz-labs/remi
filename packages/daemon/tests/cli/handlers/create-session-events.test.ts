import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProtocolMessage, UUID } from '@remi/shared';
import {
  type SpawnResult,
  createCreateSessionHandlers,
} from '../../../src/cli/handlers/create-session-events.ts';
import { __resetLoggerForTests, configureLogger } from '../../../src/cli/logger.ts';
import { DEFAULT_CONFIG } from '../../../src/config/config.ts';
import { HarnessRegistry } from '../../../src/harness/registry.ts';
import { findAvailableTcpPort as actualPortProbe } from '../../../src/session/port-utils.ts';
import { SessionRegistryFile } from '../../../src/session/session-registry-file.ts';
import { occupyPort, reserveRange } from '../../session/port-test-helpers.ts';

const CID = 'conn0000-0000-0000-0000-000000000000' as UUID;
const REQ = 'req00000-0000-0000-0000-000000000000' as UUID;
/** No harness is named in these tests (a plain request), so none is offered. */
const harnesses = new HarnessRegistry({});

describe('createCreateSessionHandlers', () => {
  let tmpDir: string;
  let liveSessionsRegistry: SessionRegistryFile;
  let spawningPorts: Set<number>;
  let sendCalls: Array<{ connectionId: UUID; message: ProtocolMessage }>;

  function send(connectionId: UUID, message: ProtocolMessage): boolean {
    sendCalls.push({ connectionId, message });
    return true;
  }

  type PortFinder = NonNullable<
    Parameters<typeof createCreateSessionHandlers>[0]['findAvailableTcpPort']
  >;
  type ChildStarter = NonNullable<Parameters<typeof createCreateSessionHandlers>[0]['spawnDaemon']>;

  function makeHandler(
    basePort: number,
    portRange: number,
    spawnDaemon: ChildStarter,
    findAvailableTcpPort?: PortFinder,
  ) {
    return createCreateSessionHandlers({
      harnesses,
      liveSessionsRegistry,
      spawningPorts,
      basePort,
      portRange,
      bindHost: DEFAULT_CONFIG.daemon.bind,
      inheritedArgs: () => [],
      send,
      ...(findAvailableTcpPort === undefined ? {} : { findAvailableTcpPort }),
      spawnDaemon,
    });
  }

  function resultFor(port: number, index: number): SpawnResult {
    return {
      sessionId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      port,
      pid: process.pid,
    };
  }

  function recordingStarter(ports: number[]): ChildStarter {
    // The existing child-starter seam records the reservation; the hub test covers real listeners.
    return async (port) => {
      ports.push(port);
      return resultFor(port, ports.length);
    };
  }

  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-create-session-'));
    liveSessionsRegistry = new SessionRegistryFile(tmpDir);
    spawningPorts = new Set();
    sendCalls = [];
    configureLogger({ writeLog: () => {} });
  });

  afterEach(() => {
    __resetLoggerForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('responds with failure when no free port is available', async () => {
    const handlers = createCreateSessionHandlers({
      harnesses,
      liveSessionsRegistry,
      spawningPorts,
      basePort: 20000,
      portRange: 3,
      bindHost: '0.0.0.0',
      inheritedArgs: () => [],
      send,
      findAvailableTcpPort: async () => null,
      spawnDaemon: async () => {
        throw new Error('spawnDaemon should not be called when no free port');
      },
    });

    await handlers.onCreateSessionRequest(CID, undefined, REQ);

    expect(sendCalls).toHaveLength(1);
    const msg = sendCalls[0]?.message as { type: string; success: boolean; error?: string };
    expect(msg.type).toBe('create_session_response');
    expect(msg.success).toBe(false);
    expect(msg.error).toContain('20000-20002');
    expect(spawningPorts.size).toBe(0);
  });

  test('spawns a daemon and returns session info on success', async () => {
    const spawnHistory: Array<{
      port: number;
      directory: string | undefined;
      extraArgs: string[];
    }> = [];
    const handlers = createCreateSessionHandlers({
      harnesses,
      liveSessionsRegistry,
      spawningPorts,
      basePort: 20000,
      portRange: 10,
      bindHost: '0.0.0.0',
      inheritedArgs: () => ['--auth', '--bind', '0.0.0.0'],
      send,
      findAvailableTcpPort: async () => 20005,
      spawnDaemon: async (port, directory, extraArgs) => {
        spawnHistory.push({ port, directory, extraArgs });
        return {
          sessionId: '55555555-5555-5555-5555-555555555555',
          port,
          pid: 99999,
        } satisfies SpawnResult;
      },
    });

    await handlers.onCreateSessionRequest(CID, '/tmp/project', REQ);

    expect(sendCalls).toHaveLength(1);
    const msg = sendCalls[0]?.message as unknown as {
      type: string;
      success: boolean;
      sessionId?: string;
      port?: number;
    };
    expect(msg.type).toBe('create_session_response');
    expect(msg.success).toBe(true);
    expect(msg.sessionId).toBe('55555555-5555-5555-5555-555555555555');
    expect(msg.port).toBe(20005);
    expect(spawnHistory).toEqual([
      {
        port: 20005,
        directory: '/tmp/project',
        extraArgs: ['--auth', '--bind', '0.0.0.0', '--harness', 'claude'],
      },
    ]);
    // Spawn port should be released from the in-flight set.
    expect(spawningPorts.has(20005)).toBe(false);
  });

  test('maps a missing directory to the home directory, not the hub cwd (#1025)', async () => {
    const spawnHistory: Array<string | undefined> = [];
    const handlers = createCreateSessionHandlers({
      harnesses,
      liveSessionsRegistry,
      spawningPorts,
      basePort: 20000,
      portRange: 10,
      bindHost: '0.0.0.0',
      inheritedArgs: () => [],
      send,
      findAvailableTcpPort: async () => 20008,
      spawnDaemon: async (port, directory) => {
        spawnHistory.push(directory);
        return { sessionId: 's', port, pid: 1 };
      },
    });

    await handlers.onCreateSessionRequest(CID, undefined, REQ);
    await handlers.onCreateSessionRequest(CID, '', REQ);
    await handlers.onCreateSessionRequest(CID, '   ', REQ);

    expect(spawnHistory).toEqual([os.homedir(), os.homedir(), os.homedir()]);
  });

  test('reserves the port during spawn then releases it', async () => {
    let sawReservedDuringSpawn = false;
    const handlers = createCreateSessionHandlers({
      harnesses,
      liveSessionsRegistry,
      spawningPorts,
      basePort: 20000,
      portRange: 10,
      bindHost: '0.0.0.0',
      inheritedArgs: () => [],
      send,
      findAvailableTcpPort: async () => 20006,
      spawnDaemon: async (port) => {
        // Observed during the spawn: port must be in the set.
        sawReservedDuringSpawn = spawningPorts.has(port);
        return { sessionId: 's', port, pid: 1 };
      },
    });

    await handlers.onCreateSessionRequest(CID, undefined, REQ);

    expect(sawReservedDuringSpawn).toBe(true);
    expect(spawningPorts.has(20006)).toBe(false);
  });

  test('releases the reservation even if spawn throws, responds with failure', async () => {
    const handlers = createCreateSessionHandlers({
      harnesses,
      liveSessionsRegistry,
      spawningPorts,
      basePort: 20000,
      portRange: 10,
      bindHost: '0.0.0.0',
      inheritedArgs: () => [],
      send,
      findAvailableTcpPort: async () => 20007,
      spawnDaemon: async () => {
        throw new Error('daemon crashed during spawn');
      },
    });

    await handlers.onCreateSessionRequest(CID, undefined, REQ);

    expect(sendCalls).toHaveLength(1);
    const msg = sendCalls[0]?.message as { type: string; success: boolean; error?: string };
    expect(msg.type).toBe('create_session_response');
    expect(msg.success).toBe(false);
    // A client is told only that the session could not be started: the failure itself (a path, a
    // pid, a log file) goes to the host's log (G8), so the text of the thrown error is not here.
    expect(msg.error).toContain('could not be started');
    expect(msg.error).not.toContain('daemon crashed during spawn');
    // Critical: the try/finally around spawningPorts.add/delete MUST run even
    // on throw, or concurrent create requests would skip this port forever.
    expect(spawningPorts.has(20007)).toBe(false);
  });

  test('feeds live registry ports + in-flight spawns into findAvailableTcpPort to prevent TOCTOU', async () => {
    // Pre-register a live session so listLive returns a non-empty set.
    liveSessionsRegistry.register({
      sessionId: '0a001234-1234-1234-1234-123456789012',
      wsPort: 20001,
      pid: process.pid,
      hookPort: 0,
      projectPath: tmpDir,
      name: 'sibling',
      startedAt: new Date().toISOString(),
    });
    spawningPorts.add(20002);

    let usedPortsSeen: number[] = [];
    const handlers = createCreateSessionHandlers({
      harnesses,
      liveSessionsRegistry,
      spawningPorts,
      basePort: 20000,
      portRange: 10,
      bindHost: '0.0.0.0',
      inheritedArgs: () => [],
      send,
      findAvailableTcpPort: async (_base, _range, used) => {
        usedPortsSeen = [...(used ?? new Set<number>())].sort((a, b) => a - b);
        return 20009;
      },
      spawnDaemon: async (port) => ({ sessionId: 's', port, pid: 1 }),
    });

    await handlers.onCreateSessionRequest(CID, undefined, REQ);

    // Both the live-registry port and the in-flight spawn port must be in the
    // usedPorts set passed to the port probe.
    expect(usedPortsSeen).toContain(20001);
    expect(usedPortsSeen).toContain(20002);
  });

  test('concurrent starts reserve distinct ports after real probes (#1213 controlled schedule)', async () => {
    const bindHost = DEFAULT_CONFIG.daemon.bind;
    const basePort = await reserveRange(2, 50, bindHost);
    const firstProbeFinished = deferred();
    let probeCalls = 0;
    const delayedRealProbe: PortFinder = async (base, range, used, host) => {
      if (probeCalls++ === 0) {
        // The real bind-and-close probe has finished before the first selection waits here.
        const port = await actualPortProbe(base, range, used, host);
        firstProbeFinished.resolve();
        await Bun.sleep(50);
        return port;
      }
      // Start the second real probe after the first socket is closed, but before its caller adds
      // the result to spawningPorts. This controls only scheduling, never port availability.
      await firstProbeFinished.promise;
      return actualPortProbe(base, range, used, host);
    };
    const reservedPorts: number[] = [];
    const handlers = makeHandler(basePort, 2, recordingStarter(reservedPorts), delayedRealProbe);

    const outcomes = await Promise.all([
      handlers.startSession(tmpDir),
      handlers.startSession(tmpDir),
    ]);

    expect(outcomes.map((outcome) => outcome.ok)).toEqual([true, true]);
    // Without the selector queue, both live-port snapshots can choose basePort after this delay.
    expect(reservedPorts).toEqual([basePort, basePort + 1]);
    expect(spawningPorts.size).toBe(0);
  });

  test('null and thrown real probes release the selector (#1213)', async () => {
    const bindHost = DEFAULT_CONFIG.daemon.bind;
    const basePort = await reserveRange(2, 50, bindHost);
    const holders: Array<Awaited<ReturnType<typeof occupyPort>>> = [];
    let throwAfterProbe = false;
    const realProbeThenThrow: PortFinder = async (base, range, used, host) => {
      const port = await actualPortProbe(base, range, used, host);
      if (throwAfterProbe) {
        throwAfterProbe = false;
        throw new Error('controlled wrapper failure after the real probe');
      }
      return port;
    };
    const reservedPorts: number[] = [];
    const handlers = makeHandler(basePort, 2, recordingStarter(reservedPorts), realProbeThenThrow);

    try {
      holders.push(await occupyPort(basePort, bindHost));
      holders.push(await occupyPort(basePort + 1, bindHost));
      expect((await handlers.startSession(tmpDir)).ok).toBe(false);
    } finally {
      await Promise.all(
        holders.map((holder) => new Promise<void>((resolve) => holder.close(() => resolve()))),
      );
    }

    throwAfterProbe = true;
    expect((await handlers.startSession(tmpDir)).ok).toBe(false);
    const outcome = await Promise.race([
      handlers.startSession(tmpDir),
      Bun.sleep(2000).then(() => {
        throw new Error('selection did not recover after a null or thrown probe');
      }),
    ]);
    expect(outcome.ok).toBe(true);
    expect(reservedPorts).toEqual([basePort]);
  });

  test('port selection releases before a slow child start (#1213)', async () => {
    const basePort = await reserveRange(2, 50, DEFAULT_CONFIG.daemon.bind);
    const firstEntered = deferred();
    const secondEntered = deferred();
    const firstSpawnGate = deferred();
    const reservedPorts: number[] = [];
    const handlers = makeHandler(basePort, 2, async (port) => {
      reservedPorts.push(port);
      if (reservedPorts.length === 1) {
        firstEntered.resolve();
        await firstSpawnGate.promise;
      } else if (reservedPorts.length === 2) {
        secondEntered.resolve();
      }
      return resultFor(port, reservedPorts.length);
    });
    const starts: Array<ReturnType<typeof handlers.startSession>> = [];
    let secondStartedBeforeRelease = false;

    try {
      starts.push(handlers.startSession(tmpDir));
      await Promise.race([
        firstEntered.promise,
        Bun.sleep(2000).then(() => {
          throw new Error('first child start did not begin');
        }),
      ]);
      starts.push(handlers.startSession(tmpDir));
      secondStartedBeforeRelease = await Promise.race([
        secondEntered.promise.then(() => true),
        Bun.sleep(1000).then(() => false),
      ]);
    } finally {
      firstSpawnGate.resolve();
      await Promise.allSettled(starts);
    }

    expect(secondStartedBeforeRelease).toBe(true);
    expect(
      await Promise.all(starts).then((outcomes) => outcomes.map((outcome) => outcome.ok)),
    ).toEqual([true, true]);
    expect(reservedPorts).toEqual([basePort, basePort + 1]);
  });
});
