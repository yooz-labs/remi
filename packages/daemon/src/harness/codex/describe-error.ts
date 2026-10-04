/**
 * The name of an error for a log line: the class name (`TypeError`, `AppServerRpcError`), or the
 * type of what was thrown. Never its message, which may carry what Codex or a peer said.
 * Shared by the Codex turn events and the Codex chat (#1180 review); the thread tracker's own
 * `describeError` also reads an RPC error's code, so it stays its own.
 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
