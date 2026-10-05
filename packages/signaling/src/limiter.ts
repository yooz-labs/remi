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
 * What is NOT claimed: the counters are in the object's memory, so they reset
 * if the object is evicted or restarted (it stays resident while it is being
 * asked, which is the case that matters under load); and one object serves all
 * keys, so it is bounded by one object's request rate (Cloudflare documents a
 * soft limit of 1,000 requests per second per object). Neither is measured here.
 */

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

  async fetch(request: Request): Promise<Response> {
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
