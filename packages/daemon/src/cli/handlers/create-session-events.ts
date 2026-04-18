/**
 * sharedEvents handler for spawning a new daemon:
 *   onCreateSessionRequest, find a free port, spawn a child remi daemon
 *     with the parent's flags, and acknowledge with its session id + port.
 *
 * One session per daemon is a hard invariant, so "create session" always
 * means "spawn a new daemon process". The in-flight `spawningPorts` set
 * is shared with the parent cli.ts (written by this handler, read by the
 * daemon-mode startup path) to prevent a TOCTOU race where two concurrent
 * create requests race for the same free port.
 */

import { createCreateSessionResponse, errorToString } from '@remi/shared';
import type { UUID } from '@remi/shared';

import type { SessionRegistryFile } from '../../session/index.ts';
import { findAvailableTcpPort as defaultFindAvailableTcpPort } from '../../session/port-utils.ts';
import { spawnRemiDaemon as defaultSpawnRemiDaemon } from '../daemon-manager.ts';
import { log, logError } from '../logger.ts';
import type { SendToConnection } from './trivial-events.ts';

export interface SpawnResult {
  readonly sessionId: string;
  readonly port: number;
  readonly pid: number;
}

export interface CreateSessionHandlerDeps {
  liveSessionsRegistry: SessionRegistryFile;
  /** In-flight spawn ports; shared with cli.ts daemon-mode startup. */
  spawningPorts: Set<number>;
  /** Range start for port probing (from remiConfig.daemon.base_port). */
  basePort: number;
  portRange: number;
  /**
   * CLI flags inherited by the spawned child so it has matching config.
   * Getter so the caller can populate the array after handler construction
   * (bindHost in cli.ts is declared after sharedEvents is wired up).
   */
  inheritedArgs: () => readonly string[];
  send: SendToConnection;
  /** Injectable for tests; defaults to the real port probe. */
  findAvailableTcpPort?: typeof defaultFindAvailableTcpPort;
  /** Injectable for tests; defaults to the real daemon spawner. */
  spawnDaemon?: (
    port: number,
    directory: string | undefined,
    extraArgs: string[],
  ) => Promise<SpawnResult>;
}

export type CreateSessionHandlers = ReturnType<typeof createCreateSessionHandlers>;

export function createCreateSessionHandlers(deps: CreateSessionHandlerDeps) {
  const {
    liveSessionsRegistry,
    spawningPorts,
    basePort,
    portRange,
    inheritedArgs,
    send,
    findAvailableTcpPort = defaultFindAvailableTcpPort,
    spawnDaemon = defaultSpawnRemiDaemon,
  } = deps;

  return {
    onCreateSessionRequest: async (
      connectionId: UUID,
      directory: string | undefined,
      requestId: UUID,
    ): Promise<void> => {
      log(`Create session request from ${connectionId}, spawning new daemon`);

      try {
        // Include in-flight spawn ports to prevent a TOCTOU race on
        // concurrent create requests.
        const liveUsed = new Set([
          ...liveSessionsRegistry.listLive().map((e) => e.wsPort),
          ...spawningPorts,
        ]);
        const freePort = await findAvailableTcpPort(basePort, portRange, liveUsed);
        if (freePort === null) {
          const rangeEnd = basePort + portRange - 1;
          send(
            connectionId,
            createCreateSessionResponse(
              false,
              requestId,
              undefined,
              `All ports in range ${basePort}-${rangeEnd} are in use.`,
            ),
          );
          return;
        }

        log(`Spawning new daemon on port ${freePort} for directory ${directory || '(cwd)'}`);
        spawningPorts.add(freePort);
        try {
          const result = await spawnDaemon(freePort, directory, [...inheritedArgs()]);
          send(
            connectionId,
            createCreateSessionResponse(
              true,
              requestId,
              result.sessionId as UUID,
              undefined,
              result.port,
            ),
          );
          log(
            `New daemon spawned: port=${result.port}, session=${result.sessionId}, pid=${result.pid}`,
          );
        } finally {
          spawningPorts.delete(freePort);
        }
      } catch (err) {
        const msg = errorToString(err);
        logError(`Failed to spawn daemon: ${msg}`);
        send(connectionId, createCreateSessionResponse(false, requestId, undefined, msg));
      }
    },
  };
}
