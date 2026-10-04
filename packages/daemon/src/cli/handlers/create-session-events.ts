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

import {
  createCreateSessionResponse,
  errorToString,
  escapeUnsafeText,
  isHarnessId,
} from '@remi/shared';
import type { UUID } from '@remi/shared';

import type { HarnessRegistry, StartedSession } from '../../harness/registry.ts';
import type { CreateSessionExtra } from '../../server/client-message-events.ts';
import type { SessionRegistryFile } from '../../session/index.ts';
import { findAvailableTcpPort as defaultFindAvailableTcpPort } from '../../session/port-utils.ts';
import { spawnRemiDaemon as defaultSpawnRemiDaemon } from '../daemon-manager.ts';
import { log, logError } from '../logger.ts';
import { resolveRequestedSessionDirectory } from '../path-resolver.ts';
import type { SendToConnection } from './trivial-events.ts';

export interface SpawnResult {
  readonly sessionId: string;
  readonly port: number;
  readonly pid: number;
}

/** What a requester is told when the child could not be started: the cause is in the host's log (G8). */
const START_FAILED_TEXT =
  "The session could not be started on the host; the host's remi log has the reason.";
const INVALID_DIRECTORY_TEXT = 'Invalid directory; the request was not started.';

/**
 * Why a requested directory is refused, or null (#1179 review, G7). The directory reaches the
 * child as the value of `--dir`: one that starts with a hyphen is left unconsumed by the child's
 * parser and read as a flag (`--no-auth`), and one with a NUL cannot be an argument at all. The
 * wire carries whatever JSON the peer sent, so a value that is not a string is refused too, not
 * left to throw. No directory, an empty one and white space all mean home. The refusal names no
 * part of the value. It covers every create request, Claude's included: no real client sends such
 * a value, so nothing a person does changes.
 */
export function directoryRefusal(directory: unknown): string | null {
  if (directory === undefined) return null;
  if (typeof directory !== 'string') return INVALID_DIRECTORY_TEXT;
  if (directory.trim().startsWith('-') || /[\0\n\r]/.test(directory)) {
    return INVALID_DIRECTORY_TEXT;
  }
  return null;
}

/**
 * What a create request may ask of a harness, checked before a port is probed or anything is
 * spawned (#1179): the harness must be one this build has an adapter for whose command resolves
 * on PATH, its `args` must pass that harness's remote allowlist, and nothing may stand in the way
 * of a launch (the older-daemon gate, for Codex). On success, the arguments to append to the
 * child's command line: `--harness <id>` and then `-- <args>`, last, so no remote argument can be
 * read as a remi flag (`--no-auth`). A request that names no harness spawns Claude exactly as it
 * always did, with nothing appended unless it brought `args`. `noticeFor` builds what a success
 * does not say for a harness that may stop at a prompt nobody can answer headless, once the spawn
 * has said which session and port it started. A refusal's `error` is for the client; its `detail`,
 * when there is one, is the host-local reason only the log gets.
 */
export function checkHarnessRequest(
  registry: HarnessRegistry,
  extra: CreateSessionExtra | undefined,
):
  | { ok: true; spawnArgs: string[]; noticeFor?: (session: StartedSession) => string }
  | { ok: false; error: string; detail?: string } {
  const { harness, args } = extra ?? {};
  if (harness === undefined && args === undefined) return { ok: true, spawnArgs: [] };

  if (harness !== undefined && !isHarnessId(harness)) {
    return { ok: false, error: 'Unknown harness; the request was not started.' };
  }
  const id = harness ?? 'claude';
  const spec = registry.get(id);
  if (spec === undefined) {
    return { ok: false, error: `This remi has no ${id} adapter; the request was not started.` };
  }
  // A request that names no harness keeps Claude's old behavior, a spawn that fails inside the
  // child if there is no `claude`; one that names a harness is held to what is installed.
  if (harness !== undefined && !registry.available().includes(id)) {
    return {
      ok: false,
      error: `${id} is not available on this machine (no ${spec.command} on the daemon's PATH); nothing was started.`,
    };
  }
  const checked = spec.validateRemoteArgs(args ?? []);
  if (!checked.ok) return { ok: false, error: checked.error };
  if (harness !== undefined) {
    const refusal =
      spec.launchRefusal?.({
        args: checked.args,
        resumeThreadId: checked.resumeThreadId ?? null,
      }) ?? null;
    if (refusal !== null) return { ok: false, error: refusal.client, detail: refusal.detail };
  }
  return {
    ok: true,
    spawnArgs: [
      ...(harness !== undefined ? ['--harness', id] : []),
      ...(checked.args.length > 0 ? ['--', ...checked.args] : []),
    ],
    ...(spec.headlessNotice !== undefined && { noticeFor: spec.headlessNotice }),
  };
}

