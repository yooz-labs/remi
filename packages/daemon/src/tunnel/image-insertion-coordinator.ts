/** ADR0042 internal effect/retry owner. No public dispatch or capability in this slice. */
import { randomUUID } from 'node:crypto';
import type {
  ImageInsertRequest,
  ImageInsertResult,
  ImageInsertionRefusalCode,
  UUID,
} from '@remi/shared';
import { ImageInsertionError, type ImageInsertionLease } from './image-insertion-lease';
import type { ImageStagingService } from './image-staging-service';

type Effect =
  | { outcome: 'inserted'; code: 'none' }
  | { outcome: 'uncertain'; code: 'delivery_unknown' }
  | { outcome: 'refused'; code: ImageInsertionRefusalCode };
type Attempt = {
  signature: string;
  lease: ImageInsertionLease;
  result: Promise<ImageInsertResult>;
};
// Bounded process-local correlation only; authority and file lifetime still belong to staging.
const maximumAttempts = 128;
const refusal = (error: unknown): Effect => ({
  outcome: 'refused',
  code: error instanceof ImageInsertionError ? error.code : 'unavailable',
});
const result = (request: ImageInsertRequest, effect: Effect): ImageInsertResult =>
  Object.freeze({
    type: 'image_insert_result' as const,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    requestId: request.id,
    sessionId: request.sessionId,
    ...effect,
  });
const captured = (request: ImageInsertRequest): ImageInsertRequest => ({
  type: request.type,
  id: request.id,
  timestamp: request.timestamp,
  sessionId: request.sessionId,
  binding: { ...request.binding },
  artifactId: request.artifactId,
});

export class ImageInsertionCoordinator {
  private readonly attempts = new Map<string, Attempt>();
  private closed = false;

  constructor(
    private readonly staging: ImageStagingService,
    private readonly promptUp: (sessionId: UUID) => boolean,
  ) {}

  private assertCurrent(attempt: Attempt): void {
    if (this.closed) throw new ImageInsertionError('unavailable');
    attempt.lease.assertCurrent();
  }

  private prune(): void {
    for (const [key, attempt] of this.attempts) {
      try {
        this.assertCurrent(attempt);
      } catch (error) {
        // A transient store lock must not discard an otherwise usable replay record.
        if (!(error instanceof ImageInsertionError) || error.code !== 'busy')
          this.attempts.delete(key);
      }
    }
  }

  async handle(connectionId: UUID, input: ImageInsertRequest): Promise<ImageInsertResult> {
    const request = captured(input);
    const key = `${connectionId}:${request.id}`;
    const signature = JSON.stringify(request);
    try {
      if (this.closed) throw new ImageInsertionError('unavailable');
      let attempt = this.attempts.get(key);
      if (attempt) {
        // No cached result or conflict detail is disclosed after original authority is lost.
        this.assertCurrent(attempt);
        if (attempt.signature !== signature) throw new ImageInsertionError('conflict');
      } else {
        const lease = this.staging.prepareInsertion(
          connectionId,
          request.sessionId,
          request.binding,
          request.artifactId,
        );
        // Sweep only at capacity; per-request authority remains checked above and at the effect.
        // Reopening every retained file on each new ID made a bounded request burst quadratic.
        if (this.attempts.size >= maximumAttempts) this.prune();
        if (this.attempts.size >= maximumAttempts) throw new ImageInsertionError('busy');
        attempt = { signature, lease, result: this.perform(request, lease) };
        this.attempts.set(key, attempt);
      }
      // Recorded before delivery; lost publication or a concurrent retry cannot repeat the effect.
      const response = await attempt.result;
      this.assertCurrent(attempt);
      return response;
    } catch (error) {
      return result(request, refusal(error));
    }
  }

  private async perform(
    request: ImageInsertRequest,
    lease: ImageInsertionLease,
  ): Promise<ImageInsertResult> {
    try {
      const reference = lease.referencePath();
      const inserted = await lease.pty.insertText(` @"${reference}" `, () => {
        if (this.closed) throw new ImageInsertionError('unavailable');
        lease.retire(reference, () => this.promptUp(request.sessionId));
        return true;
      });
      if (!inserted) throw new ImageInsertionError('unavailable');
      return result(request, { outcome: 'inserted', code: 'none' });
    } catch (error) {
      return result(
        request,
        lease.possibleWrite ? { outcome: 'uncertain', code: 'delivery_unknown' } : refusal(error),
      );
    }
  }

  invalidateConnection(connectionId: UUID): void {
    for (const key of this.attempts.keys())
      if (key.startsWith(`${connectionId}:`)) this.attempts.delete(key);
  }

  close(): void {
    this.closed = true;
    this.attempts.clear();
  }
}
