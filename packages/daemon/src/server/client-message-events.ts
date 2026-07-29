/**
 * The one declaration of the client-to-daemon per-message event contract
 * (#900, C7 of epic #883).
 *
 * Every inbound (client-to-daemon) message that reaches app code as a named
 * event -- as opposed to `hello`/`ack`/`ping`/`pong`/`auth_response`, which
 * stay protocol-only and are handled inline by `connection.ts` /
 * `route-client-message.ts` -- had its argument list declared four times:
 * `ConnectionEvents` (connection.ts), `ServerEvents` (websocket-server.ts),
 * `AdapterEvents` (connection-adapter.ts), and the shape `sharedEvents`
 * (cli.ts) is assembled to satisfy. `ClientMessageEventArgs` below is the
 * ONE place that lists each event name and its arguments; the other three
 * derive from it via `extends`.
 *
 * Deliberately NOT collapsed into a single interface used everywhere.
 * `AdapterEvents` (and `ServerEvents`, which shares its shape) must stay
 * **semantic**, keyed by event name with `connectionId` first -- one
 * adapter/server instance serves many peers, and the Telegram adapter
 * synthesizes `onUserInput` straight from chat text with no `ProtocolMessage`
 * anywhere in the path (see `telegram-adapter.ts`'s `handleTextMessage`). A
 * wire-shaped `onMessage(msg: ProtocolMessage)` contract would break that.
 * `ConnectionEvents` has NO `connectionId` -- one `Connection` instance is
 * already scoped to a single peer, and adding a redundant id there would
 * invite a future implementation to forward the wrong one. The two shapes
 * are related by simple prepending, not identical, so they stay two derived
 * types rather than one.
 *
 * Adding a new client-to-daemon event: add one key to `ClientMessageEventArgs`
 * and to `CLIENT_MESSAGE_EVENT_KEYS`. `ConnectionEvents`, `ServerEvents`, and
 * `AdapterEvents` all pick it up through `extends`; the generic forwarders
 * below (`pickClientMessageEvents`, `bindConnectionId`) require no changes,
 * and neither does `websocket-adapter.ts` (it forwards through
 * `pickClientMessageEvents`) or `websocket-server.ts`'s `handleOpen` (it
 * forwards through `bindConnectionId`). Only the real handler implementations
 * still need per-type logic: a dispatch case in `connection.ts`'s handler map
 * (mandated separately by `route-client-message.ts`, #899/C6) and a producer
 * in `cli.ts`'s `sharedEvents` assembly. That work is inherent business
 * logic, not the duplication this module removes.
 */
import type { AnswerExtras, UUID } from '@remi/shared';

/**
 * Every client-to-daemon event's argument list, WITHOUT `connectionId`.
 * `messageId` / `extra` document the #627/#681 history: optional trailing
 * args added later to carry structured AskUserQuestion answers and
 * message-id echoing without breaking existing positional callers.
 */
export interface ClientMessageEventArgs {
  /** User input received. `messageId` is the wire message's own id (#681),
   *  carried so a rejection (e.g. NOT_ACTIVE_CONNECTION) can name the
   *  specific bubble that was dropped. */
  onUserInput: [
    sessionId: UUID,
    content: string,
    raw?: boolean,
    claudeSessionId?: UUID,
    messageId?: UUID,
  ];

  /** Answer to question received. `extra` carries the structured AskUserQuestion
   *  selections / cancel flag (#627); omitted for a plain single answer. */
  onAnswer: [
    sessionId: UUID,
    questionId: UUID,
    answer: string,
    claudeSessionId?: UUID,
    extra?: AnswerExtras,
  ];

  /** Bullet expand request received. */
  onBulletExpandRequest: [sessionId: UUID, bulletId: number, requestId: UUID];

  /** Session list request received. */
  onSessionListRequest: [requestId: UUID, includeExternal: boolean];

  /** Transcript load request received. */
  onTranscriptLoadRequest: [sessionId: string, requestId: UUID];

  /** Create session request received. */
  onCreateSessionRequest: [directory: string | undefined, requestId: UUID];

  /** Terminal resize from attached CLI client. */
  onTerminalResize: [cols: number, rows: number];

  /** Kill session request received. */
  onKillSessionRequest: [sessionId: UUID, requestId: UUID];

  /** Resume session request received. */
  onResumeSessionRequest: [sessionId: string, requestId: UUID];

  /** Session history request received. */
  onSessionHistoryRequest: [requestId: UUID, limit: number | undefined];

  /** Detach session request received (tmux-style). */
  onDetachSession: [sessionId: UUID, requestId: UUID];

  /** Device token registered for push notifications. */
  onRegisterDeviceToken: [token: string, platform: 'ios' | 'android'];

  /** Device token unregistered -- explicit user removal of this server (#690). */
  onUnregisterDeviceToken: [token: string];
}

/**
 * Hand-transcribed key list, deliberately not derived from
 * `ClientMessageEventArgs` at runtime (types don't exist at runtime) -- the
 * runtime companion to the type above, in the same spirit as `GOLDEN_TYPES` /
 * `INBOUND_ROUTED` elsewhere in this epic: it drives the generic forwarders
 * below, and `client-message-events.test.ts` pins it against
 * `ClientMessageEventArgs`'s keys (via a `satisfies`-checked exhaustiveness
 * assertion) so the two cannot silently drift apart.
 */
