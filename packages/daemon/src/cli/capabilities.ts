/**
 * The capabilities this daemon lists on every `hello_ack` (#1237, ADR 0035).
 *
 * A capability names an additive feature a client cannot see in the messages
 * themselves, such as a request field an older daemon would ignore. Each name
 * must be documented in `PROTOCOL_CAPABILITIES` (`@remi/shared`), which a test
 * holds this list to, and is added here by the change that ships its feature.
 * Empty since #1237: everything a daemon did before is the baseline of protocol
 * version 1.
 */
export const DAEMON_CAPABILITIES: readonly string[] = [];
