/**
 * Thread frames for the Codex launch tests (epic #1175, phase 3 #1177): the
 * real `thread/started` frames of the spike (`expB.jsonl:7` is the TUI's own
 * thread, `:12` the title helper that appears about 7 s later), re-addressed to
 * a thread id, a working directory and a creation time a test chooses. The
 * redacted fixtures hold placeholder ids and `/work/project`, which no daemon
 * under test would recognize as its own.
 */
import { fixtureFrameAt } from './codex-fixtures.ts';

export type Json = Record<string, unknown>;

export interface ThreadPatch {
  id: string;
  cwd: string;
  createdAtSec: number;
}

/**
 * A `thread/started` frame: `tui` is the TUI's thread, `title` the helper's.
 * `tweak` may change one field of the `thread` object, to build a frame that
 * breaks exactly one candidate rule.
 */
export function threadStartedFrame(
  kind: 'tui' | 'title',
  patch: ThreadPatch,
  tweak?: (thread: Json) => void,
): Json {
  const frame = JSON.parse(
    JSON.stringify(fixtureFrameAt('expB.jsonl', kind === 'tui' ? 7 : 12).frame),
  ) as Json;
  const thread = (frame['params'] as { thread: Json }).thread;
  thread['id'] = patch.id;
  thread['sessionId'] = patch.id;
  thread['cwd'] = patch.cwd;
  for (const environment of thread['environments'] as Array<Json>) environment['cwd'] = patch.cwd;
  thread['createdAt'] = patch.createdAtSec;
  thread['updatedAt'] = patch.createdAtSec;
  thread['recencyAt'] = patch.createdAtSec;
  tweak?.(thread);
  return frame;
}

export function threadStatusFrame(threadId: string, status: Json): Json {
  return { method: 'thread/status/changed', params: { threadId, status } };
}
