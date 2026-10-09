/**
 * Successful hub starts retain their main repository after the session or worktree is gone
 * (#1284). This convenience history has no age expiry, only a cap of 20. Wrapper sessions
 * still contribute through the session store. No session ids or harness state are stored here.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { escapeUnsafeText } from '@remi/shared';
import { logError } from '../cli/logger.ts';
import { remiHome } from '../config/remi-home.ts';
import { withInterprocessFileLockAsync } from '../storage/interprocess-file-lock.ts';
import { writeRestrictedJson } from '../storage/restricted-json.ts';
import { hasControl } from './git.ts';
import { MAX_RECENT_REPOSITORIES, recentRepositories } from './recent.ts';

export interface RememberedRepository {
  readonly repository: string;
  readonly lastUsedAt: string;
}

function validRecord(value: unknown): value is RememberedRepository {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const repository = record['repository'];
  const time = record['lastUsedAt'];
  return (
    Object.keys(record).length === 2 &&
    typeof repository === 'string' &&
    path.isAbsolute(repository) &&
    !hasControl(repository) &&
    escapeUnsafeText(repository) === repository &&
    typeof time === 'string' &&
    Number.isFinite(Date.parse(time)) &&
    new Date(time).toISOString() === time
  );
}

export class RecentRepositoryStore {
  constructor(readonly filePath = path.join(remiHome(), 'recent-repositories.json')) {}

  /** Atomic rename gives readers a complete file without acquiring the writer's lock. */
  list(): RememberedRepository[] {
    try {
      const value: unknown = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      if (
        !Array.isArray(value) ||
        value.length > MAX_RECENT_REPOSITORIES ||
        !value.every(validRecord)
      ) {
        throw new Error('invalid history');
      }
      return value;
    } catch (error) {
      if ((error as { code?: unknown })?.code !== 'ENOENT') {
        // Fail open for this convenience list; neither file contents nor paths enter the log.
        logError('[RecentRepositories] could not read repository history; ignoring the file');
      }
      return [];
    }
  }

  /** `repository`, when supplied, is the main repository already resolved by prepareWorkspace. */
  async remember(directory: string, repository?: string): Promise<void> {
    const lastUsedAt = new Date().toISOString();
    const resolved =
      repository ??
      (
        await recentRepositories([{ projectPath: directory, exitedAt: lastUsedAt }], { limit: 1 })
      )[0]?.repository;
    const record = { repository: resolved, lastUsedAt };
    if (!validRecord(record)) return;
    await withInterprocessFileLockAsync(this.filePath, () => {
      // Read inside the transaction: simultaneous hub starts must not erase one another.
      const records = [record, ...this.list()].sort(
        (a, b) => Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt),
      );
      const seen = new Set<string>();
      const kept = records
        .filter((entry) => {
          if (seen.has(entry.repository)) return false;
          seen.add(entry.repository);
          return true;
        })
        .slice(0, MAX_RECENT_REPOSITORIES);
      writeRestrictedJson(this.filePath, kept);
    });
  }
}
