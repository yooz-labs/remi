import { logError } from '../cli/logger.ts';
import type { SessionProfileEntry, SessionProfilesFile } from '../session/session-profiles-file.ts';
import type { SessionStore, StoredSession } from '../session/session-store.ts';
import type { Profiles } from './profile-config.ts';
import { isProfileHidden } from './visibility.ts';

export type SessionOwner =
  | { owner: 'default' }
  | { owner: 'profile'; id: string; configured: boolean }
  | { owner: 'hidden' };

export type ProfileSidecarResult =
  | { ok: true; entries: Readonly<Record<string, SessionProfileEntry>> }
  | { ok: false };

export type ProfileSidecar = ProfileSidecarResult | { read(): ProfileSidecarResult };

/** One request's view of remote profile policy and ownership evidence. */
export interface ProfilePolicySnapshot {
  readonly profiles: Profiles;
  readonly sidecar: ProfileSidecar;
}

/** Lazily take one consistent snapshot. No-table bare records never read the sidecar. */
export class ProfileSidecarSnapshot {
  private cached: ProfileSidecarResult | undefined;

  constructor(private readonly file: Pick<SessionProfilesFile, 'snapshot'>) {}

  read(): ProfileSidecarResult {
    if (this.cached) return this.cached;
    try {
      this.cached = { ok: true, entries: this.file.snapshot() };
    } catch {
      this.cached = { ok: false };
    }
    return this.cached;
  }
}

export function readProfileSidecar(file: Pick<SessionProfilesFile, 'snapshot'>): ProfileSidecar {
  return new ProfileSidecarSnapshot(file);
}

function snapshotResult(sidecar: ProfileSidecar): ProfileSidecarResult {
  return 'read' in sidecar ? sidecar.read() : sidecar;
}

/** Adapt the request's snapshot to the launch-time ownership validator. */
export function sidecarGetter(sidecar: ProfileSidecar): Pick<SessionProfilesFile, 'get'> {
  return {
    get(id) {
      const result = snapshotResult(sidecar);
      if (!result.ok) throw new Error('Session profile snapshot unavailable');
      return result.entries[id];
    },
  };
}

const loggedDrops = new Set<string>();

/**
 * Record, once per place and id prefix, that remote policy left a session out because its owner
 * could not be read (PR 1828 round 1 F4). Only the first eight characters of the id are logged:
 * never a path, a label, a profile id or the error, which can carry a path.
 */
export function logPolicyDrop(
  where: string,
  id: string,
  write: (line: string) => void = logError,
): void {
  const key = `${where}:${id.slice(0, 8)}`;
  if (loggedDrops.has(key)) return;
  // A long-lived hub keeps no unbounded history of ids.
  if (loggedDrops.size >= 1000) loggedDrops.clear();
  loggedDrops.add(key);
  write(`[Profiles] ${where}: left out ${id.slice(0, 8)}; its owner could not be read`);
}

/** Resolve remote ownership without trusting fields an older writer could strip. */
export function sessionProfileOwner(
  input: StoredSession | { transcriptProfile: string | undefined },
  sidecar: ProfileSidecar,
  profiles: Profiles,
): SessionOwner {
  let id: string;
  if ('transcriptProfile' in input) {
    id = input.transcriptProfile ?? 'default';
  } else {
    const bare = !input.profile && !input.profileSnapshot;
    if (bare && 'entries' in profiles && Object.keys(profiles.entries).length === 0)
      return { owner: 'default' };
    const snapshot = snapshotResult(sidecar);
    if (!snapshot.ok) return { owner: 'hidden' };
    const entry = snapshot.entries[input.remiSessionId];
    if (entry && input.profile && entry.profile !== input.profile) return { owner: 'hidden' };
    if (!entry && (input.profile || input.profileSnapshot)) return { owner: 'hidden' };
    id = entry?.profile ?? 'default';
  }
  if (id === 'default') return { owner: 'default' };
  if (isProfileHidden(id, profiles)) return { owner: 'hidden' };
  return { owner: 'profile', id, configured: 'entries' in profiles && !!profiles.entries[id] };
}

