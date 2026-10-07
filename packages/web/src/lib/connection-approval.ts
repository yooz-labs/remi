import { type UnlockedIdentity, fingerprint, fromBase64 } from '@remi/shared';

/** Public-only instructions from the identity that answered the challenge (#873). */
export interface ClientApproval {
  readonly fingerprint: string;
  readonly publicJson: string;
  readonly authorizeCommand: string;
  readonly status: 'pending' | 'queue-full' | 'store-error';
  readonly detail?: string;
}

interface ApprovalAttempt {
  readonly publicKey: string;
  readonly fingerprint: string;
  readonly publicJson: string;
  readonly authorizeCommand: string;
}

/** Retains refusal instructions through transport callbacks, never private key material. */
export class ConnectionApproval {
  snapshot: ClientApproval | null = null;
  private attempt: ApprovalAttempt | null = null;
  private context: string | null = null;
  private generation = 0;

  async begin(identity: UnlockedIdentity, url: string): Promise<ApprovalAttempt | null> {
    const generation = ++this.generation;
    const context = `${url}\n${identity.publicKeyRaw}`;
    if (this.context !== context) this.snapshot = null;
    this.context = context;
    this.attempt = null;
    const fp = await fingerprint(fromBase64(identity.publicKeyRaw));
    if (generation !== this.generation) return null;
    const attempt = {
      publicKey: identity.publicKeyRaw,
      fingerprint: fp,
      publicJson: JSON.stringify({ publicKey: identity.publicKeyRaw, fingerprint: fp }, null, 2),
      authorizeCommand: `remi authorize ${fp}`,
    };
    this.attempt = attempt;
    return attempt;
  }

  isCurrent(attempt: ApprovalAttempt | null): boolean {
    return attempt !== null && this.attempt === attempt;
  }

  refuse(attempt: ApprovalAttempt | null, code?: string, detail?: string): void {
    if (!this.isCurrent(attempt) || !attempt) return;
    const status =
      code === 'UNKNOWN_KEY'
        ? 'pending'
        : code === 'PENDING_QUEUE_FULL'
          ? 'queue-full'
          : code?.startsWith('AUTH_STORE_ERROR: ') || code === 'AUTH_STORE_ERROR'
            ? 'store-error'
            : null;
    const errorDetail =
      detail ??
      (code?.startsWith('AUTH_STORE_ERROR: ')
        ? code.slice('AUTH_STORE_ERROR: '.length)
        : undefined);
    // Signature, spoof and malformed failures must never read as pending approval.
    this.snapshot = status
      ? {
          fingerprint: attempt.fingerprint,
          publicJson: attempt.publicJson,
          authorizeCommand: attempt.authorizeCommand,
          status,
          ...(errorDetail && { detail: errorDetail }),
        }
      : null;
  }

  verified(attempt: ApprovalAttempt | null): void {
    if (this.isCurrent(attempt)) this.snapshot = null;
  }

  disconnected(): void {
    ++this.generation;
    this.attempt = null;
  }

  reset(): void {
    this.disconnected();
    this.context = null;
    this.snapshot = null;
  }
}
