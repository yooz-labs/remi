/**
 * Small, self-contained sharedEvents handlers that operate on isolated pieces
 * of daemon state. Each handler has a single input/output surface and no
 * cross-handler coupling, which is why they extract cleanly as a group.
 */

import { createSessionHistoryResponse, errorToString } from '@remi/shared';
import type { ProtocolMessage, UUID } from '@remi/shared';

import type { SessionRegistry, SessionStore } from '../../session/index.ts';
import { log, logError } from '../logger.ts';
import { getRecentDirectories } from '../recent-client.ts';

export interface DeviceTokenEntry {
  token: string;
  platform: string;
  registeredAt: number;
  connectionId: UUID;
}

export type SendToConnection = (connectionId: UUID, message: ProtocolMessage) => boolean;

export interface TrivialHandlerDeps {
  deviceTokens: Map<string, DeviceTokenEntry>;
  sessionStore: SessionStore;
  sessionRegistry: SessionRegistry;
  send: SendToConnection;
}

export type TrivialHandlers = ReturnType<typeof createTrivialHandlers>;

export function createTrivialHandlers(deps: TrivialHandlerDeps) {
  const { deviceTokens, sessionStore, sessionRegistry, send } = deps;

  return {
    onRegisterDeviceToken: (connectionId: UUID, token: string, platform: string): void => {
      log(`Device token registered from ${connectionId}: ${token.slice(0, 20)}... (${platform})`);
      // Dedup (#585, P7): the map is already keyed by token, so re-registering an
      // identical token collapses to one entry (no duplicate push). The remaining
      // duplicate-push case is APNS token ROTATION — the same physical device
      // hands the daemon a NEW token while the old one is still registered, so a
      // push fans out to BOTH (the user's reported 2x). The connection that
      // re-registers is the same client session, so prune any OTHER token
      // previously registered from THIS connectionId before recording the new one.
      // This is conservative: it only drops a stale token tied to the same client,
      // never a genuinely distinct device on another connection.
      for (const [existingToken, entry] of deviceTokens) {
        if (existingToken !== token && entry.connectionId === connectionId) {
          deviceTokens.delete(existingToken);
          log(
            `Pruned stale device token from ${connectionId} (rotated): ${existingToken.slice(0, 20)}...`,
          );
        }
      }
      deviceTokens.set(token, { token, platform, registeredAt: Date.now(), connectionId });
    },

    onSessionHistoryRequest: (
      connectionId: UUID,
      requestId: UUID,
      limit: number | undefined,
    ): void => {
      log(`Session history request from ${connectionId}, limit: ${limit ?? 'default'}`);
      try {
        const clampedLimit = Math.max(1, limit ?? 20);
        const directories = getRecentDirectories(sessionStore, clampedLimit);
        send(connectionId, createSessionHistoryResponse(directories, requestId));
      } catch (err) {
        log(`Failed to get recent directories: ${errorToString(err)}`);
        send(connectionId, createSessionHistoryResponse([], requestId));
      }
    },

    onTerminalResize: (connectionId: UUID, cols: number, rows: number): void => {
      const session = sessionRegistry.getSessionForConnection(connectionId);
      if (!session) {
        log(`Terminal resize ignored: no session for connection ${connectionId}`);
        return;
      }
      try {
        session.pty.resize({ cols, rows });
      } catch (err) {
        log(`Failed to resize PTY for connection ${connectionId}: ${errorToString(err)}`);
      }
    },

    onError: (connectionId: UUID, error: Error): void => {
      logError(`Error from ${connectionId}:`, error);
    },
  };
}
