/** Per-launch, bounded push authority; no delivery extends a prompt's real hold (#1200). */
import { type Question, type UUID, relayV2 } from '@remi/shared';
import type { AnswerValidity } from '../harness/decision.ts';
import { pushCategoryFor } from './notification-dispatcher.ts';
import type { SecurePushSnapshot } from './secure-push-store.ts';

type Entry = {
  context: SecurePushContext;
  meaning: string;
  questionId: UUID | undefined;
  questionMeaning: string | undefined;
  retainUntil: number;
  dismissed: boolean;
  digest?: string;
};
/**
 * Kinds whose legacy push carried no collapse key, so every occurrence stacks on the lock screen
 * (#1200, B2). The other informational kinds keep one slot per logical id, as legacy: one
 * `harness_denied` and one `turn_failed` per session. Questions and their notices are keyed by
 * their own ids.
 */
const OWN_SLOT_KINDS: ReadonlySet<relayV2.SecurePushKind> = new Set([
  'turn_complete',
  'subagent_alert',
]);
const seconds = (): number => Math.floor(Date.now() / 1000);
/** In-flight deliveries may still read a context this long after its expiry. */
const DELIVERY_GRACE_SECONDS = 120;
function boundedText(text: string, max: number): string {
  let result = '';
  let size = 0;
  for (const character of text) {
    const bytes = new TextEncoder().encode(character).length;
    if (size + bytes > max) break;
    result += character;
    size += bytes;
  }
  return result;
}
function questionMeaning(question: Question): string {
  const meaning = JSON.stringify({
    text: question.text,
    detail: question.detail ?? null,
    kind: question.kind ?? null,
    terminalOnly: question.terminalOnly === true,
    held: question.held === true,
    allowsFreeText: question.allowsFreeText,
    isAnswered: question.isAnswered,
    questions: question.questions ?? null,
    options: question.options.map((option) => ({
      value: option.value,
      label: option.label,
      isYes: option.isYes === true,
      isNo: option.isNo === true,
      description: option.description ?? null,
      standingGrant: option.standingGrant ?? null,
      sessionGrant: option.sessionGrant ?? null,
    })),
  });
  if (new TextEncoder().encode(meaning).length > 65536) throw new Error('CONTEXT_OVERSIZE');
  return meaning;
}
function freezePayload(payload: relayV2.SecurePushPayload): relayV2.SecurePushPayload {
  if (payload.type === 'question')
    return Object.freeze({
      ...payload,
      options: Object.freeze(payload.options.map((o) => Object.freeze({ ...o }))),
    });
  return Object.freeze({ ...payload });
}

export interface SecurePushRuntime {
  readonly sessionId: UUID;
  readonly instance: string;
}
export interface SecurePushEvent {
  readonly kind: relayV2.SecurePushKind;
  readonly logicalId: string;
  /** Internal occurrence identity; distinct turns can share display text and collapse slot. */
  readonly eventId?: string;
  readonly title?: string;
  readonly body?: string;
  readonly question?: Question;
}
export interface SecurePushContext {
  readonly runtime: SecurePushRuntime;
  readonly snapshot: SecurePushSnapshot;
  readonly logicalId: string;
  /** Distinguishes occurrences that share a logical id and must not share a lock-screen slot. */
  readonly occurrence: string;
  readonly content: Omit<relayV2.PushContentMetadata, 'machinePublicKey' | 'rid'>;
  readonly payload: relayV2.SecurePushPayload;
}
export interface SecurePushContextDeps {
  readonly questionFor: (sessionId: UUID, questionId: UUID) => Question | null;
  readonly validityFor: (sessionId: UUID, questionId: UUID) => AnswerValidity;
}
const slotOf = (context: SecurePushContext): string =>
  `${context.logicalId}\0${context.occurrence}`;
