/** CLI-owned readiness/lifetime; FileDownloadService retains all device/transfer authority. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { HarnessId, UUID } from '@remi/shared';
import type { WebSocketAdapter } from '../adapters/websocket-adapter';
import type { IdentityStore } from '../auth/identity-store';
import type { HarnessSession } from '../harness/types';
import type { SecurePushStore } from '../notifications/secure-push-store';
import type { SessionBindingStore } from '../session/session-binding-store';
import type { ManagedSession, SessionRegistry } from '../session/session-registry';
import type { StoredSession } from '../session/session-store';
import { DirectoryRoot } from './admission';
import { type FileDownloadHostContext, FileDownloadService } from './file-download-service';
import { recoveryNative } from './recovery-native';

export interface DownloadProtectedRoot {
  readonly pathname: string;
  readonly required: boolean;
}

/** Only known launch environment/default paths; no installed settings or credential reads. */
export function downloadProtectionRoots(options: {
  readonly home: string;
  readonly userHome: string;
  readonly workingDirectory: string;
  readonly harness: HarnessId;
  readonly claudeConfigDirectory?: string | undefined;
  readonly codexHome?: string | undefined;
}): readonly DownloadProtectedRoot[] {
  const roots: DownloadProtectedRoot[] = [
    { pathname: path.resolve(options.home), required: true },
    {
      pathname: path.join(options.userHome, '.claude'),
      required: options.harness === 'claude' && !options.claudeConfigDirectory,
    },
    {
      pathname: path.join(options.userHome, '.codex'),
      required: options.harness === 'codex' && !options.codexHome,
    },
  ];
  for (const override of [options.claudeConfigDirectory, options.codexHome])
    if (override)
      roots.push({ pathname: path.resolve(options.workingDirectory, override), required: true });
  const unique = new Map<string, DownloadProtectedRoot>();
  for (const root of roots)
    unique.set(root.pathname, {
      pathname: root.pathname,
      required: root.required || (unique.get(root.pathname)?.required ?? false),
    });
  return [...unique.values()];
}

interface SessionRecord {
  readonly id: UUID;
  readonly project: string;
  readonly rootChoices: readonly DownloadProtectedRoot[];
  readonly startup: Promise<void>;
  readonly finishStartup: () => void;
  readonly pending: Set<Promise<void>>;
  readonly attachments: Map<UUID, object>;
  runtime: HarnessSession | null;
  managed: ManagedSession | null;
  committed: { readonly harness: HarnessId; readonly id: string; readonly project: string } | null;
  started: boolean;
  retired: boolean;
  ready: FileDownloadHostContext | null;
  roots: DirectoryRoot[];
  signature: string | null;
  paths: readonly string[];
  notificationPending: boolean;
  published: FileDownloadHostContext | null;
  closing: Promise<boolean> | null;
}

export class FileDownloadSessionHost {
  private readonly records = new Map<UUID, SessionRecord>();
  private readonly seenRoots = new Set<string>();
  private readonly pending = new Set<Promise<void>>();
  private native: Awaited<ReturnType<typeof recoveryNative>> | undefined;
  private activeService: FileDownloadService | undefined;
  private opening: Promise<boolean> | undefined;
  private closing: Promise<boolean> | undefined;
  private stopped = false;
  private cleanupFailed = false;

  constructor(
    private readonly host: {
      readonly home: string;
      readonly sessions: SessionRegistry;
      readonly bindings: SessionBindingStore;
      readonly runtimeFor: (id: UUID) => HarnessSession | undefined;
      readonly directAdapter: () => WebSocketAdapter | undefined;
      readonly rootsFor: (workingDirectory: string) => readonly DownloadProtectedRoot[];
      readonly onReady: (id: UUID) => void;
    },
  ) {}

  get service(): FileDownloadService | undefined {
    return this.activeService;
  }

