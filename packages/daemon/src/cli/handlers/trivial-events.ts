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
  /**
   * Register a device token (epic #603 Phase 6). The `DeviceTokenStore` owns the
   * map: it does the #585 rotation prune (a re-registration from the same
   * connection drops that connection's OTHER, now-rotated token) and persists.
   */
  registerDeviceToken: (token: string, platform: string, connectionId: UUID) => void;
  /**
   * Unregister a device token (#690) — the store deletes it and marks it
   * `removed` so a concurrent daemon's stale copy is not re-adopted. Fires
   * ONLY from an explicit user-removal action (web `handleDisconnect` /
   * `handleDisconnectAll`), never from a mere disconnect or app suspension.
   */
  unregisterDeviceToken: (token: string) => void;
  sessionStore: SessionStore;
  sessionRegistry: SessionRegistry;
  send: SendToConnection;
}

export type TrivialHandlers = ReturnType<typeof createTrivialHandlers>;

export function createTrivialHandlers(deps: TrivialHandlerDeps) {
  const { registerDeviceToken, unregisterDeviceToken, sessionStore, sessionRegistry, send } = deps;

  return {
    onRegisterDeviceToken: (connectionId: UUID, token: string, platform: string): void => {
      log(`Device token registered from ${connectionId}: ${token.slice(0, 20)}... (${platform})`);
      registerDeviceToken(token, platform, connectionId);
    },

    onUnregisterDeviceToken: (connectionId: UUID, token: string): void => {
      log(`Device token unregistered from ${connectionId}: ${token.slice(0, 20)}...`);
      unregisterDeviceToken(token);
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