export interface CreateSessionHandlerDeps {
  /** The harnesses a request may name, and what each allows (`cli.ts` builds it). */
  harnesses: HarnessRegistry;
  liveSessionsRegistry: SessionRegistryFile;
  /** In-flight spawn ports; shared with cli.ts daemon-mode startup. */
  spawningPorts: Set<number>;
  /** Range start for port probing (from remiConfig.daemon.base_port). */
  basePort: number;
  portRange: number;
  /**
   * The host the spawned child will listen on -- the hub forwards its own
   * `--bind` to every child, so this is the hub's bind host. The port probe
   * must use it: probing a different host reports "free" for a port the child
   * then fails to bind (#880).
   */
  bindHost: string;
  /**
   * CLI flags inherited by the spawned child so it has matching config.
   * Getter so the caller can populate the array after handler construction.
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
    harnesses,
    liveSessionsRegistry,
    spawningPorts,
    basePort,
    portRange,
    bindHost,
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
      extra?: CreateSessionExtra,
    ): Promise<void> => {
      log(`Create session request from ${connectionId}, spawning new daemon`);

      try {
        // The trust boundary (#1179): refuse before a port is chosen or anything is spawned.
        // The client gets a short text; the host's log gets the reason, escaped (the arguments in
        // it came off the wire).
        const badDirectory = directoryRefusal(directory);
        if (badDirectory !== null) {
          log('Create session request refused: the directory is not acceptable; nothing spawned');
          send(
            connectionId,
            createCreateSessionResponse(false, requestId, undefined, badDirectory),
          );
          return;
        }
        const request = checkHarnessRequest(harnesses, extra);
        if (!request.ok) {
          log(
            `Create session request refused: ${escapeUnsafeText(request.detail ?? request.error)}; nothing spawned`,
          );
          send(
            connectionId,
            createCreateSessionResponse(false, requestId, undefined, request.error),
          );
          return;
        }

        // Include in-flight spawn ports to prevent a TOCTOU race on
        // concurrent create requests.
        const liveUsed = new Set([
          ...liveSessionsRegistry.listLive().map((e) => e.wsPort),
          ...spawningPorts,
        ]);
        const freePort = await findAvailableTcpPort(basePort, portRange, liveUsed, bindHost);
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

        // #1025: no/empty/whitespace directory means "home", never the
        // hub's own cwd (an accident of where `remi serve` was started) —
        // see resolveRequestedSessionDirectory for the full rationale.
        const resolvedDirectory = resolveRequestedSessionDirectory(directory);
        log(`Spawning new daemon on port ${freePort} for directory ${resolvedDirectory}`);
        spawningPorts.add(freePort);
        try {
          const result = await spawnDaemon(freePort, resolvedDirectory, [
            ...inheritedArgs(),
            ...request.spawnArgs,
          ]);
          send(
            connectionId,
            createCreateSessionResponse(
              true,
              requestId,
              result.sessionId as UUID,
              undefined,
              result.port,
              request.noticeFor?.({ sessionId: result.sessionId, port: result.port }),
            ),
          );
          log(
            `New daemon spawned: port=${result.port}, session=${result.sessionId}, pid=${result.pid}`,
          );
        } finally {
          spawningPorts.delete(freePort);
        }
      } catch (err) {
        // The failure is the host's business: it can hold a path, a pid or a log file name. The
        // requester is told only that the session did not start (G8).
        logError(`Failed to spawn daemon: ${errorToString(err)}`);
        send(
          connectionId,
          createCreateSessionResponse(false, requestId, undefined, START_FAILED_TEXT),
        );
      }
    },
  };
}