export class SecurePushContexts {
  private readonly runtimes = new Map<UUID, SecurePushRuntime>();
  private readonly entries = new Map<string, Entry>();
  constructor(
    private readonly deps: SecurePushContextDeps,
    private readonly capacity = 2048,
    private readonly perSessionCapacity = 32,
  ) {
    if (
      !Number.isInteger(capacity) ||
      capacity < 1 ||
      capacity > 2048 ||
      !Number.isInteger(perSessionCapacity) ||
      perSessionCapacity < 1 ||
      perSessionCapacity > 32
    )
      throw new Error('SECURE_PUSH_CONTEXT_CAPACITY');
  }
  begin(sessionId: UUID): SecurePushRuntime {
    const previous = this.runtimes.get(sessionId);
    if (previous) this.finish(previous);
    if (this.runtimes.size >= 64) throw new Error('SECURE_PUSH_RUNTIME_CAPACITY');
    const runtime = Object.freeze({ sessionId, instance: relayV2.b64u(relayV2.systemRandom(32)) });
    this.runtimes.set(sessionId, runtime);
    return runtime;
  }
  finish(runtime: SecurePushRuntime): void {
    if (this.runtimes.get(runtime.sessionId) === runtime) this.runtimes.delete(runtime.sessionId);
    for (const [key, entry] of this.entries) {
      if (entry.context.runtime === runtime) this.entries.delete(key);
    }
  }
  capture(
    runtime: SecurePushRuntime,
    snapshot: SecurePushSnapshot,
    event: SecurePushEvent,
  ): SecurePushContext | null {
    try {
      if (
        this.runtimes.get(runtime.sessionId) !== runtime ||
        new TextEncoder().encode(event.logicalId).length > 256 ||
        !event.logicalId ||
        (event.eventId !== undefined &&
          (typeof event.eventId !== 'string' ||
            !event.eventId ||
            new TextEncoder().encode(event.eventId).length > 256))
      )
        return null;
      this.prune();
      // An explicit occurrence id names one occurrence (a duplicate frame of it coalesces);
      // without one, a kind that legacy never collapsed gets a slot of its own per capture.
      const occurrence =
        event.eventId ??
        (OWN_SLOT_KINDS.has(event.kind) ? relayV2.b64u(relayV2.systemRandom(16)) : '');
      const key = this.key(runtime, event.logicalId, occurrence, snapshot.publicKey);
      const previous = this.entries.get(key);
      if (previous?.dismissed)
        return event.kind === 'dismiss' && this.isCurrent(previous.context)
          ? previous.context
          : null;
      if (event.kind === 'dismiss' && !previous) return null;
      const now = seconds();
      const title = boundedText(event.title ?? 'Remi', 128);
      const body = boundedText(event.body ?? '', 512);
      let payload: relayV2.SecurePushPayload =
        event.kind === 'dismiss'
          ? { type: 'dismiss', actionable: false }
          : { type: 'informational', actionable: false, sessionId: runtime.sessionId, title, body };
      let expiresAt = now + (event.kind === 'dismiss' ? 3600 : 300);
      let qid: UUID | undefined;
      let qMeaning: string | undefined;
      if (event.question) {
        if (event.kind !== 'question' || event.logicalId !== event.question.id) return null;
        const current = this.deps.questionFor(runtime.sessionId, event.question.id);
        if (!current || current.isAnswered) return null;
        qid = current.id;
        qMeaning = questionMeaning(current);
        if (qMeaning !== questionMeaning(event.question)) return null;
        const validity = this.deps.validityFor(runtime.sessionId, current.id);
        const category = pushCategoryFor(current);
        if (
          validity.kind !== 'closed' &&
          category &&
          !current.questions &&
          !current.options.some(
            (o) => o.sessionGrant || o.standingGrant === 'setMode' || o.standingGrant === 'session',
          ) &&
          title === (event.title ?? 'Remi') &&
          body === (event.body ?? '') &&
          new TextEncoder().encode(current.text).length <= 512
        ) {
          const candidate: relayV2.SecurePushPayload = {
            type: 'question',
            actionable: true,
            sessionId: runtime.sessionId,
            runtimeInstance: runtime.instance,
            questionId: current.id,
            title,
            body,
            category: category as 'REMI_YN' | 'REMI_YNA' | 'REMI_MULTI',
            options: current.options.map((o) => ({
              value: o.value,
              label: o.label,
              isYes: o.isYes === true,
              isNo: o.isNo === true,
              description: o.description ?? null,
              standingGrant: o.standingGrant ?? null,
            })),
          };
          try {
            // The frozen content tuple plus signature occupies 324 bytes for a
            // 22-byte opaque collapse id. Preserve every option; never cut an action.
            if (relayV2.buildPushPayload(candidate).length <= relayV2.MAX_PUSH_PLAINTEXT - 324) {
              const deadline =
                validity.kind === 'deadline' ? Math.floor(validity.expiresAtMs / 1000) : now + 3600;
              if (Number.isSafeInteger(deadline) && deadline > now) {
                payload = candidate;
                expiresAt = Math.min(now + 3600, deadline);
              }
            }
          } catch {
            /* Oversize/unsupported actions open the app through information only. */
          }
        }
      }
      const normalized = relayV2.parsePushPayload(relayV2.buildPushPayload(payload));
      const captured = Object.freeze({
        ...snapshot,
        pushPrefs: Object.freeze({ ...snapshot.pushPrefs }),
      });
      const meaning = JSON.stringify({
        kind: event.kind,
        eventId: event.eventId ?? null,
        payload: normalized,
        questionMeaning: qMeaning ?? null,
        subscription: captured,
      });
      // A question and an explicit occurrence id have an identity, so an identical repeat is the
      // same event and keeps its object, nonce and expiry. Any other identical informational
      // event is a LATER occurrence of something that happened again: it advances the revision
      // and pushes, as legacy did, instead of being coalesced and then dropped (B2).
      if (previous?.meaning === meaning && (event.question || event.eventId !== undefined))
        return this.isCurrent(previous.context) ? previous.context : null;
      // Capacity refuses new live work; it never evicts a live entry (#1200). Only a LIVE slot
      // (not dismissed, not expired) counts against the per-session cap: a resolved or expired
      // entry stays retained for dismissal and replay correctness but holds no slot (B1), so a
      // session's 33rd question is not refused because 32 earlier ones were answered.
      if (!previous) {
        if (this.entries.size >= this.capacity) this.evictDead(now);
        if (this.entries.size >= this.capacity) return null;
      }
      if (!previous || !this.isLive(previous, now)) {
        const liveSlots = new Set<string>();
        for (const e of this.entries.values())
          if (e.context.runtime === runtime && this.isLive(e, now))
            liveSlots.add(slotOf(e.context));
        if (
          !liveSlots.has(`${event.logicalId}\0${occurrence}`) &&
          liveSlots.size >= this.perSessionCapacity
        )
          return null;
      }
      const revision = (previous?.context.content.revision ?? 0) + 1;
      if (!Number.isSafeInteger(revision)) return null;
      const context: SecurePushContext = Object.freeze({
        runtime,
        snapshot: captured,
        logicalId: event.logicalId,
        occurrence,
        content: Object.freeze({
          devicePublicKey: Buffer.from(snapshot.publicKey, 'base64').toString('base64url'),
          pushPublicKey: snapshot.pushPublicKey,
          keyVersion: snapshot.keyVersion,
          collapseId:
            previous?.context.content.collapseId ?? relayV2.b64u(relayV2.systemRandom(16)),
          revision,
          kind: event.kind,
          nonce: relayV2.b64u(relayV2.systemRandom(32)),
          issuedAt: now,
          expiresAt,
        }),
        payload: freezePayload(normalized),
      });
      this.entries.set(key, {
        context,
        meaning,
        questionId: qid,
        questionMeaning: qMeaning,
        retainUntil: Math.max(previous?.retainUntil ?? 0, now + 3600 + DELIVERY_GRACE_SECONDS),
        dismissed: event.kind === 'dismiss',
      });
      return context;
    } catch {
      return null;
    }
  }
  isCurrent(context: SecurePushContext): boolean {
    try {
      if (
        this.runtimes.get(context.runtime.sessionId) !== context.runtime ||
        context.content.expiresAt <= seconds()
      )
        return false;
      const entry = this.entries.get(
        this.key(
          context.runtime,
          context.logicalId,
          context.occurrence,
          context.snapshot.publicKey,
        ),
      );
      if (!entry || entry.context !== context) return false;
      if (entry.questionId) {
        const question = this.deps.questionFor(context.runtime.sessionId, entry.questionId);
        if (!question || question.isAnswered || questionMeaning(question) !== entry.questionMeaning)
          return false;
        if (context.payload.actionable) {
          const validity = this.deps.validityFor(context.runtime.sessionId, entry.questionId);
          if (
            validity.kind === 'closed' ||
            (validity.kind === 'deadline' &&
              Math.floor(validity.expiresAtMs / 1000) < context.content.expiresAt)
          )
            return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  }
  bindDigest(context: SecurePushContext, digest: string): boolean {
    if (!/^[0-9a-f]{64}$/.test(digest) || !this.isCurrent(context)) return false;
    const entry = this.entries.get(
      this.key(context.runtime, context.logicalId, context.occurrence, context.snapshot.publicKey),
    );
    if (!entry || (entry.digest && entry.digest !== digest)) return false;
    entry.digest = digest;
    return true;
  }
  latestAction(
    runtime: SecurePushRuntime,
    questionId: UUID,
    devicePublicKey: string,
  ): { readonly context: SecurePushContext; readonly contentDigest: string } | null {
    const entry = this.entries.get(this.key(runtime, questionId, '', devicePublicKey));
    return entry?.digest && entry.context.payload.actionable && this.isCurrent(entry.context)
      ? Object.freeze({ context: entry.context, contentDigest: entry.digest })
      : null;
  }
  /**
   * Not dismissed, not past its own expiry and, for a question, still registered: the only
   * entries that can still deliver or be answered.
   */
  private isLive(entry: Entry, now: number): boolean {
    return (
      !entry.dismissed &&
      entry.context.content.expiresAt > now &&
      (!entry.questionId ||
        this.deps.questionFor(entry.context.runtime.sessionId, entry.questionId) !== null)
    );
  }
  /**
   * Drop informational entries that expired (or were dismissed) more than the delivery grace ago.
   * Question entries are never dropped here: a registered question keeps its original ceiling
   * (`prune`). Called only when the global cap would otherwise refuse new work (#1200, B1).
   */
  private evictDead(now: number): void {
    for (const [key, entry] of this.entries)
      if (!entry.questionId && entry.context.content.expiresAt + DELIVERY_GRACE_SECONDS <= now)
        this.entries.delete(key);
  }
  private key(
    runtime: SecurePushRuntime,
    logicalId: string,
    occurrence: string,
    devicePublicKey: string,
  ): string {
    return JSON.stringify([runtime.instance, logicalId, occurrence, devicePublicKey]);
  }
  private prune(): void {
    const now = seconds();
    for (const [key, entry] of this.entries) {
      // A still-registered question retains its original ceiling; redraw cannot
      // create a fresh action lifetime after that ceiling expires.
      if (
        entry.retainUntil <= now &&
        (!entry.questionId ||
          !this.deps.questionFor(entry.context.runtime.sessionId, entry.questionId))
      )
        this.entries.delete(key);
    }
  }
}
