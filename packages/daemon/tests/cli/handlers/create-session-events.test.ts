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
import { SessionRegistryFile } from '../../../src/session/session-registry-file.ts';

const CID = 'conn0000-0000-0000-0000-000000000000' as UUID;
const REQ = 'req00000-0000-0000-0000-000000000000' as UUID;

describe('createCreateSessionHandlers', () => {
  let tmpDir: string;
  let liveSessionsRegistry: SessionRegistryFile;
  let spawningPorts: Set<number>;
  let sendCalls: Array<{ connectionId: UUID; message: ProtocolMessage }>;

  function send(connectionId: UUID, message: ProtocolMessage): boolean {
    sendCalls.push({ connectionId, message });
    return true;
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
      liveSessionsRegistry,
      spawningPorts,
      basePort: 20000,
      portRange: 3,
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
      liveSessionsRegistry,
      spawningPorts,
      basePort: 20000,
      portRange: 10,
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
        extraArgs: ['--auth', '--bind', '0.0.0.0'],
      },
    ]);
    // Spawn port should be released from the in-flight set.
    expect(spawningPorts.has(20005)).toBe(false);
  });

  test('reserves the port during spawn then releases it', async () => {
    let sawReservedDuringSpawn = false;
    const handlers = createCreateSessionHandlers({
      liveSessionsRegistry,
      spawningPorts,
      basePort: 20000,
      portRange: 10,
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
      liveSessionsRegistry,
      spawningPorts,
      basePort: 20000,
      portRange: 10,
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
    expect(msg.error).toContain('daemon crashed during spawn');
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
      liveSessionsRegistry,
      spawningPorts,
      basePort: 20000,
      portRange: 10,
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
});
