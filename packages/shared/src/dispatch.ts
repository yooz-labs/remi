/**
 * Total-dispatch helpers over the protocol message registry (#896).
 *
 * `MessageHandlers` requires one entry per `ProtocolMessageMap` key: a real
 * handler function, or the literal `'ignore'`. Consumers already legitimately
 * ignore most message types (attach-client suppresses `agent_output`, App
 * ignores `remi_status`) — today, forgetting a type and deciding to ignore it
 * produce identical code: nothing. Under a total map they are different:
 * ignoring is an explicit value that greps, reviews, and shows up in a diff.
 * Adding a registry key breaks every `MessageHandlers<keyof ProtocolMessageMap>`
 * consumer's compile until it decides which one that new key is.
 *
 * No consumer is migrated to these in this change (#895/#896 land the
 * mechanism only; #897/#898/#899 migrate connection.ts/App.tsx/attach-client.ts).
 */
import type { ProtocolMessage, ProtocolMessageMap } from './protocol.ts';

/**
 * A total map from every message type in `TType` to either a handler
 * function or the literal `'ignore'`. Instantiated as
 * `MessageHandlers<keyof ProtocolMessageMap, R>`, adding a key to
 * `ProtocolMessageMap` makes an existing `MessageHandlers` object missing
 * that key a compile error (`Property '<type>' is missing`).
 */
export type MessageHandlers<TType extends keyof ProtocolMessageMap, R = void> = {
  [K in TType]: ((msg: ProtocolMessageMap[K]) => R) | 'ignore';
};

/**
 * Routes `msg` to the handler registered for its `type` in `handlers`, or
 * returns `undefined` when that handler is `'ignore'`.
 */
export function dispatchMessage<TType extends keyof ProtocolMessageMap, R>(
  msg: Extract<ProtocolMessage, { type: TType }>,
  handlers: MessageHandlers<TType, R>,
): R | undefined {
  const h = handlers[msg.type as TType];
  return h === 'ignore' ? undefined : (h as (m: ProtocolMessage) => R)(msg);
}

/**
 * Exhaustiveness helper: call in the `default`/`else` branch of code that
 * switches over a discriminated union so an unhandled case is a compile
 * error (the branch's value fails to narrow to `never`) instead of a silent
 * runtime no-op. Mirrors the existing convention in
 * `packages/daemon/src/cli/cmd-daemon.ts` (`runDaemonLifecycleCommand`).
 */
export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(value)}`);
}
