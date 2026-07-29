/**
 * Unified inbound (client-to-daemon) dispatch (#899, C6 of epic #883).
 *
 * Before this, `connection.ts` (direct WebSocket) and `relay-adapter.ts`
 * (signaling relay) each hand-rolled their own switch over `message.type`,
 * with different validation styles: `connection.ts` trusted the type system
 * after `deserialize`/`isValidMessage` (envelope-only checks — type, id,
 * timestamp); `relay-adapter.ts` reimplemented routing over
 * `Record<string, unknown>` with ad-hoc `typeof` checks per field. Both
 * switches did the same job. This module is the single place that does it,
 * built on the `MessageHandlers`/`dispatchMessage` mechanism from #895/#896.
 *
 * `ClientMessageHandlers` is total over {@link ClientToDaemonType} — omitting
 * a key is a compile error, not a silent drop. Both call sites build their
 * own handler map (closures over their own event bag), because
 * `ConnectionEvents` (no `connectionId` — one `Connection` instance per
 * peer) and `AdapterEvents` (`connectionId` as the first arg — one
 * `RelayAdapter` instance can in principle serve several) are genuinely
 * different shapes. Collapsing THAT is C7 (#900), deliberately out of scope
 * here — this module only kills the duplicate routing/validation, not the
 * event-interface duplication.
 */
import {
  type ClientToDaemonType,
  type MessageHandlers,
  type ProtocolMessage,
  dispatchMessage,
} from '@remi/shared';

/** Total handler map over every client-to-daemon message type (#899). */
export type ClientMessageHandlers = MessageHandlers<ClientToDaemonType, void>;

/**
 * Routes `msg` to the handler registered for its type in `handlers`.
 *
 * Returns `false` when `msg.type` is not a key of `handlers` at all — either
 * a `d2c`-only type arriving inbound (a confused/malicious client) or a type
 * this build's registry doesn't recognize. Callers decide how to report that
 * (`connection.ts` sends `UNKNOWN_MESSAGE`; `relay-adapter.ts` sends
 * `UNSUPPORTED` naming the type) rather than this function picking one wire
 * shape for both transports.
 */
export function routeClientMessage(msg: ProtocolMessage, handlers: ClientMessageHandlers): boolean {
  if (!Object.prototype.hasOwnProperty.call(handlers, msg.type)) {
    return false;
  }
  // `msg.type` was just proven, at runtime, to be a key of `handlers` — whose
  // type is `MessageHandlers<ClientToDaemonType>`. TypeScript's control-flow
  // analysis cannot express that narrowing for a generic union plus an
  // `Object.prototype.hasOwnProperty` check, so this cast documents a
  // runtime-proven invariant rather than assuming one.
  dispatchMessage(msg as Extract<ProtocolMessage, { type: ClientToDaemonType }>, handlers);
  return true;
}
