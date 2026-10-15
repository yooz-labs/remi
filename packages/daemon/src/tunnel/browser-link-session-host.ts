/** CLI-owned browser producer lifetime. Device/receiver authority remains in BrowserLinkService. */
import { tmpdir } from 'node:os';
import type { UUID } from '@remi/shared';
import type { WebSocketAdapter } from '../adapters/websocket-adapter.ts';
import type { IdentityStore } from '../auth/identity-store.ts';
import type { HarnessSession } from '../harness/types.ts';
import type { PTYSession } from '../pty/pty-session.ts';
import type { SessionBindingStore } from '../session/session-binding-store.ts';
import type { SessionRegistry } from '../session/session-registry.ts';
import {
  type BrowserLinkProducerContext,
  BrowserLinkProducerRuntime,
} from './browser-link-producer.ts';
import type { BrowserLinkService } from './browser-link-service.ts';

const FAILURE = 'Browser link session unavailable';
interface RecordState {
  readonly id: UUID;
  readonly producer: BrowserLinkProducerRuntime;
  context: BrowserLinkProducerContext;
  readonly ended: Promise<void>;
  readonly resolveEnded: () => void;
  startup: Promise<void>;
  ready: BrowserLinkProducerContext | null;
  unavailable: boolean;
  cancelled: boolean;
  startEntered: boolean;
  invalidated: boolean;
  consumerEnded: boolean;
  externalClosing: boolean;
  pty: PTYSession | null;
  session: HarnessSession | null;
  cleanup: Promise<void> | null;
}
export interface BrowserLinkLaunch {
  readonly browserPath: string;
  check(): void;
  attach(pty: PTYSession): void;
  starting(): void;
  started(): void;
  consumerEnded(): void;
  failed(): Promise<void>;
  dispose(): void;
}
export class BrowserLinkSessionHost {
  private readonly records = new Map<UUID, RecordState>();
  private closing = false;
  private startupPending = true;
  private startupSucceeded = false;
  private readonly startup: Promise<boolean>;
  private resolveStartup!: (ready: boolean) => void;
  constructor(
    private readonly host: {
      readonly sessions: SessionRegistry;
      readonly bindings: SessionBindingStore;
      readonly service: () => BrowserLinkService | undefined;
      readonly temporaryRoot?: string;
    },
  ) {
    this.startup = new Promise((resolve) => {
      this.resolveStartup = resolve;
    });
  }
  get pending(): boolean {
    return this.startupPending;
  }
  waitForStartup(): Promise<boolean> {
    return this.startup;
  }
  finishStartup(ready: boolean): void {
    if (!this.startupPending) return;
    this.startupPending = false;
    this.startupSucceeded = ready && !this.closing;
    this.resolveStartup(this.startupSucceeded);
  }
  /** Startup readiness only; the same original signed grant and concrete socket must survive. */
  async waitForConnection(
    id: UUID,
    adapter: WebSocketAdapter,
    identityStore: IdentityStore,
  ): Promise<boolean> {
    const connection = adapter.getDirectConnection(id);
    const key = connection?.connectionClientPublicKey;
    const fingerprint = connection?.connectionClientFingerprint;
    if (
      !connection ||
      connection.connectionListenerTransport !== 'public-tls' ||
      !key ||
      !fingerprint
    )
      return true; // Existing local-capability/query, relay, hub and nonselected paths.
    if (!this.pending) {
      if (this.startupSucceeded && !this.closing) return true;
      connection.close('Browser link session startup failed');
      return false;
    }
    try {
      const grant = identityStore.withAuthorizationEpochNonblocking(key, (epoch) => epoch, true);
      const ready = await this.waitForStartup();
      const current = identityStore.withAuthorizationEpochNonblocking(key, (epoch) => epoch);
      if (
        ready &&
        grant &&
        current === grant &&
        connection.isConnected &&
        adapter.getDirectConnection(id) === connection &&
        connection.connectionClientPublicKey === key &&
        connection.connectionClientFingerprint === fingerprint
      )
        return true;
    } catch {}
    connection.close('Browser link session startup failed');
    return false;
  }
  contextFor(id: UUID): BrowserLinkProducerContext | null {
    return this.records.get(id)?.ready ?? null;
  }
  private clear(record: RecordState): void {
    record.ready = null;
    this.host.service()?.invalidateSession(record.id);
  }
  private retire(record: RecordState): void {
    this.clear(record);
    record.cancelled = true;
    record.producer.retire();
  }
  private check(record: RecordState): void {
    if (
      this.closing ||
      record.cancelled ||
      record.unavailable ||
      this.records.get(record.id) !== record
    )
      throw new Error(FAILURE);
  }
  async prepare(id: UUID, expectedBinding: string): Promise<BrowserLinkLaunch> {
    if (this.closing || this.records.has(id)) throw new Error(FAILURE);
    const binding = this.host.bindings.getIdentity(id);
    if (binding?.harness !== 'claude' || binding.harnessSessionId !== expectedBinding)
      throw new Error(FAILURE);
    const initial: BrowserLinkProducerContext = {
      sessionId: id,
      binding: { harness: 'claude', harnessSessionId: expectedBinding },
      runtime: {},
    };
    let resolveEnded!: () => void;
    const ended = new Promise<void>((resolve) => {
      resolveEnded = resolve;
    });
    const producer = new BrowserLinkProducerRuntime({
      context: initial,
      temporaryRoot: this.host.temporaryRoot ?? tmpdir(),
      offer: (context, url) => this.host.service()?.offer(context, url) ?? false,
      onUnavailable: () => {
        // Clear readiness before any downstream notification, and never recursively retire.
        record.ready = null;
        record.unavailable = true;
        this.host.service()?.invalidateSession(id);
      },
    });
    const record: RecordState = {
      id,
      producer,
      context: initial,
      ended,
      resolveEnded,
      startup: Promise.resolve(),
      ready: null,
      unavailable: false,
      cancelled: false,
      startEntered: false,
      invalidated: false,
      consumerEnded: false,
      externalClosing: false,
      pty: null,
      session: null,
      cleanup: null,
    };
    this.records.set(id, record); // Owned before the first awaited producer operation.
    record.startup = producer.start();
    try {
      await record.startup;
      this.check(record);
      if (record.invalidated) throw new Error(FAILURE);
      const current = this.host.bindings.getIdentity(id);
      if (current?.harness !== 'claude' || current.harnessSessionId !== expectedBinding)
        throw new Error(FAILURE);
    } catch (error) {
      this.retire(record);
      record.consumerEnded = true; // No PTY was constructed or returned by prepare.
      record.resolveEnded();
      try {
        await this.closeRecord(record);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], FAILURE);
      }
      throw new Error(FAILURE);
    }
    return {
      browserPath: producer.browserPath,
      check: () => this.check(record),
      attach: (pty) => {
        this.check(record);
        record.pty = pty;
      },
      starting: () => {
        this.check(record);
        if (record.startEntered || record.invalidated) throw new Error(FAILURE);
        record.startEntered = true;
      },
      started: () => {
        this.check(record);
        if (record.invalidated) throw new Error(FAILURE);
        const session = this.host.sessions.getSession(id);
        if (!record.pty?.isRunning || session?.pty !== record.pty) throw new Error(FAILURE);
        const current = this.host.bindings.getIdentity(id);
        if (
          current?.harness !== 'claude' ||
          current.harnessSessionId !== record.context.binding.harnessSessionId
        )
          throw new Error(FAILURE);
        record.ready = record.context;
      },
      consumerEnded: () => {
        record.consumerEnded = true;
        record.resolveEnded();
        this.retire(record);
      },
      failed: async () => {
        this.retire(record);
        if (!record.pty || record.pty.childPid === null) {
          record.consumerEnded = true; // Exact captured PTY never spawned a child.
          record.resolveEnded();
        }
        await this.closeRecord(record);
      },
      dispose: () => {
        this.retire(record);
        if (!record.startEntered) {
          record.consumerEnded = true;
          record.resolveEnded();
          // Retained in records while closing; closeAll joins it, including a failed close.
          void this.closeRecord(record).catch(() => {});
        }
      },
    };
  }
  bindSession(id: UUID, session: HarnessSession): void {
    const record = this.records.get(id);
    if (!record) return;
    this.check(record);
    if (record.pty !== session.pty) throw new Error(FAILURE);
    record.session = session;
  }
  beforeBindingWrite(id: UUID): void {
    const record = this.records.get(id);
    if (record) {
      this.clear(record);
      record.invalidated = true;
    }
  }
  afterBindingCommit(id: UUID, expected: string | null, mirrorVerified = true): void {
    const record = this.records.get(id);
    if (!mirrorVerified) {
      if (record) this.clear(record);
      throw new Error(FAILURE);
    }
    if (!record) return;
    this.clear(record);
    try {
      this.check(record);
      const session = this.host.sessions.getSession(id);
      const binding = this.host.bindings.getIdentity(id);
      const running = !!record.pty?.isRunning && session?.pty === record.pty;
      const prestartAdoption =
        !record.startEntered && expected === record.context.binding.harnessSessionId;
      if (
        !expected ||
        (!running && !prestartAdoption) ||
        binding?.harness !== 'claude' ||
        binding.harnessSessionId !== expected
      )
        throw new Error(FAILURE);
      const context: BrowserLinkProducerContext = {
        sessionId: id,
        binding: { harness: 'claude', harnessSessionId: expected },
        runtime: {},
      };
      record.producer.rotate(context);
      record.context = context;
      record.invalidated = false;
      record.ready = running ? context : null;
    } catch {
      throw new Error(FAILURE);
    }
  }
  retireSession(id: UUID, externallyClosing = false): void {
    const record = this.records.get(id);
    if (record) {
      record.externalClosing ||= externallyClosing;
      this.retire(record);
    }
  }
  closeSession(id: UUID): Promise<void> {
    const record = this.records.get(id);
    if (!record) return Promise.resolve();
    this.retire(record);
    return this.closeRecord(record);
  }
  private closeRecord(record: RecordState): Promise<void> {
    if (record.cleanup) return record.cleanup;
    record.cleanup = (async () => {
      await record.startup.catch(() => {});
      const errors: unknown[] = [];
      try {
        record.session?.dispose();
      } catch (error) {
        errors.push(error);
      }
      if (!record.startEntered && !record.pty?.childPid) {
        record.consumerEnded = true;
        record.resolveEnded();
      }
      if (!record.consumerEnded && record.externalClosing) await record.ended;
      if (!record.consumerEnded && record.pty) {
        try {
          await record.pty.close();
        } catch (error) {
          errors.push(error);
        }
      }
      if (!record.consumerEnded) throw new AggregateError(errors, FAILURE);
      await record.ended; // Resolved only by actual exit or explicit never-spawned proof.
      await record.producer.close();
      if (errors.length) throw new AggregateError(errors, FAILURE);
      if (this.records.get(record.id) === record) this.records.delete(record.id);
    })().catch((error) => {
      record.cleanup = null;
      throw error;
    });
    return record.cleanup;
  }
  cancelAll(): void {
    this.closing = true;
    this.finishStartup(false);
    for (const record of this.records.values()) this.retire(record);
  }
  async closeAll(): Promise<void> {
    this.cancelAll();
    const outcomes = await Promise.allSettled(
      [...this.records.values()].map((record) => this.closeRecord(record)),
    );
    const errors = outcomes.flatMap((outcome) =>
      outcome.status === 'rejected' ? [outcome.reason] : [],
    );
    if (errors.length) throw new AggregateError(errors, FAILURE);
  }
}
