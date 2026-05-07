/**
 * Handler for `remi recent` — browse recent project directories.
 *
 * Two branches:
 *   - Remote: `--host <h>` or `--port <p>` (or `REMI_PORT` env) queries a
 *     running daemon over WebSocket.
 *   - Local: reads the persisted `SessionStore` directly.
 */

import { errorToString } from '@remi/shared';
import type { RecentDirectory } from '@remi/shared';
import { DEFAULT_BASE_PORT } from '../session/session-registry-file.ts';

export interface RecentCommandIO {
  readonly err: (msg: string) => void;
}

const defaultIO: RecentCommandIO = { err: (msg) => console.error(msg) };

export interface RecentCommandOptions {
  readonly port?: number;
  readonly host?: string;
}

/** Injectable helpers so tests avoid the real WebSocket / SessionStore. */
export interface RecentCommandHelpers {
  runRecentClient: (args: { host: string; port: number }) => Promise<void>;
  renderRecentDirectories: (dirs: readonly RecentDirectory[]) => void;
  listLocalDirectories: () => RecentDirectory[];
}

const defaultLoader = async (
  listLocalDirectories: () => RecentDirectory[],
): Promise<RecentCommandHelpers> => {
  const mod = await import('./recent-client.ts');
  return {
    runRecentClient: mod.runRecentClient,
    renderRecentDirectories: mod.renderRecentDirectories,
    listLocalDirectories,
  };
};

export async function runRecentCommand(
  opts: RecentCommandOptions,
  listLocalDirectories: () => RecentDirectory[],
  io: RecentCommandIO = defaultIO,
  loadHelpers: (
    listLocal: () => RecentDirectory[],
  ) => Promise<RecentCommandHelpers> = defaultLoader,
): Promise<number> {
  const envPort = process.env['REMI_PORT'] ? Number.parseInt(process.env['REMI_PORT']) : undefined;
  const explicitPort = opts.port ?? envPort;
  const helpers = await loadHelpers(listLocalDirectories);

  if (opts.host || explicitPort) {
    // Remote mode
    try {
      await helpers.runRecentClient({
        host: opts.host ?? 'localhost',
        port: explicitPort ?? DEFAULT_BASE_PORT,
      });
      return 0;
    } catch (err) {
      io.err(errorToString(err));
      return 1;
    }
  }
  // Local mode
  helpers.renderRecentDirectories(helpers.listLocalDirectories());
  return 0;
}
