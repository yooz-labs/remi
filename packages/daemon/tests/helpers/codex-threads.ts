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

/**
 * Turn and item frames (phase 6, #1180). Each is a real frame of the spike re-addressed to a
 * thread a test chooses, so a test reads the shapes Codex 0.160.0 sent:
 * `turn/completed` is `expA-accept.jsonl:74`, and the items are the `item` of
 * `item/completed` for a user message (`:36`), a command (`:56`) and the final agent message
 * (`:67`).
 *
 * No real frame of an INTERRUPTED or FAILED turn exists: the spike's decline run, where a phone
 * No ends the turn, still reports `status: "completed"` at `expA-decline.jsonl:141`, and a
 * failure was never provoked. `turnCompletedFrame` builds those two from the real completed
 * frame with `status` and `error` set to the shapes of the generated schema (`Turn`, `TurnError`,
 * `CodexErrorInfo`); live step LV-5 checks them. Likewise the `thread/items/list` page of
 * `itemsListPage` is the generated schema's `ThreadItemsListResponse` around real items (no real
 * response was captured).
 */

/** The turn id of the real accept run's frames (`expA-accept.jsonl:74`). */
const placeholderTurnId = '00000000-0000-7000-8000-000000000002';

/** The source lines of `expA-accept.jsonl` the real items come from. */
const ITEM_LINES = { userMessage: 36, commandExecution: 56, agentMessage: 67 } as const;

/** A copy of a real item, with `over` laid on top (a field set to `undefined` is removed). */
export function realItem(kind: keyof typeof ITEM_LINES, over: Json = {}): Json {
  const frame = fixtureFrameAt('expA-accept.jsonl', ITEM_LINES[kind]).frame as {
    params: { item: Json };
  };
  const copy = { ...(JSON.parse(JSON.stringify(frame.params.item)) as Json), ...over };
  for (const [key, value] of Object.entries(copy)) {
    if (value === undefined) Reflect.deleteProperty(copy, key);
  }
  return copy;
}

/** The final agent message of the spike's accept run (`phase: "final_answer"`), with `over` on top. */
export function agentMessageItem(
  id: string,
  text: string,
  phase: 'final_answer' | 'commentary' | null,
): Json {
  return realItem('agentMessage', { id, text, phase });
}

/** A user message item (the real shape: `content` is a list of input parts). */
export function userMessageItem(id: string, text: string): Json {
  return realItem('userMessage', {
    id,
    content: [{ type: 'text', text, text_elements: [] }],
  });
}

/** An `item/completed` notification for `item`, as the real frame at `expA-accept.jsonl:67` has it. */
export function itemCompletedFrame(
  threadId: string,
  item: Json,
  over: { turnId?: string; completedAtMs?: number } = {},
): Json {
  return {
    method: 'item/completed',
    params: {
      item,
      threadId,
      turnId: over.turnId ?? placeholderTurnId,
      completedAtMs: over.completedAtMs ?? 1700000001017,
    },
    emittedAtMs: (over.completedAtMs ?? 1700000001017) + 3,
  };
}

export interface TurnCompletedOptions {
  status?: string;
  /** `Turn.error`: the schema's `TurnError`, or null. */
  error?: Json | null;
  /** `Turn.durationMs`; the real frame has 5563. */
  durationMs?: number | null;
  /** `Turn.items`; the real frame has the one final agent message. */
  items?: Json[];
}

/** A `turn/completed` notification for `threadId`, the real frame of `expA-accept.jsonl:74` with `over` on top. */
export function turnCompletedFrame(threadId: string, over: TurnCompletedOptions = {}): Json {
  const frame = JSON.parse(JSON.stringify(fixtureFrameAt('expA-accept.jsonl', 74).frame)) as {
    params: { threadId: string; turn: Json };
  } & Json;
  frame.params.threadId = threadId;
  const turn = frame.params.turn;
  // `in`, not `!== undefined`: a test may set a field to `undefined` to build a frame without it.
  if ('status' in over) turn['status'] = over.status;
  if ('error' in over) turn['error'] = over.error;
  if ('durationMs' in over) turn['durationMs'] = over.durationMs;
  if ('items' in over) turn['items'] = over.items;
  return frame;
}

/** The schema's `TurnError`, for a failed turn. */
export function turnError(message: string, codexErrorInfo: unknown = null): Json {
  return { message, codexErrorInfo, additionalDetails: null, misalignment: null };
}

/**
 * A `thread/items/list` result page (the schema's `ThreadItemsListResponse`: `data` is a list of
 * `ThreadItemEntry`, `nextCursor` is null on the last page).
 */
export function itemsListPage(
  entries: ReadonlyArray<{ item: Json; turnId?: string; completedAtMs?: number | null }>,
  nextCursor: string | null,
): Json {
  return {
    data: entries.map((e) => ({
      turnId: e.turnId ?? placeholderTurnId,
      item: e.item,
      startedAtMs: null,
      completedAtMs: e.completedAtMs === undefined ? 1700000001017 : e.completedAtMs,
    })),
    nextCursor,
    backwardsCursor: entries.length > 0 ? 'backwards-cursor' : null,
  };
}