/**
 * One strict configuration read and one sidecar snapshot per request (#1749, PR 1828 round 1
 * F2). `cli.ts` runs each remote-policy request inside `run`, and every policy reader it wires
 * (the handlers' getters, the live ports, the hub discovery's `profileRoots`) reads through
 * `profiles` and `sidecar`, so a request and the transcript scans it triggers share one read.
 * The scope covers the synchronous part of `run` only: code that continues after an `await`
 * with a snapshot it was handed re-enters it with `run(fn, snapshot)`. Outside a scope each call
 * reads afresh.
 */
export class RemotePolicyScope {
  private active: { profiles?: Profiles; sidecar?: ProfileSidecar } | null = null;

  constructor(
    private readonly readProfiles: () => Profiles,
    private readonly readSidecar: () => ProfileSidecar,
  ) {}

  run<T>(fn: () => T, snapshot?: ProfilePolicySnapshot): T {
    if (this.active && !snapshot) return fn();
    const prior = this.active;
    this.active = snapshot ? { profiles: snapshot.profiles, sidecar: snapshot.sidecar } : {};
    try {
      return fn();
    } finally {
      this.active = prior;
    }
  }

  readonly profiles = (): Profiles => {
    if (!this.active) return this.readProfiles();
    this.active.profiles ??= this.readProfiles();
    return this.active.profiles;
  };

  readonly sidecar = (): ProfileSidecar => {
    if (!this.active) return this.readSidecar();
    this.active.sidecar ??= this.readSidecar();
    return this.active.sidecar;
  };
}

/** What the owner lookups below need from the stores and the transcript discovery. */
export interface SessionOwnerSources {
  readonly sessionStore: Pick<
    SessionStore,
    'findByRemiSessionId' | 'findResumableByClaudeSessionId' | 'list'
  >;
  readonly discovery: {
    findTranscriptBySessionId(id: string): string | null;
    profileOfTranscript(id: string): string | undefined;
  };
  /** Runs discovery under the request's snapshot (`RemotePolicyScope.run`). */
  readonly within: <T>(fn: () => T, snapshot: ProfilePolicySnapshot) => T;
}

/**
 * `startSession`'s `resumeOwner` (design item 6), as `cli.ts` wires it: a record (Claude by its
 * Claude id, Codex by its thread id) or a record-less Claude transcript, through the resolver.
 */
export function makeResumeOwner(sources: SessionOwnerSources) {
  return (
    harness: string,
    id: string,
    sidecar: ProfileSidecar,
    profiles: Profiles,
  ): { record: boolean; profile?: string; hidden?: boolean } | null =>
    sources.within(
      () => {
        const record =
          harness === 'claude'
            ? sources.sessionStore.findResumableByClaudeSessionId(id)
            : sources.sessionStore
                .list()
                .find(
                  (entry) =>
                    entry.harness === 'codex' && entry.harnessSessionId?.toLowerCase() === id,
                );
        const input =
          record ??
          (harness === 'claude' && sources.discovery.findTranscriptBySessionId(id)
            ? { transcriptProfile: sources.discovery.profileOfTranscript(id) }
            : null);
        if (!input) return null;
        const owner = sessionProfileOwner(input, sidecar, profiles);
        return {
          record: !!record,
          ...(owner.owner === 'hidden'
            ? { hidden: true }
            : owner.owner === 'profile'
              ? { profile: owner.id }
              : {}),
        };
      },
      { profiles, sidecar },
    );
}

/**
 * The transcript-load handler's `isHiddenOwner` (design item 8): the record by remi id or Claude
 * id, else the transcript's root, through the resolver. A lookup that throws fails closed and
 * logs once (F4).
 */
export function makeIsHiddenSessionOwner(
  sources: Omit<SessionOwnerSources, 'within'>,
  policy: () => ProfilePolicySnapshot,
): (id: string) => boolean {
  return (id) => {
    try {
      const { profiles, sidecar } = policy();
      const record =
        sources.sessionStore.findByRemiSessionId(id as StoredSession['remiSessionId']) ??
        sources.sessionStore.findResumableByClaudeSessionId(id);
      const input = record ?? {
        transcriptProfile: sources.discovery.profileOfTranscript(id),
      };
      return sessionProfileOwner(input, sidecar, profiles).owner === 'hidden';
    } catch {
      logPolicyDrop('transcript load', id);
      return true;
    }
  };
}
