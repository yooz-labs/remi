/**
 * Thread frames for the Codex launch tests (epic #1175, phase 3 #1177): the
 * real `thread/started` frames of the spike (`expB.jsonl:7` is the TUI's own
 * thread, `:12` the title helper that appears about 7 s later), re-addressed to
 * a thread id, a working directory and a creation time a test chooses. The
 * redacted fixtures hold placeholder ids and `/work/project`, which no daemon
 * under test would recognize as its own. Phase 4 (#1178) adds the server
 * requests: the real command approval of the spike's accept run, re-addressed,
 * and a schema-derived file-change request.
 */
import { fixtureFrameAt, loadFixtureFrames } from './codex-fixtures.ts';

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

/**
 * A command-approval server request: the real frame of the spike's accept run
 * (`expA-accept.jsonl:47`), re-addressed to a thread and a command a test
 * chooses. `over` replaces or adds `params` fields (`availableDecisions`, `reason`, ...),
 * and a field set to `undefined` is removed. The id is not part of it: the fake
 * server mints daemon-global ids (`FakeAppServer.request`).
 */
export function commandApprovalRequest(
  threadId: string,
  command: string,
  over: Json = {},
): { method: string; params: Json } {
  const { method, params } = fixtureFrameAt('expA-accept.jsonl', 47).frame as {
    method: string;
    params: Json;
  };
  const copy = { ...(JSON.parse(JSON.stringify(params)) as Json), threadId, command, ...over };
  for (const [key, value] of Object.entries(copy)) {
    if (value === undefined) Reflect.deleteProperty(copy, key);
  }
  return { method, params: copy };
}

/**
 * A file-change approval, built from the generated schema (no real frame of this
 * request exists; `synthetic-from-schema.jsonl:1`), addressed to `threadId`.
 */
export function fileChangeRequest(
  threadId: string,
  reason = 'test file change',
): { method: string; params: Json } {
  const { method, params } = loadFixtureFrames('synthetic-from-schema.jsonl')[0]?.frame as {
    method: string;
    params: Json;
  };
  return { method, params: { ...(JSON.parse(JSON.stringify(params)) as Json), threadId, reason } };
}
