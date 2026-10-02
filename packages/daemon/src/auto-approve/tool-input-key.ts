/**
 * The key a tool call's input is compared by: the gate's external-resolution
 * signatures (#673) and the subagent alerter's pending calls (#1155) both
 * match a call by agent, tool name and this key.
 */

/**
 * A stable, key-order-independent JSON key for `tool_input` (#673). Two
 * logically identical tool_input objects with keys in a different order must
 * compare equal, so the signature match is not order-fragile.
 */
export function stableToolInputKey(toolInput: Record<string, unknown>): string {
  try {
    return JSON.stringify(canonicalize(toolInput));
  } catch {
    // Non-serializable input should not happen (tool_input comes from a
    // parsed JSON hook payload); degrade to a key that can never match
    // anything rather than throwing into the escalation path.
    return `__unserializable__:${Math.random()}`;
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const sortedEntries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])] as const);
    return Object.fromEntries(sortedEntries);
  }
  return value;
}
