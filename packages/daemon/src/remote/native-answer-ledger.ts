/** Child-owned signed answer authority and replay, independent of relay peers (#1201). */
import {
  type AnswerOutcome,
  type AnswerResultOutcome,
  type NativeAnswerMessage,
  relayV2,
} from '@remi/shared';
import type { AnswerCommit, AnswerCommitResult } from '../harness/decision.ts';
import type {
  SecurePushContext,
  SecurePushContexts,
  SecurePushRuntime,
} from '../notifications/secure-push-contexts.ts';
import type { SecurePushSnapshot, SecurePushStore } from '../notifications/secure-push-store.ts';

const MAX_RETAINED = 1024;
const MAX_PENDING_PER_SESSION = 32;
const RETAIN_SECONDS = 5;
const seconds = (): number => Math.floor(Date.now() / 1000);
type RecordEntry = {
  readonly idKey: string;
  readonly nonceKey: string;
  readonly digest: string;
  readonly snapshot: SecurePushSnapshot;
  readonly runtime: SecurePushRuntime;
  readonly retainUntil: number;
  outcome?: AnswerResultOutcome;
};
type Claim =
  | { readonly kind: 'result'; readonly outcome: AnswerResultOutcome }
  | { readonly kind: 'new'; readonly record: RecordEntry; readonly context: SecurePushContext };
export interface NativeAnswerLedgerOptions {
  readonly machinePublicKey: string;
  readonly rid: string;
  readonly store: SecurePushStore;
  readonly contexts: SecurePushContexts;
  readonly runtimeFor: (sessionId: string) => SecurePushRuntime | undefined;
  readonly apply: (
    sessionId: string,
    questionId: string,
    answer: string,
    commit: AnswerCommit,
  ) => Promise<AnswerOutcome>;
}
function sameSnapshot(a: SecurePushSnapshot, b: SecurePushSnapshot): boolean {
  return (
    a.publicKey === b.publicKey &&
    a.fingerprint === b.fingerprint &&
    a.authorizationEpoch === b.authorizationEpoch &&
    a.enrollmentEpoch === b.enrollmentEpoch &&
    a.subscriptionEpoch === b.subscriptionEpoch &&
    a.token === b.token &&
    a.environment === b.environment &&
    a.pushPublicKey === b.pushPublicKey &&
    a.keyVersion === b.keyVersion &&
    JSON.stringify(a.pushPrefs) === JSON.stringify(b.pushPrefs)
  );
}

/** Background choices preserve the complete signed options; unsupported forms open the app. */
function backgroundChoice(payload: relayV2.SecurePushPayload, answer: string): boolean {
  if (payload.type !== 'question' || !payload.actionable) return false;
  const options = payload.options;
  const yes = (o: (typeof options)[number] | undefined) =>
    o?.isYes === true && !o.isNo && o.standingGrant === null;
  const no = (o: (typeof options)[number] | undefined) =>
    o?.isNo === true && !o.isYes && o.standingGrant === null;
  if (payload.category === 'REMI_YN') {
    if (options.length !== 2 || !yes(options[0]) || !no(options[1])) return false;
  } else if (payload.category === 'REMI_YNA') {
    const standing = options[1];
    if (
      options.length !== 3 ||
      !yes(options[0]) ||
      !no(options[2]) ||
      !standing?.isYes ||
      standing.isNo ||
      standing.standingGrant !== 'addRules' ||
      !standing.description?.trim()
    )
      return false;
  } else return false;
  const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  if (
    !options.every((o) => {
      const title =
        o.label +
        (o.description === null ? '' : ` — ${o.description}`) +
        (o.standingGrant === 'addRules' ? ' · This session' : '');
      return (
        o.label.trim().length > 0 &&
        (o.description === null || o.description.trim().length > 0) &&
        [...graphemes.segment(title)].length <= 24 &&
        !/[\p{Cc}\p{Cf}]/u.test(title)
      );
    })
  )
    return false;
  return options.some((o) => o.value === answer);
}

export class NativeAnswerLedger {
  private readonly options: Readonly<NativeAnswerLedgerOptions>;
  private readonly records = new Set<RecordEntry>();
  private readonly byId = new Map<string, RecordEntry>();
  private readonly byNonce = new Map<string, RecordEntry>();
  constructor(options: NativeAnswerLedgerOptions) {
    this.options = Object.freeze({ ...options });
  }

