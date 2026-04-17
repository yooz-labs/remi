/**
 * Async helpers shared across packages. Thin on purpose — every new helper
 * should justify its existence.
 */

/** Resolves after `ms` milliseconds. Never rejects. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
