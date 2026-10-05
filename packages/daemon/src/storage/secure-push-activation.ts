/** Fail-closed constructor boundary for the secure-activation pins (#1200). */
export type LegacyPushInvocation<T> =
  | { readonly allowed: true; readonly result: T }
  | { readonly allowed: false };

export function withLegacyPushEligibility<T>(
  _directory: string,
  _operation: () => T,
): LegacyPushInvocation<T> {
  return { allowed: false };
}
