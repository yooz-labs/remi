/**
 * Global rate limiting through a Durable Object (R2, #1197).
 *
 * The limiter that came before lived in the memory of one Worker isolate, so
 * its counts were per isolate (every isolate started from zero) and it skipped
 * the check when the client address header was missing. This one is a single
 * Durable Object that every isolate asks, so a count is global across isolates
 * and regions, and a request without an address is limited under the shared key
 * `unknown` instead of being waved through.
 *
 * What is NOT claimed: the R2 admission counters are in the object's memory, so they reset
 * if the object is evicted or restarted (it stays resident while it is being
 * asked, which is the case that matters under load); and one object serves all
 * keys, so it is bounded by one object's request rate (Cloudflare documents a
 * soft limit of 1,000 requests per second per object). Neither is measured here.
 * R5 push attempts/sends use separate SQLite-backed counters, fixed60s windows,
 * current+previous window retention and bounded cardinality. Fixed windows permit
 * boundary bursts; these policy ceilings are not measured service capacity.
 */

import { type LimitEnv, pushLimit } from './limits.ts';
import type { LimiterNamespace, PushStorage } from './push-storage.ts';
import { RateLimiter } from './rate-limiter.ts';

// Cloudflare-specific types (available at runtime in Workers)
// biome-ignore lint/suspicious/noExplicitAny: Cloudflare Worker runtime type
type DurableObjectNamespace = any;

/** What `GlobalLimiter` accepts: the key and the budget it is counted against. */
interface CheckBody {
  key: string;
  limit: number;
  windowMs: number;
}

function parseBody(value: unknown): CheckBody | null {
  if (typeof value !== 'object' || value === null) return null;
  const { key, limit, windowMs } = value as Record<string, unknown>;
  if (typeof key !== 'string' || key.length < 1 || key.length > 128) return null;
  // Match limits.ts's supported overrides, including small windows and budgets above 100,000.
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 1_000_000)
    return null;
  if (!Number.isInteger(windowMs) || (windowMs as number) < 1) return null;
  if ((windowMs as number) > 1_000_000) return null;
  return { key, limit: limit as number, windowMs: windowMs as number };
}

/** The one object that counts. Only the Worker's own binding reaches it. */
export class GlobalLimiter {
  private readonly limiters = new Map<string, RateLimiter>();
  constructor(
    protected readonly state?: { storage: PushStorage },
    protected readonly env: LimitEnv = {},
  ) {}
  protected now(): number {
    return Date.now();
  }

