/**
 * How a message tells a person to reach a session with `remi attach` (#1179 review, G11 and G12).
 *
 * A bare `remi attach` attaches the NEWEST live session on a machine, which may not be the one
 * that is stuck, so every message that points at a session names it, in the form the attach
 * command accepts (`host:port/<first eight characters of the session id>`, read by
 * `resolveTarget`). The daemon that writes the message does not know which address the reader
 * reached it at, so the host is the placeholder `<host>`, and the message says what it stands for.
 * A remi session id is a version 4 UUID, random throughout, so its first eight characters name it.
 */
export function attachCommand(port: number, sessionId: string): string {
  return `remi attach <host>:${port}/${sessionId.slice(0, 8)}`;
}