  open(identityStore: IdentityStore, relayAuthority?: SecurePushStore): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false);
    this.opening ??= (async () => {
      try {
        this.native = await recoveryNative();
        if (this.stopped) return false;
        const service = await FileDownloadService.open({
          home: this.host.home,
          identityStore,
          ...(relayAuthority && { relayAuthority }),
          sessions: this.host.sessions,
          bindings: this.host.bindings,
          directAdapter: this.host.directAdapter,
          contextFor: (id) => this.contextFor(id),
        });
        this.activeService = service;
        if (this.stopped) return false;
        return true;
      } catch {
        this.cleanupFailed = true;
        return false;
      }
    })();
    return this.opening;
  }

  beginSession(id: UUID, workingDirectory: string): void {
    if (this.stopped || this.records.has(id)) throw new Error('File download session unavailable');
    let finishStartup!: () => void;
    const startup = new Promise<void>((resolve) => {
      finishStartup = resolve;
    });
    this.records.set(id, {
      id,
      project: workingDirectory,
      rootChoices: Object.freeze(
        this.host.rootsFor(workingDirectory).map((root) => Object.freeze({ ...root })),
      ),
      startup,
      finishStartup,
      pending: new Set(),
      attachments: new Map(),
      runtime: null,
      managed: null,
      committed: null,
      started: false,
      retired: false,
      ready: null,
      roots: [],
      signature: null,
      paths: [],
      notificationPending: false,
      published: null,
      closing: null,
    });
  }

  bindSession(id: UUID, runtime: HarnessSession): void {
    const record = this.records.get(id);
    if (!record || record.retired || this.stopped)
      throw new Error('File download session unavailable');
    record.runtime = runtime;
  }

  started(id: UUID): void {
    const record = this.records.get(id);
    if (!record) return;
    record.finishStartup(); // Resolve before any exit/cleanup continuation can join startup.
    record.started = true;
    record.managed = this.host.sessions.getSession(id) ?? null;
    this.contextFor(id);
  }

  private track(record: SessionRecord | undefined, work: Promise<void>): void {
    const tracked = work
      .catch(() => {
        this.cleanupFailed = true;
      })
      .finally(() => {
        this.pending.delete(tracked);
        record?.pending.delete(tracked);
      });
    this.pending.add(tracked);
    record?.pending.add(tracked);
  }

  private clear(record: SessionRecord): void {
    const previous = record.ready;
    record.ready = null;
    if (previous && this.activeService)
      this.track(record, this.activeService.invalidateSession(record.id));
  }

  beforeBindingWrite(id: UUID): void {
    const record = this.records.get(id);
    if (record) {
      this.clear(record);
      record.committed = null;
    }
  }

  afterClaudeCommit(id: UUID, expected: string | null, mirrorVerified: boolean): void {
    const record = this.records.get(id);
    if (!record || !mirrorVerified || !expected) return;
    const identity = this.host.bindings.getIdentity(id);
    if (identity?.harness === 'claude' && identity.harnessSessionId === expected) {
      // C3 has already checked its durable mirror. The registered directory is checked below.
      record.committed = { harness: 'claude', id: expected, project: record.project };
      this.contextFor(id);
    }
  }

  afterHarnessIdentityCommit(
    id: UUID,
    harness: Exclude<HarnessId, 'claude'>,
    expected: string | null,
    committed: StoredSession | null,
  ): void {
    const record = this.records.get(id);
    if (
      !record ||
      !expected ||
      !committed ||
      committed.remiSessionId !== id ||
      committed.harness !== harness ||
      committed.harnessSessionId !== expected
    )
      return;
    const identity = this.host.bindings.getIdentity(id); // Disk-fresh, never a cached observer claim.
    if (identity?.harness === harness && identity.harnessSessionId === expected) {
      record.committed = { harness, id: expected, project: committed.projectPath };
      this.contextFor(id);
    }
  }

  /** Exact metadata ENOENT only; every ancestor must be a readable real directory. */
  private rootMetadata(root: DownloadProtectedRoot): string | null {
    if (
      !path.isAbsolute(root.pathname) ||
      path.normalize(root.pathname) !== root.pathname ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(root.pathname)
    )
      throw new Error('Unavailable');
    let current = path.parse(root.pathname).root;
    const identities: string[] = [];
    for (const part of ['', ...root.pathname.split(path.sep).filter(Boolean)]) {
      if (part) current = path.join(current, part);
      let stat: fs.BigIntStats;
      try {
        stat = fs.lstatSync(current, { bigint: true });
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code === 'ENOENT' &&
          !root.required &&
          !this.seenRoots.has(root.pathname)
        )
          return null;
        throw error;
      }
      if (current === root.pathname && !root.required) this.seenRoots.add(root.pathname);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unavailable');
      if (!(stat.mode & 0o444n) || !(stat.mode & 0o111n)) throw new Error('Unavailable');
      fs.accessSync(current, fs.constants.R_OK | fs.constants.X_OK);
      identities.push(`${stat.dev}:${stat.ino}:${stat.mode}`);
    }
    return `${root.pathname}:${identities.join('/')}`;
  }

  private closeRoots(record: SessionRecord): void {
    const roots = record.roots;
    record.roots = [];
    record.signature = null;
    record.paths = [];
    for (const root of roots) {
      try {
        root.close();
      } catch {
        this.cleanupFailed = true;
      }
    }
  }

  private protection(record: SessionRecord): boolean {
    if (!this.native || this.cleanupFailed) return false;
    try {
      const present: DownloadProtectedRoot[] = [];
      const metadata: string[] = [];
      for (const root of record.rootChoices) {
        const value = this.rootMetadata(root);
        if (value !== null) {
          present.push(root);
          metadata.push(value);
        }
      }
      if (!present.length) throw new Error('Unavailable');
      const signature = metadata.join('\n');
      if (record.signature === signature && record.roots.every((root) => root.isCurrent()))
        return true;
      this.clear(record); // Appearance/replacement invalidates before expanded context publication.
      this.closeRoots(record);
      const openAt = this.native.ops.openAt.bind(this.native.ops);
      for (const root of present) {
        const captured = DirectoryRoot.capture(root.pathname, openAt);
        if (!captured) throw new Error('Unavailable');
        record.roots.push(captured);
      }
      record.signature = signature;
      record.paths = Object.freeze(present.map((root) => root.pathname));
      return true;
    } catch {
      this.clear(record);
      this.closeRoots(record);
      return false;
    }
  }

  contextFor(id: UUID): FileDownloadHostContext | null {
    const record = this.records.get(id);
    if (!record || this.stopped || record.retired || !record.started || !this.activeService)
      return null;
    try {
      const session = this.host.sessions.getSession(id);
      const identity = this.host.bindings.getIdentity(id);
      const committed = record.committed;
      if (
        !record.runtime ||
        this.host.runtimeFor(id) !== record.runtime ||
        !session ||
        session !== record.managed ||
        session.pty !== record.runtime.pty ||
        !session.pty.isRunning ||
        !committed ||
        identity?.harness !== committed.harness ||
        identity.harnessSessionId !== committed.id ||
        committed.project !== session.workingDirectory ||
        record.project !== session.workingDirectory ||
        !this.protection(record)
      ) {
        this.clear(record);
        return null;
      }
      if (!record.ready) {
        record.ready = Object.freeze({ runtime: record.runtime, protectedRootPaths: record.paths });
        if (!record.notificationPending) {
          record.notificationPending = true;
          queueMicrotask(() => {
            record.notificationPending = false;
            // Outside any caller's nonreentrant grant lock; no poll or replay.
            if (
              !this.stopped &&
              !record.retired &&
              record.ready &&
              record.published !== record.ready
            ) {
              record.published = record.ready;
              this.host.onReady(id);
            }
          });
        }
      }
      return record.ready;
    } catch {
      this.clear(record);
      return null;
    }
  }

  attachmentsChanged(id: UUID): void {
    const record = this.records.get(id);
    if (!record) return;
    // Registry invokes this synchronously after token mutation, before another async effect.
    for (const [connection, token] of record.attachments)
      if (this.host.sessions.getAttachmentToken(connection) !== token)
        this.invalidateConnection(connection);
    record.attachments.clear();
    for (const connection of this.host.sessions.getSession(id)?.attachedConnections ?? []) {
      const token = this.host.sessions.getAttachmentToken(connection);
      if (token) record.attachments.set(connection, token);
    }
  }

  invalidateConnection(id: UUID): void {
    const record = [...this.records.values()].find((value) => value.attachments.has(id));
    if (this.activeService) this.track(record, this.activeService.invalidateConnection(id));
  }

  retireSession(id: UUID): void {
    const record = this.records.get(id);
    if (record) {
      this.clear(record);
      record.retired = true;
    }
  }

  failed(id: UUID): Promise<boolean> {
    const record = this.records.get(id);
    record?.finishStartup();
    return this.closeSession(id);
  }

  closeSession(id: UUID): Promise<boolean> {
    const record = this.records.get(id);
    if (!record) return Promise.resolve(!this.cleanupFailed);
    this.retireSession(id);
    record.closing ??= (async () => {
      await record.startup;
      await Promise.all([...record.pending]);
      this.closeRoots(record);
      if (!this.cleanupFailed && this.records.get(id) === record) this.records.delete(id);
      return !this.cleanupFailed;
    })();
    return record.closing;
  }

  cancelAll(): void {
    this.stopped = true;
    for (const record of this.records.values()) this.retireSession(record.id);
  }

  closeAll(): Promise<boolean> {
    this.cancelAll();
    this.closing ??= (async () => {
      await this.opening;
      await Promise.all([...this.records.values()].map((record) => this.closeSession(record.id)));
      await Promise.all([...this.pending]);
      if (this.activeService && !(await this.activeService.close())) this.cleanupFailed = true;
      try {
        this.native?.close();
      } catch {
        this.cleanupFailed = true;
      }
      this.native = undefined;
      return !this.cleanupFailed;
    })();
    return this.closing;
  }
}