  private async pushCheck(request: Request, mode: 'attempt' | 'send'): Promise<Response> {
    if (!this.state) return Response.json({ ok: false, reason: 'STORE_ERROR' }, { status: 503 });
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return Response.json({ ok: false, reason: 'MALFORMED' }, { status: 400 });
    }
    const hashes = mode === 'attempt' ? ['ip'] : ['ip', 'rid', 'tokenHash'];
    if (
      !body ||
      typeof body !== 'object' ||
      Object.keys(body).length !== hashes.length + (mode === 'send' ? 1 : 0) ||
      hashes.some(
        (k) => typeof body[k] !== 'string' || !/^[0-9a-f]{32,64}$/.test(body[k] as string),
      ) ||
      (mode === 'send' && body['pushClass'] !== 'alert' && body['pushClass'] !== 'background')
    )
      return Response.json({ ok: false, reason: 'MALFORMED' }, { status: 400 });
    const prefix = mode === 'attempt' ? 'pa:' : 'ps:';
    const window = Math.floor(this.now() / 60_000);
    const checks: readonly [string, number][] =
      mode === 'attempt'
        ? [
            [`ip:${body['ip']}`, pushLimit(this.env, 'PUSH_ATTEMPT_IP')],
            ['all', pushLimit(this.env, 'PUSH_ATTEMPT_AGGREGATE')],
          ]
        : [
            [`ip:${body['ip']}`, pushLimit(this.env, 'PUSH_SEND_IP')],
            // Dismissals are counted per room and per token apart from alerts (#1200, #723).
            body['pushClass'] === 'background'
              ? [`ridbg:${body['rid']}`, pushLimit(this.env, 'PUSH_SEND_RID_BACKGROUND')]
              : [`rid:${body['rid']}`, pushLimit(this.env, 'PUSH_SEND_RID')],
            body['pushClass'] === 'background'
              ? [`tokenbg:${body['tokenHash']}`, pushLimit(this.env, 'PUSH_SEND_TOKEN_BACKGROUND')]
              : [`token:${body['tokenHash']}`, pushLimit(this.env, 'PUSH_SEND_TOKEN')],
            ['all', pushLimit(this.env, 'PUSH_SEND_AGGREGATE')],
          ];
    const storage = this.state.storage;
    try {
      const verdict = storage.transactionSync(() => {
        const kv = storage.kv;
        const cap = pushLimit(
          this.env,
          mode === 'attempt' ? 'PUSH_ATTEMPT_RECORDS' : 'PUSH_SEND_RECORDS',
        );
        const rows = new Map(kv.list<{ window: number; count: number }>({ prefix, limit: 4097 }));
        for (const [key, row] of rows) {
          if (
            !row ||
            !Number.isSafeInteger(row.window) ||
            !Number.isSafeInteger(row.count) ||
            row.count < 1
          )
            throw new Error('invalid budget record');
          if (row.window < window - 1) {
            kv.delete(key);
            rows.delete(key);
          }
        }
        const targets = checks.map(([key, max]) => ({ key: `${prefix}${window}:${key}`, max }));
        // A fixed-window refusal cannot clear before the next window starts (#1200).
        const retryAfter = Math.max(1, Math.ceil(((window + 1) * 60_000 - this.now()) / 1000));
        if (targets.some((t) => (rows.get(t.key)?.count ?? 0) >= t.max))
          return { ok: false, reason: 'RATE_LIMITED', retryAfter };
        if (rows.size + targets.filter((t) => !rows.has(t.key)).length > cap)
          return { ok: false, reason: 'CAPACITY', retryAfter };
        for (const t of targets)
          kv.put(t.key, { window, count: (rows.get(t.key)?.count ?? 0) + 1 });
        return { ok: true };
      });
      await this.state.storage.sync();
      return Response.json(verdict);
    } catch {
      return Response.json({ ok: false, reason: 'STORE_ERROR' }, { status: 503 });
    }
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/push-attempt' || path === '/push-send')
      return this.pushCheck(request, path === '/push-attempt' ? 'attempt' : 'send');
    let body: CheckBody | null = null;
    try {
      body = parseBody(await request.json());
    } catch {}
    if (!body) return Response.json({ ok: false, error: 'BAD_REQUEST' }, { status: 400 });
    const budget = `${body.limit}/${body.windowMs}`;
    let limiter = this.limiters.get(budget);
    if (!limiter) {
      limiter = new RateLimiter(body.limit, body.windowMs);
      this.limiters.set(budget, limiter);
    }
    return Response.json({ ok: limiter.check(body.key) });
  }
}

/**
 * True when the request is within budget. Throws when the limiter cannot be
 * reached or answers anything but a verdict: the caller must refuse then (fail
 * closed), never let the request through unlimited.
 */
export async function withinBudget(
  limiter: DurableObjectNamespace,
  key: string,
  limit: number,
  windowMs: number,
): Promise<boolean> {
  const stub = limiter.get(limiter.idFromName('global'));
  const res: Response = await stub.fetch('https://limiter.invalid/check', {
    method: 'POST',
    body: JSON.stringify({ key, limit, windowMs }),
  });
  if (!res.ok) throw new Error(`limiter answered ${res.status}`);
  const verdict = (await res.json()) as { ok?: unknown };
  if (typeof verdict.ok !== 'boolean') throw new Error('limiter gave no verdict');
  return verdict.ok;
}

/** Durable push counters are distinct from the original in-memory admission counters. */
export async function withinPushBudget(
  ns: LimiterNamespace | undefined,
  mode: 'attempt' | 'send',
  body: { ip: string; rid?: string; tokenHash?: string; pushClass?: 'alert' | 'background' },
): Promise<{
  ok: boolean;
  reason?: 'RATE_LIMITED' | 'CAPACITY' | 'STORE_ERROR';
  /** Seconds until the fixed window that refused this request ends. */
  retryAfter?: number;
}> {
  if (!ns) return { ok: false, reason: 'STORE_ERROR' };
  try {
    const response = await ns
      .get(ns.idFromName('global'))
      .fetch(`https://limiter.invalid/push-${mode}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    const value = (await response.json()) as {
      ok?: unknown;
      reason?: unknown;
      retryAfter?: unknown;
    };
    if (value.ok === true) return { ok: true };
    if (
      value.ok === false &&
      (value.reason === 'RATE_LIMITED' ||
        value.reason === 'CAPACITY' ||
        value.reason === 'STORE_ERROR')
    ) {
      const retryAfter = value.retryAfter;
      return typeof retryAfter === 'number' &&
        Number.isInteger(retryAfter) &&
        retryAfter >= 1 &&
        retryAfter <= 60
        ? { ok: false, reason: value.reason, retryAfter }
        : { ok: false, reason: value.reason };
    }
  } catch {}
  return { ok: false, reason: 'STORE_ERROR' };
}