export const CLIENT_MESSAGE_EVENT_KEYS = [
  'onUserInput',
  'onAnswer',
  'onBulletExpandRequest',
  'onSessionListRequest',
  'onTranscriptLoadRequest',
  'onCreateSessionRequest',
  'onTerminalResize',
  'onKillSessionRequest',
  'onResumeSessionRequest',
  'onSessionHistoryRequest',
  'onDetachSession',
  'onRegisterDeviceToken',
  'onUnregisterDeviceToken',
] as const satisfies readonly (keyof ClientMessageEventArgs)[];

/**
 * Compile-time proof `CLIENT_MESSAGE_EVENT_KEYS` covers EVERY key of
 * `ClientMessageEventArgs`, not just valid ones (the `satisfies` clause above
 * only rules out extra/misspelled keys, not missing ones). Without this, a
 * key added to the interface but forgotten in the array would compile clean
 * everywhere else -- `ConnectionEvents` / `ServerEvents` / `AdapterEvents`
 * all `extends` the interface directly, not this array -- but
 * `pickClientMessageEvents` / `bindConnectionId` would silently stop
 * forwarding that one event. That is exactly the silent-drop failure mode
 * this epic exists to close (see #883's "duplicated implementations drift
 * silently, and the drift is invisible" finding).
 *
 * Mapped to `true`/`false` rather than `never` for the same reason
 * `protocol.ts`'s `_DiscriminantsMatch` is: `true | never` collapses to
 * `true`, so a single missing key would be silently absorbed by the other
 * (correct) ones instead of breaking the assignment below.
 */
type _AllKeysCovered = {
  [K in keyof ClientMessageEventArgs]: K extends (typeof CLIENT_MESSAGE_EVENT_KEYS)[number]
    ? true
    : false;
}[keyof ClientMessageEventArgs];
const _allKeysCovered: true = true as _AllKeysCovered;
void _allKeysCovered;

/** `ClientMessageEventArgs` as callback signatures -- what a single
 *  `Connection` (already scoped to one peer) exposes. */
export type ClientMessageEvents = {
  [K in keyof ClientMessageEventArgs]: (...args: ClientMessageEventArgs[K]) => void;
};

/** `ClientMessageEvents` with `connectionId` prepended -- what a fan-out
 *  layer (`WebSocketServer`, any `ConnectionAdapter`) exposes, since one
 *  instance serves many peers and a consumer needs to know which one. */
export type ClientMessageEventsWithConnectionId = {
  [K in keyof ClientMessageEventArgs]: (
    connectionId: UUID,
    ...args: ClientMessageEventArgs[K]
  ) => void;
};

/**
 * Forwards the client-message-event subset of `source` unchanged onto a
 * fresh object. Used where two connectionId-prefixed event bags need every
 * per-message event passed straight through -- `ServerEvents` ->
 * `AdapterEvents` in `websocket-adapter.ts`'s `start()` -- replacing what
 * used to be 13 hand-written one-line forwarders that differed only in
 * which event name they named twice.
 *
 * Not a plain object spread: `source` (e.g. `Partial<ServerEvents>`) also
 * carries transport-lifecycle keys (`onStart`, `onClientConnect`, ...) with
 * signatures the target (`Partial<AdapterEvents>`) does not share, and a raw
 * `{ ...source }` would carry those through with the wrong shape.
 */
export function pickClientMessageEvents(
  source: Partial<ClientMessageEventsWithConnectionId>,
): Partial<ClientMessageEventsWithConnectionId> {
  const result: Partial<ClientMessageEventsWithConnectionId> = {};
  for (const key of CLIENT_MESSAGE_EVENT_KEYS) {
    const handler = source[key];
    if (handler) {
      // `key` ranges over a union of literal keys inside this loop; nothing
      // in the type system correlates "the handler read from `source[key]`"
      // with "the slot `result[key]` expects" across that union the way a
      // single fixed key would. Each iteration's `handler` is real, though:
      // it came from indexing `source` with this exact `key`, at this exact
      // `key`'s position in the target. The cast documents that
      // runtime-proven correspondence rather than assuming one blind.
      (result as Record<string, unknown>)[key] = handler;
    }
  }
  return result;
}

/**
 * Binds `connectionId` onto a connectionId-prefixed sink, producing the
 * connectionId-free shape a single `Connection` needs. Used by
 * `WebSocketServer.handleOpen` to turn its own `Partial<ServerEvents>` into
 * the `Partial<ConnectionEvents>` a `Connection` instance is constructed
 * with, replacing what used to be 13 hand-written closures that each
 * re-implemented "call the server-level handler with this connection's id
 * prepended."
 */
export function bindConnectionId(
  connectionId: UUID,
  sink: Partial<ClientMessageEventsWithConnectionId>,
): Partial<ClientMessageEvents> {
  const result: Partial<ClientMessageEvents> = {};
  for (const key of CLIENT_MESSAGE_EVENT_KEYS) {
    const handler = sink[key];
    if (handler) {
      // See `pickClientMessageEvents` above for why this needs a cast: `key`
      // ranges over a union inside the loop, and TypeScript does not
      // correlate a per-iteration `handler`'s specific member type with the
      // matching member type of `result` at that same runtime key.
      (result as Record<string, (...args: unknown[]) => void>)[key] = (...args: unknown[]) =>
        (handler as (connectionId: UUID, ...args: unknown[]) => void)(connectionId, ...args);
    }
  }
  return result;
}
