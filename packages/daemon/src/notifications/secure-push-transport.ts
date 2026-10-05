/** Signed sealed delivery with current durable authority at each actual network effect (#1200). */
import { relayV2 as r } from '@remi/shared';
import type { SecurePushSnapshot, SecurePushStore } from './secure-push-store.ts';

export interface SecurePushTransportOptions {
  readonly store: SecurePushStore;
  readonly signer: r.Signer;
  readonly audience: string;
  readonly maxAttempts?: 1 | 2 | 3;
  readonly retryDelayMs?: number;
}
export interface OwnedLoopbackPushTestOptions extends SecurePushTransportOptions {
  readonly ownedOrigin: string;
}
export interface PreparedSecurePush {
  readonly carrier: r.PushCarrier;
  readonly contentDigest: string;
  readonly requestDigest: string;
  readonly submitNonce: string;
  readonly expiresAt: number;
}
export type SecurePushRefusal =
  | 'AUTHORITY_CHANGED'
  | 'NOT_CURRENT'
  | 'EXPIRED'
  | 'STORE_ERROR'
  | 'INVALID_CONTENT'
  | 'NOT_PREPARED';
export type SecurePushPreparation =
  | { readonly outcome: 'prepared'; readonly prepared: PreparedSecurePush }
  | { readonly outcome: 'refused'; readonly reason: SecurePushRefusal };
export type SecurePushDelivery =
  | { readonly outcome: 'refused'; readonly reason: SecurePushRefusal; readonly attempts: number }
  | {
      readonly outcome: 'accepted' | 'uncertain';
      readonly requestDigest: string;
      readonly attempts: number;
    }
  | {
      readonly outcome: 'rejected';
      readonly requestDigest: string;
      readonly reason: r.PushRejectReason;
      readonly retryable: boolean;
      readonly attempts: number;
    };
