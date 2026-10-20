import type {
  PushPreferences,
  SecurePushRegisterResponseMessage,
  SecurePushRegistration,
} from '@remi/shared';

/** A connected relay machine this device may subscribe to (#1200). */
export interface SecurePushTarget {
  readonly connectionId: string;
  readonly machinePublicKey: string;
}

/** Native metadata plus its one-use check, run immediately before sending. */
export interface PreparedSecurePush {
  readonly metadata: SecurePushRegistration;
  readonly validate: () => Promise<void>;
}

export interface SecurePushPort {
  readonly prepare: (machinePublicKey: string) => Promise<PreparedSecurePush>;
  readonly register: (
    connectionId: string,
    registration: SecurePushRegistration,
  ) => Promise<SecurePushRegisterResponseMessage>;
}

export type SecurePushOutcome =
  | { readonly kind: 'registered' }
  | { readonly kind: 'refused'; readonly error: string }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'unverified' };

function preferencesKey(prefs: PushPreferences): string {
  return [prefs.questions, prefs.turnComplete, prefs.harnessDenied, prefs.turnFailed]
    .map((value) => (value ? '1' : '0'))
    .join('');
}

/**
 * Keeps one secure push subscription per connected relay machine (#1200).
 *
 * A machine is registered when it connects, when the native app reports a new
 * OS token and when the push preferences change. Having no token is the normal
 * state before notifications are enabled, so a failed attempt is retried only
 * on the next of those triggers, never in a loop. The native ticket is
 * validated immediately before its request is sent; an attempt whose token
 * generation, preferences or target changed while it was preparing sends
 * nothing, and the next attempt uses the current state.
 */
export class SecurePushSubscriptions {
  private generation = 0;
  private targets: readonly SecurePushTarget[] = [];
  private prefs: PushPreferences | null = null;
  /** Connection id -> the state key its last finished attempt used. */
  private readonly settled = new Map<string, string>();
  private readonly running = new Set<string>();
  private readonly port: SecurePushPort;
  private readonly onOutcome: (connectionId: string, outcome: SecurePushOutcome) => void;

  constructor(
    port: SecurePushPort,
    onOutcome: (connectionId: string, outcome: SecurePushOutcome) => void = () => {},
  ) {
    this.port = port;
    this.onOutcome = onOutcome;
  }

  /** The native app reported a new OS token (or lost one). */
  tokenChanged(): void {
    this.generation++;
    this.resync();
  }

  /** The signing identity changed: nothing earlier may be reused. */
  reset(): void {
    this.generation++;
    this.settled.clear();
  }

  sync(targets: readonly SecurePushTarget[], prefs: PushPreferences): void {
    this.targets = targets;
    this.prefs = prefs;
    // A machine that left (disconnected or forgotten) registers again when it returns.
    for (const id of [...this.settled.keys()])
      if (!targets.some((target) => target.connectionId === id)) this.settled.delete(id);
    this.resync();
  }

  private key(target: SecurePushTarget, prefs: PushPreferences): string {
    return `${this.generation}|${preferencesKey(prefs)}|${target.machinePublicKey}`;
  }

  private current(target: SecurePushTarget, key: string): boolean {
    const prefs = this.prefs;
    return (
      prefs !== null &&
      this.targets.some(
        (item) =>
          item.connectionId === target.connectionId &&
          item.machinePublicKey === target.machinePublicKey,
      ) &&
      this.key(target, prefs) === key
    );
  }

  private resync(): void {
    const prefs = this.prefs;
    if (!prefs) return;
    for (const target of this.targets) {
      const key = this.key(target, prefs);
      if (this.running.has(target.connectionId) || this.settled.get(target.connectionId) === key)
        continue;
      void this.attempt(target, key, prefs);
    }
  }

  private async attempt(
    target: SecurePushTarget,
    key: string,
    prefs: PushPreferences,
  ): Promise<void> {
    const id = target.connectionId;
    this.running.add(id);
    let outcome: SecurePushOutcome | null = null;
    try {
      let prepared: PreparedSecurePush;
      try {
        prepared = await this.port.prepare(target.machinePublicKey);
        if (!this.current(target, key)) return;
        await prepared.validate();
      } catch {
        this.settled.set(id, key);
        outcome = { kind: 'unavailable' };
        return;
      }
      if (!this.current(target, key)) return;
      // Sent synchronously after validation: nothing can change the ticket in between.
      const reply = this.port.register(id, { ...prepared.metadata, pushPrefs: prefs });
      this.settled.set(id, key);
      try {
        const result = await reply;
        outcome = result.success
          ? { kind: 'registered' }
          : { kind: 'refused', error: result.error };
      } catch {
        // Disconnected or timed out: the daemon may or may not have stored it.
        // The next reconnect registers again.
        outcome = { kind: 'unverified' };
      }
    } finally {
      this.running.delete(id);
      if (outcome) this.onOutcome(id, outcome);
      this.resync();
    }
  }
}
