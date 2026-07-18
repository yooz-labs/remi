/**
 * Fan-out for PTY-originated messages (#795).
 *
 * `createNewSession`'s `sendMessage` callback used to special-case
 * `raw_pty_output`: send it only to the single exclusive `activeConnectionId`,
 * then broadcast every OTHER message type to all connections. Now that any
 * number of connections can be attached at once, `raw_pty_output` is instead
 * sent directly to every currently ATTACHED connection (it is high-volume, so
 * still not broadcast to query-mode utility clients); every other message
 * type keeps going through the ordinary adapter broadcast, unchanged.
 *
 * Shared by both daemon-mode and wrapper-mode session creation in cli.ts so
 * the fan-out logic (and its tests) live in one place.
 */

import type { ProtocolMessage, UUID } from '@remi/shared';
import type { SessionRegistry } from '../../session/index.ts';

export interface PtyMessageFanoutDeps {
  sessionRegistry: SessionRegistry;
  /** Send to one connection directly (e.g. registry.sendRaw). */
  sendToConnection: (connectionId: UUID, message: ProtocolMessage) => boolean;
  /** Send to every connected client (e.g. registry.broadcast). */
  broadcast: (message: ProtocolMessage) => void;
}

export type PtyMessageFanout = (sessionId: UUID, message: ProtocolMessage) => void;

export function createPtyMessageFanout(deps: PtyMessageFanoutDeps): PtyMessageFanout {
  const { sessionRegistry, sendToConnection, broadcast } = deps;

  return (sessionId, message) => {
    if (message.type === 'raw_pty_output') {
      const session = sessionRegistry.getSession(sessionId);
      if (!session) return;
      for (const connectionId of session.attachedConnections) {
        sendToConnection(connectionId, message);
      }
      return;
    }
    broadcast(message);
  };
}
