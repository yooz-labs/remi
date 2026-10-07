/**
 * The capabilities this daemon lists on every `hello_ack` (#1237, ADR 0035).
 *
 * A capability names an additive feature a client cannot see in the messages
 * themselves, such as a request field an older daemon would ignore. Each name
 * must be documented in `PROTOCOL_CAPABILITIES` (`@remi/shared`), which a test
 * holds this list to, and is added here by the change that ships its feature.
 * Nothing a daemon did before #1237 is listed: that is the baseline of protocol
 * version 1.
 *
 * - `workspaces` (#1236, ADR 0036): `create_session_request.workspace`, a session
 *   in a new worktree the daemon creates (`cli/handlers/create-session-events.ts`),
 *   and `recent_repositories_request`, the repositories of recent sessions to offer
 *   for one (`cli/handlers/recent-repositories-events.ts`).
 */
export const DAEMON_CAPABILITIES: readonly string[] = ['workspaces'];