interface PrivatePreparation {
  readonly snapshot: SecurePushSnapshot;
  readonly isCurrent: () => boolean;
  readonly body: string;
  readonly url: string;
  readonly expiresAt: number;
  readonly requestDigest: string;
  sending?: Promise<SecurePushDelivery>;
}
const ownedTests = new WeakMap<SecurePushTransportOptions, string>();
const refusal = (reason: SecurePushRefusal) => ({ outcome: 'refused' as const, reason });
const nowSeconds = () => Math.floor(Date.now() / 1000);
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
/** Extract only the frozen codec's LP(label,digest) output; never reconstruct its tuple. */
function signingDigest(input: Uint8Array, label: string): string {
  const expected = new TextEncoder().encode(label);
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  if (
    input.length !== expected.length + 36 ||
    view.getUint16(0) !== expected.length ||
    !r.ctEqual(input.subarray(2, 2 + expected.length), expected) ||
    view.getUint16(2 + expected.length) !== 32
  )
    throw new Error('SECURE_PUSH_CODEC_LAYOUT');
  return hex(input.subarray(expected.length + 4));
}
/** Read the exact UTF8 response, bounded independently of HTTP status and declared length. */
async function resultBody(response: Response): Promise<r.PushSubmitResult> {
  if (!response.body) throw new Error('SECURE_PUSH_RESPONSE');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.length;
      if (length > 512) throw new Error('SECURE_PUSH_RESPONSE');
      chunks.push(item.value);
    }
  } catch {
    void reader.cancel().catch(() => {});
    throw new Error('SECURE_PUSH_RESPONSE');
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return r.decodePushSubmitResult(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
export class SecurePushTransport {
  private readonly store: SecurePushStore;
  private readonly signer: r.Signer;
  private readonly audience: string;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly prepared = new WeakMap<PreparedSecurePush, PrivatePreparation>();
  constructor(options: SecurePushTransportOptions) {
    let url: URL;
    try {
      url = new URL(options.audience);
    } catch {
      throw new Error('SECURE_PUSH_AUDIENCE');
    }
    if (
      url.origin !== options.audience ||
      (url.protocol !== 'https:' &&
        !(
          url.protocol === 'http:' &&
          url.hostname === '127.0.0.1' &&
          ownedTests.get(options) === url.origin
        ))
    )
      throw new Error('SECURE_PUSH_AUDIENCE');
    this.maxAttempts = options.maxAttempts ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 100;
    if (
      ![1, 2, 3].includes(this.maxAttempts) ||
      !Number.isInteger(this.retryDelayMs) ||
      this.retryDelayMs < 0 ||
      this.retryDelayMs > 1000
    )
      throw new Error('SECURE_PUSH_RETRY_CONFIG');
    this.store = options.store;
    const sign = options.signer.sign.bind(options.signer);
    this.signer = Object.freeze({ publicKey: new Uint8Array(options.signer.publicKey), sign });
    this.audience = options.audience;
  }
  /** Exact owned HTTP127 listener only; production constructor never enables HTTP. */
  static forOwnedLoopbackTest(options: OwnedLoopbackPushTestOptions): SecurePushTransport {
    if (options.ownedOrigin !== options.audience) throw new Error('SECURE_PUSH_AUDIENCE');
    const copy: SecurePushTransportOptions = { ...options };
    ownedTests.set(copy, options.ownedOrigin);
    try {
      return new SecurePushTransport(copy);
    } finally {
      ownedTests.delete(copy);
    }
  }
  private guard(
    snapshot: SecurePushSnapshot,
    isCurrent: () => boolean,
    expiresAt: number,
  ): SecurePushRefusal | null {
    try {
      const checked = this.store.withCurrentSubscription(snapshot, () => ({
        reason: this.currentReason(isCurrent, expiresAt),
      }));
      return checked === null ? 'AUTHORITY_CHANGED' : checked.reason;
    } catch {
      return 'STORE_ERROR';
    }
  }
  private currentReason(isCurrent: () => boolean, expiresAt: number): SecurePushRefusal | null {
    try {
      if (!isCurrent()) return 'NOT_CURRENT';
    } catch {
      return 'NOT_CURRENT';
    }
    return Date.now() >= expiresAt * 1000 ? 'EXPIRED' : null;
  }
  async prepare(
    snapshot: SecurePushSnapshot,
    metadata: r.PushContentMetadata,
    payload: r.SecurePushPayload,
    isCurrent: () => boolean,
  ): Promise<SecurePushPreparation> {
    // Everything selected by the caller is copied before the first asynchronous operation.
    let captured: SecurePushSnapshot;
    let content: r.PushContentMetadata;
    let copiedPayload: r.SecurePushPayload;
    let payloadBytes: Uint8Array;
    try {
      captured = Object.freeze({
        ...snapshot,
        ...(snapshot.pushPrefs ? { pushPrefs: Object.freeze({ ...snapshot.pushPrefs }) } : {}),
      });
      content = Object.freeze({ ...metadata });
      payloadBytes = r.buildPushPayload(payload);
      copiedPayload = r.parsePushPayload(payloadBytes);
      if (
        content.machinePublicKey !== r.b64u(this.signer.publicKey) ||
        content.devicePublicKey !==
          Buffer.from(captured.publicKey, 'base64').toString('base64url') ||
        content.pushPublicKey !== captured.pushPublicKey ||
        content.keyVersion !== captured.keyVersion
      )
        return refusal('INVALID_CONTENT');
    } catch {
      return refusal('INVALID_CONTENT');
    }
    const check = () => this.guard(captured, isCurrent, content.expiresAt);
    let reason = check();
    if (reason) return refusal(reason);
    try {
      const rid = hex(await r.ridOf(this.signer.publicKey));
      reason = check();
      if (reason) return refusal(reason);
      if (rid !== content.rid) return refusal('INVALID_CONTENT');
      const sealed = await r.sealPushContent(this.signer, content, copiedPayload, r.systemRandom);
      reason = check();
      if (reason) return refusal(reason);
      const contentDigest = signingDigest(
        await r.buildPushContentSigningInput(content, payloadBytes),
        r.LABEL.pushContent,
      );
      reason = check();
      if (reason) return refusal(reason);
      const issuedAt = nowSeconds();
      const expiresAt = Math.min(content.expiresAt, issuedAt + 60);
      if (expiresAt <= issuedAt) return refusal('EXPIRED');
      const unsigned: r.UnsignedPushSubmit = {
        ...content,
        v: 2,
        audience: this.audience,
        token: captured.token,
        environment: captured.environment,
        sealed: r.b64u(sealed),
        nonce: r.b64u(r.systemRandom(32)),
        issuedAt,
        expiresAt,
      };
      const input = await r.buildPushSubmitSigningInput(unsigned);
      reason = this.guard(captured, isCurrent, expiresAt);
      if (reason) return refusal(reason);
      const requestDigest = signingDigest(input, r.LABEL.pushSubmit);
      const signature = await this.signer.sign(input);
      reason = this.guard(captured, isCurrent, expiresAt);
      if (reason) return refusal(reason);
      const submit: r.PushSubmit = { ...unsigned, signature: r.b64u(signature) };
      // Validate the actual supplied signer's result, not just its claimed public key.
      await r.verifyPushSubmit(submit, { rid, audience: this.audience }, nowSeconds());
      reason = this.guard(captured, isCurrent, expiresAt);
      if (reason) return refusal(reason);
      const carrier: r.PushCarrier = Object.freeze({
        v: 2,
        rid,
        collapseId: content.collapseId,
        keyVersion: content.keyVersion,
        kind: content.kind,
        sealed: unsigned.sealed,
      });
      const prepared = Object.freeze({
        carrier,
        contentDigest,
        requestDigest,
        submitNonce: unsigned.nonce,
        expiresAt,
      });
      this.prepared.set(prepared, {
        snapshot: captured,
        isCurrent,
        body: r.encodePushSubmit(submit),
        url: `${this.audience}/v2/push/${rid}`,
        expiresAt,
        requestDigest,
      });
      return { outcome: 'prepared', prepared };
    } catch {
      return refusal('INVALID_CONTENT');
    }
  }
  sendPrepared(prepared: PreparedSecurePush): Promise<SecurePushDelivery> {
    const captured = this.prepared.get(prepared);
    if (!captured) return Promise.resolve({ ...refusal('NOT_PREPARED'), attempts: 0 });
    // Concurrent/repeated callers share this one finite delivery decision, never a new send loop.
    captured.sending ??= this.deliver(captured);
    return captured.sending;
  }
  private async deliver(captured: PrivatePreparation): Promise<SecurePushDelivery> {
    let attempts = 0;
    const uncertain = (): SecurePushDelivery => ({
      outcome: 'uncertain',
      requestDigest: captured.requestDigest,
      attempts,
    });
    for (;;) {
      let effect:
        | {
            response: Promise<Response>;
            controller: AbortController;
            timer: ReturnType<typeof setTimeout>;
          }
        | { reason: SecurePushRefusal }
        | null;
      try {
        effect = this.store.withCurrentSubscription(captured.snapshot, () => {
          const reason = this.currentReason(captured.isCurrent, captured.expiresAt);
          if (reason) return { reason };
          const controller = new AbortController();
          const timer = setTimeout(
            () => controller.abort(),
            Math.min(12000, captured.expiresAt * 1000 - Date.now()),
          );
          attempts++;
          try {
            // This invocation and every eligibility check above share the SAME synchronous lock.
            const response = fetch(captured.url, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: captured.body,
              signal: controller.signal,
              redirect: 'error',
            });
            return { response, controller, timer };
          } catch {
            clearTimeout(timer);
            throw new Error('SECURE_PUSH_NETWORK');
          }
        });
      } catch {
        return attempts > 0 ? uncertain() : { ...refusal('STORE_ERROR'), attempts };
      }
      if (effect === null) return { ...refusal('AUTHORITY_CHANGED'), attempts };
      if ('reason' in effect) return { ...refusal(effect.reason), attempts };
      let result: r.PushSubmitResult;
      try {
        const response = await effect.response;
        result = await resultBody(response);
        if (
          result.requestDigest !== captured.requestDigest ||
          (!response.ok && result.outcome !== 'rejected')
        )
          return uncertain();
      } catch {
        return uncertain();
      } finally {
        clearTimeout(effect.timer);
        effect.controller.abort();
      }
      if (result.outcome !== 'rejected')
        return { outcome: result.outcome, requestDigest: captured.requestDigest, attempts };
      const retryable =
        result.retryable && ['RATE_LIMITED', 'CAPACITY', 'STORE_ERROR'].includes(result.reason);
      if (!retryable || attempts >= this.maxAttempts)
        return {
          outcome: 'rejected',
          requestDigest: captured.requestDigest,
          reason: result.reason,
          retryable,
          attempts,
        };
      const reason = this.guard(captured.snapshot, captured.isCurrent, captured.expiresAt);
      if (reason) return { ...refusal(reason), attempts };
      const remaining = captured.expiresAt * 1000 - Date.now();
      if (remaining <= this.retryDelayMs) return { ...refusal('EXPIRED'), attempts };
      await new Promise<void>((resolve) => setTimeout(resolve, this.retryDelayMs));
    }
  }
}
