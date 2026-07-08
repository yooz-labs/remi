/**
 * sharedEvents handler for resuming a previously-run Claude Code session:
 *   onResumeSessionRequest
 *
 * Three possible paths:
 *   1. The target session id is STILL LIVE in this daemon — just attach and
 *      replay history. (Covers "rejoin my own active session" after a
 *      network blip.)
 *   2. The target session id is STORED LOCALLY (Remi store or Claude
 *      transcript index) and this daemon has no active session — spawn a
 *      new PTY with `claude --resume <claudeSessionId>` in the stored
 *      project directory.
 *   3. Neither: respond with a failure.
 *
 * Spawning is delegated back to `cli.ts`'s `createNewSession` via an
 * injected dep; keeping it opaque here means we don't have to drag the
 * entire createNewSession closure (PTY + MessageAPI + transcript watcher
 * + hook setup) out of cli.ts to test this handler.
 */

import * as path from 'node:path';
import {
  createHelloAck,
  createReplayBatch,
  createResumeSessionResponse,
  errorToString,
} from '@remi/shared';
import type { ProtocolMessage, UUID } from '@remi/shared';

import type { SessionBindingStore, SessionRegistry, SessionStore } from '../../session/index.ts';
import type { TranscriptDiscovery } from '../../transcript/index.ts';
import { log, logError } from '../logger.ts';
import { resolveDirectory } from '../path-resolver.ts';
import type { SendToConnection } from './trivial-events.ts';

/**
 * Spawn a new Claude Code session in the given working directory. Mirrors
 * the signature of cli.ts's `createNewSession` for the arguments the resume
 * flow actually uses. The PTYSession return value is dropped, the caller
 * only needs the side effect (session registered in SessionRegistry).
 */
export type CreateNewSessionFn = (
  sessionId: UUID,
  workingDirectory: string,
  sendMessage: (sessionId: UUID, message: ProtocolMessage) => void,
  extraArgs: string[],
) => Promise<unknown>;

export interface ResumeSessionHandlerDeps {
  sessionRegistry: SessionRegistry;
  /** Full-record reads that also need projectPath (resume seed by remi id). */
  sessionStore: SessionStore;
  /** Binding-only reverse lookup (resolve by claude session id) — routed through
   *  the accessor so it cannot diverge from the other resume resolver. */
  bindingStore: SessionBindingStore;
  transcriptDiscovery: TranscriptDiscovery;
  createNewSession: CreateNewSessionFn;
  send: SendToConnection;
}

export type ResumeSessionHandlers = ReturnType<typeof createResumeSessionHandlers>;

