/**
 * Narrow parsers for the `thread/*` frames the Codex launch reads (epic #1175,
 * phase 3 #1177). They take `unknown`, keep only the few fields remi decides
 * on, and ignore the rest: a field Codex adds later changes nothing, and a
 * field that is missing or the wrong type makes the answer fail closed (a
 * thread that is "ephemeral" unless the frame says otherwise, a frame that is
 * not a thread at all is `null`). Nothing here logs, so no thread metadata
 * (cwd, preview, path) can reach a log line.
 */

import { UUID_PATTERN } from './codex-args.ts';

/**
 * `thread/status/changed` and `Thread.status`. An unknown flag still makes an
 * `active` thread "waiting": Codex only sets a flag when the thread is blocked
 * on someone, so a flag remi has no name for yet is no reason to call it busy.
 */
export type ThreadStatus =
  | { type: 'notLoaded' }
  | { type: 'idle' }
  | { type: 'systemError' }
  | { type: 'active'; activeFlags: string[] };

/** What identity discovery needs of a `Thread`. */
export interface ThreadInfo {
  id: string;
  cwd: string | null;
  /** True unless the frame says `false`: a thread of unknown kind is never a candidate. */
  ephemeral: boolean;
  /** `createdAt`, in seconds. */
  createdAtSec: number | null;
  parentThreadId: string | null;
  threadSource: string | null;
  path: string | null;
  environmentCount: number;
  status: ThreadStatus | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const stringOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export function parseThreadStatus(v: unknown): ThreadStatus | null {
  if (!isRecord(v)) return null;
  switch (v['type']) {
    case 'notLoaded':
    case 'idle':
    case 'systemError':
      return { type: v['type'] };
    case 'active': {
      const flags = v['activeFlags'];
      return {
        type: 'active',
        activeFlags: Array.isArray(flags)
          ? flags.filter((f): f is string => typeof f === 'string')
          : [],
      };
    }
    default:
      return null;
  }
}

/**
 * A `Thread` (the `thread` of `thread/started` and of a `thread/resume`
 * result), or null when it is not an object with a UUID `id`, or its
 * `parentThreadId` is neither a string nor null. The id is the only field remi
 * persists and prints (in a `remi codex resume` line), so anything but a UUID
 * is not a thread at all: it never binds.
 */
export function parseThread(v: unknown): ThreadInfo | null {
  if (!isRecord(v) || typeof v['id'] !== 'string' || !UUID_PATTERN.test(v['id'])) return null;
  const parent = v['parentThreadId'];
  if (parent !== undefined && parent !== null && typeof parent !== 'string') return null;
  const createdAt = v['createdAt'];
  const environments = v['environments'];
  return {
    id: v['id'],
    cwd: stringOrNull(v['cwd']),
    ephemeral: v['ephemeral'] !== false,
    createdAtSec: typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : null,
    parentThreadId: typeof parent === 'string' ? parent : null,
    threadSource: stringOrNull(v['threadSource']),
    path: stringOrNull(v['path']),
    environmentCount: Array.isArray(environments) ? environments.length : 0,
    status: parseThreadStatus(v['status']),
  };
}
