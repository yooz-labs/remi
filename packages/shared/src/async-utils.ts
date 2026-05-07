/** Async helpers shared across packages. */

/** Resolves after `ms` milliseconds. Never rejects. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