export function createResumeSessionHandlers(deps: ResumeSessionHandlerDeps) {
  const {
    sessionRegistry,
    sessionStore,
    bindingStore,
    transcriptDiscovery,
    createNewSession,
    send,
  } = deps;

  return {
    onResumeSessionRequest: async (
      connectionId: UUID,
      targetSessionId: string,
      requestId: UUID,
    ): Promise<void> => {
      log(`Resume session request from ${connectionId} for session ${targetSessionId}`);

      // Path 1: target matches the live session, try to attach.
      const existingSession = sessionRegistry.getSession(targetSessionId as UUID);
      if (existingSession) {
        const result = sessionRegistry.attachConnection(targetSessionId as UUID, connectionId);
        if (result.success) {
          send(connectionId, createResumeSessionResponse(true, requestId, targetSessionId as UUID));
          send(
            connectionId,
            createHelloAck('1.0.0', targetSessionId as UUID, {
              resumeInfo: {
                isResume: true,
                replayCount: result.replayMessages.length,
                nextBulletId: result.nextBulletId,
              },
            }),
          );
          if (result.replayMessages.length > 0) {
            send(
              connectionId,
              createReplayBatch(targetSessionId as UUID, result.replayMessages, true),
            );
          }
          log(`Session ${targetSessionId} still alive; attached connection`);
          return;
        }
        send(connectionId, createResumeSessionResponse(false, requestId, undefined, result.error));
        return;
      }

      // No live session for that id. One session per daemon: if this daemon
      // already has a DIFFERENT active session, we can't spawn another here.
      if (sessionRegistry.activeSession !== null) {
        send(
          connectionId,
          createResumeSessionResponse(
            false,
            requestId,
            undefined,
            "This daemon already has an active session. Use 'remi new' to start a new daemon for resume.",
          ),
        );
        return;
      }

      // Path 2: transcript-based resume. Resolve a Claude session id + project path.
      let claudeSessionId: string | null = null;
      let projectPath: string | null = null;

      const storedByRemi = sessionStore.findByRemiSessionId(targetSessionId as UUID);
      if (storedByRemi) {
        claudeSessionId = storedByRemi.claudeSessionId;
        projectPath = storedByRemi.projectPath;
      }

      if (!claudeSessionId) {
        const storedByClaude = bindingStore.getByClaudeSessionId(targetSessionId);
        if (storedByClaude) {
          claudeSessionId = storedByClaude.claudeSessionId;
          projectPath = storedByClaude.projectPath;
        }
      }

      if (!claudeSessionId) {
        const transcriptPath = transcriptDiscovery.findTranscriptBySessionId(targetSessionId);
        if (transcriptPath) {
          claudeSessionId = targetSessionId;
          const dirName = path.basename(path.dirname(transcriptPath));
          projectPath = dirName.replace(/-/g, '/');
        }
      }

      if (!claudeSessionId) {
        send(
          connectionId,
          createResumeSessionResponse(
            false,
            requestId,
            undefined,
            `Session ${targetSessionId} not found. No Claude session ID available for resume.`,
          ),
        );
        return;
      }

      if (!projectPath) {
        send(
          connectionId,
          createResumeSessionResponse(
            false,
            requestId,
            undefined,
            'Cannot resume: original project path is unknown.',
          ),
        );
        return;
      }

      const dirResult = resolveDirectory(projectPath);
      if ('error' in dirResult) {
        const hint = projectPath.includes('/')
          ? ' Path may be inaccurate for projects with dashes in their name.'
          : '';
        send(
          connectionId,
          createResumeSessionResponse(
            false,
            requestId,
            undefined,
            `Project directory not found: ${projectPath}.${hint}`,
          ),
        );
        return;
      }
      const workingDirectory = dirResult.resolved;

      const newSessionId = sessionRegistry.createSessionId();
      log(
        `Resuming Claude session ${claudeSessionId} as new Remi session ${newSessionId} in ${workingDirectory}`,
      );

      try {
        await createNewSession(
          newSessionId,
          workingDirectory,
          (sid, msg) => {
            const session = sessionRegistry.getSession(sid);
            if (session?.activeConnectionId) {
              send(session.activeConnectionId, msg);
            }
          },
          ['--resume', claudeSessionId],
        );

        const result = sessionRegistry.attachConnection(newSessionId, connectionId);

        if (result.success) {
          send(connectionId, createResumeSessionResponse(true, requestId, newSessionId));
          send(
            connectionId,
            createHelloAck('1.0.0', newSessionId, {
              resumeInfo: { isResume: false, replayCount: 0, nextBulletId: 1 },
            }),
          );
          log(`Session ${newSessionId} created via resume (claude: ${claudeSessionId})`);
        } else {
          sessionRegistry.closeSession(newSessionId, 'forced');
          send(
            connectionId,
            createResumeSessionResponse(false, requestId, undefined, result.error),
          );
        }
      } catch (error) {
        const msg = errorToString(error);
        logError('Failed to resume session:', msg);
        sessionRegistry.closeSession(newSessionId, 'forced');
        send(connectionId, createResumeSessionResponse(false, requestId, undefined, msg));
      }
    },
  };
}
