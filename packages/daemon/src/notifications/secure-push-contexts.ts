/** Per-launch, bounded push authority. Capture stays closed until its real caller pins land (#1200). */
import { type Question, type UUID, relayV2 } from '@remi/shared';
import type { AnswerValidity } from '../harness/decision.ts';
import type { SecurePushSnapshot } from './secure-push-store.ts';

export interface SecurePushRuntime {
  readonly sessionId: UUID;
  readonly instance: string;
}
export interface SecurePushEvent {
  readonly kind: relayV2.SecurePushKind;
  readonly logicalId: string;
  readonly title?: string;
  readonly body?: string;
  readonly question?: Question;
}
export interface SecurePushContext {
  readonly runtime: SecurePushRuntime;
  readonly snapshot: SecurePushSnapshot;
  readonly logicalId: string;
  readonly content: Omit<relayV2.PushContentMetadata, 'machinePublicKey' | 'rid'>;
  readonly payload: relayV2.SecurePushPayload;
}
export interface SecurePushContextDeps {
  readonly questionFor: (sessionId: UUID, questionId: UUID) => Question | null;
  readonly validityFor: (sessionId: UUID, questionId: UUID) => AnswerValidity;
}
export class SecurePushContexts {
  private readonly runtimes = new Map<UUID, SecurePushRuntime>();
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
    const runtime = Object.freeze({ sessionId, instance: relayV2.b64u(relayV2.systemRandom(32)) });
    this.runtimes.set(sessionId, runtime);
    return runtime;
  }
  finish(runtime: SecurePushRuntime): void {
    if (this.runtimes.get(runtime.sessionId) === runtime) this.runtimes.delete(runtime.sessionId);
  }
  capture(
    _runtime: SecurePushRuntime,
    _snapshot: SecurePushSnapshot,
    _event: SecurePushEvent,
  ): SecurePushContext | null {
    return null;
  }
  isCurrent(_context: SecurePushContext): boolean {
    return false;
  }
  bindDigest(_context: SecurePushContext, _digest: string): boolean {
    return false;
  }
  latestAction(
    _runtime: SecurePushRuntime,
    _questionId: UUID,
    _devicePublicKey: string,
  ): { readonly context: SecurePushContext; readonly contentDigest: string } | null {
    return null;
  }
}
