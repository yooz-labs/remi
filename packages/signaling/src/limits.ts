/**
 * Limits of the relay Worker (R2, #1197).
 *
 * Every number here is an UNMEASURED default chosen to bound abuse, not a
 * figure derived from traffic. Each can be overridden by a Worker variable of
 * the same name (a positive integer), which is how the tests run the real
 * limiter with small limits instead of floods. A value that is missing, not a
 * positive integer or above its ceiling falls back to the default.
 */

export const LIMIT_DEFAULTS = {
  /** A socket that has not been admitted by then is closed (alarm). */
  ADMIT_TIMEOUT_MS: 10_000,
  /** An admitted client waits this long for the host to open its pipe. */
  PIPE_TIMEOUT_MS: 15_000,
  /** An admitted client waits this long for a host that is not connected. */
  WAIT_TIMEOUT_MS: 600_000,
  /** Window of the front-door limiter. */
  LIMIT_WINDOW_MS: 60_000,
  /** Upgrades per window per address, per route class (the old `/connect` limit was 10). */
  LIMIT_IP_CLIENT: 10,
  LIMIT_IP_HOST: 6,
  LIMIT_IP_PIPE: 60,
  /** Upgrades per window for one room, from every address together. */
  LIMIT_RID: 240,
  /** Verified admissions per window for one device key in one room. */
  LIMIT_DEVICE_ADMITS: 10,
  /** Unadmitted sockets a room holds at once, clients and host-side sockets counted apart. */
  MAX_PENDING_CLIENT: 8,
  MAX_PENDING_HOST: 8,
  /** Admitted clients (waiting, pending or open) a room holds at once. */
  MAX_CLIENTS: 16,
  /** Device keys one machine may enroll. */
  MAX_ENROLLED: 64,
  /** R5 fixed60s policies: no measured service capacity is claimed. */
  PUSH_ATTEMPT_IP: 120,
  PUSH_ATTEMPT_AGGREGATE: 600,
  PUSH_ATTEMPT_RECORDS: 4096,
  PUSH_SEND_IP: 120,
  PUSH_SEND_RID: 30,
  /**
   * Background (dismissal) pushes per room: quiet, so only a runaway-loop backstop (#723). They
   * share nothing with PUSH_SEND_RID, or a burst of alerts would leave answered cards on lock
   * screens. Sized about ten times the alert budget, the legacy ratio.
   */
  PUSH_SEND_RID_BACKGROUND: 300,
  PUSH_SEND_TOKEN: 10,
  /**
   * Background (dismissal) pushes per device token (#723): every resolved question fans one
   * dismissal out per token, so a burst of them must not be throttled by the token's alert budget.
   * Separate counters, sized about ten times PUSH_SEND_TOKEN like the per-room split above.
   */
  PUSH_SEND_TOKEN_BACKGROUND: 100,
  PUSH_SEND_AGGREGATE: 600,
  PUSH_SEND_RECORDS: 4096,
  PUSH_NONCES: 4096,
} as const;

export type LimitName = keyof typeof LIMIT_DEFAULTS;
export type LimitEnv = { readonly [K in LimitName]?: string };

const CEILING = 1_000_000;

/** The configured value of a limit, or its default. */
export function limit(env: LimitEnv, name: LimitName): number {
  const raw = env[name];
  if (raw === undefined || !/^[0-9]{1,7}$/.test(raw)) return LIMIT_DEFAULTS[name];
  const n = Number(raw);
  return n >= 1 && n <= CEILING ? n : LIMIT_DEFAULTS[name];
}

/** Push defaults may be lowered for real boundary tests; never raised past approved bounds. */
export function pushLimit(env: LimitEnv, name: LimitName): number {
  const n = limit(env, name);
  return n <= LIMIT_DEFAULTS[name] ? n : LIMIT_DEFAULTS[name];
}
