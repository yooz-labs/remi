/** Actual durable push operation: consumption precedes JWT/network; exact epoch owns every await. */
import {
  type PushRejectReason,
  type PushSubmit,
  type PushSubmitResult,
  decodePushSubmit,
  encodePushSubmitResult,
  fromB64u,
  verifyPushSubmit,
} from '@remi/shared/relay/index.ts';
import { type ApnsRequest, buildSecureApnsRequest } from './apns.ts';
import { captureEnrollment, sameEnrollment } from './enrollment.ts';
import { withinPushBudget } from './limiter.ts';
import { type LimitEnv, pushLimit } from './limits.ts';
import type { PushEnv, PushStorage } from './push-storage.ts';

interface NonceRecord {
  digest: string;
  epoch: string;
  until: number;
  result?: PushSubmitResult;
}
export function rejected(
  reason: PushRejectReason,
  digest: string | null = null,
  retryable = false,
): PushSubmitResult {
  return { v: 2, requestDigest: digest, outcome: 'rejected', reason, retryable };
}
/**
 * `retryAfter` is the seconds until the fixed budget window that refused the request ends (#1200):
 * the caller may retry the same bytes then, never inside the window that refused them.
 */
export function pushResponse(result: PushSubmitResult, retryAfter?: number): Response {
  const status =
    result.outcome === 'rejected'
      ? result.reason === 'UNAUTHORIZED'
        ? 401
        : result.reason === 'RATE_LIMITED' || result.reason === 'CAPACITY'
          ? 429
          : result.reason === 'STORE_ERROR'
            ? 503
            : 400
      : 200;
  return new Response(encodePushSubmitResult(result), {
    status,
    headers: {
      'content-type': 'application/json',
      ...(retryAfter === undefined ? {} : { 'retry-after': String(retryAfter) }),
    },
  });
}
export async function hashPublic(value: string): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
}
/** Never trusts Content-Length alone; bounded bytes and fatal UTF8 precede JSON parsing. */
export async function readPushBody(request: Request): Promise<string> {
  const length = request.headers.get('content-length');
  if (length && Number(length) > 8192) throw new Error('OVERSIZE');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('MALFORMED');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 8192) {
        await reader.cancel();
        throw new Error('OVERSIZE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(all);
  } catch {
    throw new Error('MALFORMED');
  }
}
export interface PushIo {
  now(): number;
  audience(): string | null;
  /** `refresh` signs a new APNs provider token instead of reusing the cached one. */
  jwt(refresh?: boolean): Promise<string>;
  send(request: ApnsRequest, signal: AbortSignal): Promise<Response>;
}

