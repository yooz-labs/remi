/** Owner policy (#1677): renew during authenticated use, confirm after 30 inactive days. */
export const DEFAULT_PUSH_LEASE_HOURS = 30 * 24;
export const DEFAULT_PUSH_LEASE_MS = DEFAULT_PUSH_LEASE_HOURS * 60 * 60 * 1000;