  async answer(input: NativeAnswerMessage): Promise<AnswerResultOutcome> {
    let message: NativeAnswerMessage;
    let runtime: SecurePushRuntime;
    let snapshot: SecurePushSnapshot;
    let digest: string;
    try {
      // Own the complete tuple before any cryptographic await or caller mutation.
      message = relayV2.decodeNativeAnswer(relayV2.encodeNativeAnswer(input));
      if (
        ['claudeSessionId', 'selections', 'cancel', 'message'].some((key) =>
          Object.hasOwn(message, key),
        )
      )
        return 'stale';
      const capturedRuntime = this.options.runtimeFor(message.sessionId);
      if (!capturedRuntime || capturedRuntime.instance !== message.runtimeInstance) return 'stale';
      runtime = capturedRuntime;
      const publicKey = Buffer.from(relayV2.fromB64u(message.devicePublicKey)).toString('base64');
      const captured = this.options.store
        .listCurrent()
        .find((entry) => entry.publicKey === publicKey);
      if (!captured) return 'stale';
      snapshot = captured;
      digest = (
        await relayV2.verifyNativeAnswer(
          message,
          {
            rid: this.options.rid,
            machinePublicKey: this.options.machinePublicKey,
            devicePublicKey: message.devicePublicKey,
          },
          seconds(),
        )
      ).requestDigest;
    } catch {
      return 'stale';
    }

    let claim: Claim;
    try {
      claim = this.options.store.withCurrentSubscription(snapshot, (): Claim => {
        if (!this.currentProof(message, runtime)) return { kind: 'result', outcome: 'stale' };
        this.prune();
        const idKey = JSON.stringify([message.devicePublicKey, message.id]);
        const nonceKey = JSON.stringify([message.devicePublicKey, message.nonce]);
        const id = this.byId.get(idKey);
        const nonce = this.byNonce.get(nonceKey);
        // Historical epochs are checked before any retained outcome is read.
        for (const previous of [id, nonce]) {
          if (
            previous &&
            (previous.runtime !== runtime || !sameSnapshot(previous.snapshot, snapshot))
          )
            return { kind: 'result', outcome: 'stale' };
        }
        if (id || nonce) {
          if (!id || id !== nonce || id.digest !== digest)
            return { kind: 'result', outcome: 'conflict' };
          return { kind: 'result', outcome: id.outcome ?? 'uncertain' };
        }
        const latest = this.options.contexts.latestAction(
          runtime,
          message.questionId,
          snapshot.publicKey,
        );
        if (
          !latest ||
          !sameSnapshot(latest.context.snapshot, snapshot) ||
          !this.matchesAction(message, latest.context, latest.contentDigest)
        )
          return { kind: 'result', outcome: 'stale' };
        if (
          this.records.size >= MAX_RETAINED ||
          [...this.records].filter(
            (entry) => entry.runtime.sessionId === message.sessionId && entry.outcome === undefined,
          ).length >= MAX_PENDING_PER_SESSION
        )
          return { kind: 'result', outcome: 'busy' };
        const record: RecordEntry = {
          idKey,
          nonceKey,
          digest,
          snapshot,
          runtime,
          retainUntil: message.expiresAt + RETAIN_SECONDS,
        };
        // Claim both identities synchronously, before invoking the real core.
        this.records.add(record);
        this.byId.set(idKey, record);
        this.byNonce.set(nonceKey, record);
        return { kind: 'new', record, context: latest.context };
      }) ?? { kind: 'result', outcome: 'stale' };
    } catch {
      return 'stale';
    }
    if (claim.kind === 'result') return claim.outcome;
    const { record, context } = claim;
    const commit: AnswerCommit = <T>(effect: () => T): AnswerCommitResult<T> => {
      let invoked = false;
      try {
        return (
          this.options.store.withCurrentSubscription(snapshot, (): AnswerCommitResult<T> => {
            const latest = this.options.contexts.latestAction(
              runtime,
              message.questionId,
              snapshot.publicKey,
            );
            if (
              !this.currentProof(message, runtime) ||
              !latest ||
              latest.context !== context ||
              !this.matchesAction(message, context, latest.contentDigest)
            )
              return { kind: 'refused' };
            invoked = true;
            return { kind: 'committed', value: effect() };
          }) ?? { kind: 'refused' }
        );
      } catch (error) {
        // Actual synchronous effect failures keep the harness's error behavior.
        // Only pre-effect storage/authority failure is a refusal, never a throw.
        if (invoked) throw error;
        return { kind: 'refused' };
      }
    };
    try {
      record.outcome = await this.options.apply(
        message.sessionId,
        message.questionId,
        message.answer,
        commit,
      );
    } catch {
      // An accepted enqueue may fail later; never infer permission to send again.
      record.outcome = 'uncertain';
    }
    return record.outcome;
  }

  private currentProof(message: NativeAnswerMessage, runtime: SecurePushRuntime): boolean {
    const now = seconds();
    return (
      this.options.runtimeFor(message.sessionId) === runtime &&
      runtime.instance === message.runtimeInstance &&
      message.issuedAt <= now + relayV2.NATIVE_ANSWER_FUTURE_SECONDS &&
      now < message.expiresAt
    );
  }
  private matchesAction(
    message: NativeAnswerMessage,
    context: SecurePushContext,
    contentDigest: string,
  ): boolean {
    return (
      context.content.devicePublicKey === message.devicePublicKey &&
      context.content.collapseId === message.collapseId &&
      context.content.revision === message.revision &&
      relayV2.b64u(new Uint8Array(Buffer.from(contentDigest, 'hex'))) === message.contentDigest &&
      message.expiresAt <= context.content.expiresAt &&
      context.payload.type === 'question' &&
      context.payload.sessionId === message.sessionId &&
      context.payload.runtimeInstance === message.runtimeInstance &&
      context.payload.questionId === message.questionId &&
      backgroundChoice(context.payload, message.answer)
    );
  }
  private prune(): void {
    const now = seconds();
    for (const record of this.records) {
      // A queued effect may outlive its proof. Keep every pending record and
      // its capacity claim until the actual core completes; never evict live work.
      if (record.outcome === undefined || record.retainUntil > now) continue;
      this.records.delete(record);
      if (this.byId.get(record.idKey) === record) this.byId.delete(record.idKey);
      if (this.byNonce.get(record.nonceKey) === record) this.byNonce.delete(record.nonceKey);
    }
  }
}