export class PushGateway {
  constructor(
    private readonly storage: PushStorage,
    private readonly env: PushEnv & LimitEnv,
    private readonly io: PushIo,
  ) {}
  private nonce(key: string): NonceRecord | undefined {
    const v = this.storage.kv.get<NonceRecord>(key);
    if (v === undefined) return undefined;
    if (
      !v ||
      typeof v !== 'object' ||
      !/^[0-9a-f]{64}$/.test(v.digest) ||
      typeof v.epoch !== 'string' ||
      fromB64u(v.epoch).length !== 32 ||
      !Number.isSafeInteger(v.until)
    )
      throw new Error('invalid nonce');
    return v;
  }
  async submit(request: Request, rid: string): Promise<Response> {
    let digest: string | null = null;
    let consumed = false;
    let nonceKey = '';
    let epoch = '';
    let deviceKey = '';
    let checked: PushSubmit | undefined;
    const uncertain = (): PushSubmitResult => ({
      v: 2,
      requestDigest: digest as string,
      outcome: 'uncertain',
    });
    const finish = async (result: PushSubmitResult): Promise<Response> => {
      try {
        this.storage.transactionSync(() => {
          const record = this.nonce(nonceKey);
          if (!record || record.digest !== digest || record.epoch !== epoch)
            throw new Error('nonce ownership');
          this.storage.kv.put(nonceKey, { ...record, result });
        });
        await this.storage.sync();
        return pushResponse(result);
      } catch {
        return pushResponse(uncertain());
      }
    };
    // A definite transient refusal from Apple: the notification was NOT accepted, so the same
    // signed bytes may try again while the submit is valid. Drop the pending nonce instead of
    // retaining a final result (an uncertain outcome never takes this path).
    const release = async (result: PushSubmitResult): Promise<Response> => {
      try {
        this.storage.transactionSync(() => {
          const record = this.nonce(nonceKey);
          if (
            !record ||
            record.digest !== digest ||
            record.epoch !== epoch ||
            record.result !== undefined
          )
            throw new Error('nonce ownership');
          this.storage.kv.delete(nonceKey);
        });
        await this.storage.sync();
        return pushResponse(result);
      } catch {
        return pushResponse(uncertain());
      }
    };
    try {
      let raw: string;
      try {
        raw = await readPushBody(request);
      } catch (e) {
        return pushResponse(
          rejected(e instanceof Error && e.message === 'OVERSIZE' ? 'OVERSIZE' : 'MALFORMED'),
        );
      }
      try {
        checked = decodePushSubmit(raw);
      } catch (e) {
        return pushResponse(
          rejected(e instanceof Error && e.message === 'OVERSIZE' ? 'OVERSIZE' : 'MALFORMED'),
        );
      }
      const audience = this.io.audience();
      if (!audience || checked.audience !== audience)
        return pushResponse(rejected('WRONG_AUDIENCE'));
      if (checked.rid !== rid) return pushResponse(rejected('MALFORMED'));
      deviceKey = `dev:${Array.from(fromB64u(checked.devicePublicKey), (b) => b.toString(16).padStart(2, '0')).join('')}`;
      // No async crypto/budget call precedes this actual authority snapshot.
      let captured: string | undefined;
      let captureFailed = false;
      let captureInvalidated = false;
      try {
        captured = captureEnrollment(this.storage, deviceKey);
        if (captured) {
          epoch = captured;
          await this.storage.sync();
          captureInvalidated = !sameEnrollment(this.storage, deviceKey, epoch);
        }
      } catch {
        captureFailed = true;
      }
      // Enrollment absence/capture failures disclose no row-specific verdict before proof.
      // The captured epoch remains immutable; a later lookup can never replace it.
      try {
        digest = (
          await verifyPushSubmit(checked, { rid, audience }, Math.floor(this.io.now() / 1000))
        ).requestDigest;
      } catch (e) {
        const code = e instanceof Error ? e.message : '';
        return pushResponse(
          rejected(
            code === 'EXPIRED'
              ? 'EXPIRED'
              : code === 'BAD_SIGNATURE'
                ? 'BAD_SIGNATURE'
                : 'MALFORMED',
          ),
        );
      }
      if (captureFailed) return pushResponse(rejected('STORE_ERROR', digest, true));
      if (!captured || captureInvalidated || !sameEnrollment(this.storage, deviceKey, epoch))
        return pushResponse(rejected('NOT_ENROLLED', digest));
      nonceKey = `push-nonce:${checked.nonce}`;
      const retained = this.nonce(nonceKey);
      if (retained) {
        if (retained.digest !== digest) return pushResponse(rejected('NONCE_CONFLICT', digest));
        if (retained.epoch !== epoch) return pushResponse(rejected('NOT_ENROLLED', digest));
        return pushResponse(retained.result ?? uncertain());
      }
      // #1200: everything that can fail before Apple is reached runs BEFORE the nonce is consumed,
      // so a missing or unusable credential or an oversized request is reported as what it is and
      // strands no pending nonce. Signing a provider token is local work, not a network effect.
      if (!this.env.APNS_KEY_ID || !this.env.APNS_TEAM_ID || !this.env.APNS_PRIVATE_KEY)
        return pushResponse(rejected('APNS_UNAVAILABLE', digest, true));
      let jwt: string;
      try {
        jwt = await this.io.jwt();
      } catch {
        return pushResponse(rejected('APNS_UNAVAILABLE', digest, true));
      }
      let apns: ApnsRequest;
      try {
        apns = buildSecureApnsRequest(checked, jwt, this.env.APNS_BUNDLE_ID ?? 'live.yooz.remi');
      } catch {
        return pushResponse(rejected('OVERSIZE', digest));
      }
      const budget = await withinPushBudget(this.env.LIMITER, 'send', {
        ip: await hashPublic(request.headers.get('CF-Connecting-IP') ?? 'unknown'),
        rid,
        tokenHash: await hashPublic(checked.token),
        pushClass: checked.pushClass,
      });
      if (!budget.ok)
        return pushResponse(
          rejected(budget.reason ?? 'STORE_ERROR', digest, true),
          budget.retryAfter,
        );
      const submitting = checked;
      const decision = this.storage.transactionSync(() => {
        if (!sameEnrollment(this.storage, deviceKey, epoch))
          return rejected('NOT_ENROLLED', digest);
        const existing = this.nonce(nonceKey);
        if (existing)
          return existing.digest !== digest
            ? rejected('NONCE_CONFLICT', digest)
            : existing.epoch !== epoch
              ? rejected('NOT_ENROLLED', digest)
              : (existing.result ?? uncertain());
        const cap = pushLimit(this.env, 'PUSH_NONCES');
        const rows = new Map(
          this.storage.kv.list<NonceRecord>({ prefix: 'push-nonce:', limit: 4097 }),
        );
        const now = Math.floor(this.io.now() / 1000);
        for (const [key, row] of rows) {
          this.nonce(key);
          if (row.until <= now) {
            this.storage.kv.delete(key);
            rows.delete(key);
          }
        }
        if (rows.size >= cap) return rejected('CAPACITY', digest, true);
        if (submitting.expiresAt <= now) return rejected('EXPIRED', digest);
        this.storage.kv.put(nonceKey, { digest, epoch, until: submitting.expiresAt + 60 });
        consumed = true;
        return null;
      });
      if (decision) return pushResponse(decision);
      // The nonce is consumed durably BEFORE the receiver is invoked.
      await this.storage.sync();
      if (!sameEnrollment(this.storage, deviceKey, epoch))
        return finish(rejected('NOT_ENROLLED', digest));
      const record = this.nonce(nonceKey);
      if (
        !sameEnrollment(this.storage, deviceKey, epoch) ||
        record?.digest !== digest ||
        record.epoch !== epoch ||
        record.result !== undefined
      )
        return finish(rejected('NOT_ENROLLED', digest));
      if (checked.expiresAt <= Math.floor(this.io.now() / 1000))
        return finish(rejected('EXPIRED', digest));
      // There is NO await between this final ownership check and actual fetch invocation.
      const remaining = checked.expiresAt * 1000 - this.io.now();
      if (remaining <= 0) return finish(rejected('EXPIRED', digest));
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), Math.min(10_000, remaining));
      try {
        const response = await this.io.send(apns, abort.signal);
        if (abort.signal.aborted) throw new Error('owned response deadline');
        if (response.ok) {
          await response.body?.cancel();
          return finish({ v: 2, requestDigest: digest, outcome: 'accepted' });
        }
        // Read only a bounded classification; raw Apple body never reaches wire/logs/storage.
        let reason = '';
        try {
          const text = await readPushBody(
            new Request('https://apns-response.invalid', { method: 'POST', body: response.body }),
          );
          if (text.length <= 1024) {
            const value = JSON.parse(text) as { reason?: unknown };
            if (typeof value.reason === 'string') reason = value.reason;
          }
        } catch {}
        if (abort.signal.aborted) throw new Error('owned response deadline');
        const invalid = ['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic'].includes(
          reason,
        );
        if (invalid) return finish(rejected('INVALID_TOKEN', digest));
        // Transient (#1200): throttling, Apple-side errors and an expired provider token say
        // nothing about this capsule, so the same bytes may succeed later. Everything else Apple
        // refuses (bad topic, bad payload, invalid provider token) stays final and retained.
        const expiredToken = response.status === 403 && reason === 'ExpiredProviderToken';
        if (response.status === 429 || response.status >= 500 || expiredToken) {
          if (expiredToken) await this.io.jwt(true).catch(() => undefined);
          return release(rejected('APNS_UNAVAILABLE', digest, true));
        }
        return finish(rejected('APNS_REJECTED', digest));
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return pushResponse(consumed ? uncertain() : rejected('STORE_ERROR', digest, true));
    }
  }
}
