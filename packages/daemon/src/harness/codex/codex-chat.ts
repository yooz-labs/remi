/**
 * Codex chat (#1180, Phase 6 of the Codex epic #1175): a session's history and live
 * messages, read from the app-server and sent to clients as `transcript_content`, the
 * message Claude's transcript bridge produces from a file.
 *
 * The app-server pages a thread's items (`thread/items/list`, the schema's own advice
 * over reading the rollout file) and announces each finished one live (`item/completed`).
 * Both go through one mapping:
 *
 * - `userMessage` is a user message, its text parts joined;
 * - `agentMessage` is an assistant message (commentary and final answer alike: the TUI
 *   shows both);
 * - `commandExecution` is an assistant tool entry named `shell`: the command as the
 *   tool's input and its output as the result, 500 characters each as Claude bounds a
 *   tool (cut first, on a code point, then every control, invisible and bidirectional
 *   character written out as visible text), and an error when the command failed, was
 *   declined or exited non-zero. One still running is left for its completion, which
 *   arrives live;
 * - everything else (reasoning, plans, file changes, tool calls, items of a newer Codex)
 *   is not chat and is skipped.
 *
 * The entry id of a message is the item's id, so a history read and a live frame of the
 * same item carry the same `entryUuid` and a client that has one drops the other.
 *
 * History (`readHistory`, reached through `HarnessSession.chat` and the transcript load
 * request) goes to the one client that asked, oldest first, a page at a time, structured by
 * a MessageAPI of its own: nothing is added to the session's message stream. A thread that
 * has no history yet ("no rollout found", as `thread/resume` answers before the first
 * message) is an empty history; every other failure is an error the client is told about,
 * in words that carry no server text.
 *
 * Live messages go out through the session's `sendAndRecord`, structured by the session's
 * own MessageAPI, as Claude's binder does, so a client connected now sees them and one
 * connecting later replays them. The message is built once: when a send fails the built
 * message is kept for the retry, because the MessageAPI sent its structured output when it
 * built it and a rebuild would send that twice.
 *
 * What completed BEFORE remi attached (the first prompt of every new thread, and anything
 * between a reconnect's drop and its re-attach) is never announced live: item and turn frames
 * reach only the connection that is attached (`expA-accept.jsonl`: the second connection never
 * receives the first `userMessage`). So the session tells the chat about each attach
 * (`attaching` when `thread/resume` is SENT, `catchUp` when it succeeded, `attachFailed` when
 * it did not), and the chat reads the thread's history once, through the same paging code as
 * `readHistory`, and sends the items not yet delivered.
 *
 * - The history is delivered only when the whole thread fits in ONE page (100 items): a longer
 *   thread or oversized returned page is skipped with a line in the log and left to an explicit read. A catch-up of many
 *   pages is hundreds of replayed messages, and the replay buffer (1000 messages, of which a
 *   late client replays the last 200) would lose its earlier records, the rotation and link
 *   notices among them.
 * - It goes out as `transcript_content` ONLY, structured by a MessageAPI of its own, as an
 *   explicit read does: the web client draws an entry from the structure inside its
 *   `transcript_content`, and a `structured_agent_output` as well would double the replay and,
 *   in a bound Telegram chat, be one more message per entry.
 * - Live items are HELD from the moment `thread/resume` is sent until the history has gone out
 *   (not from the moment it succeeds: the app-server may write an item right behind the
 *   response, in one chunk, and the client hands over every frame of a chunk before a callback
 *   of the response runs). They go out after the history, in the order they came, so a prompt is
 *   not preceded by the answer it caused. The role is read again when they go out: an item of a
 *   thread that is no longer the session's is dropped.
 * - The hold ends when a read ends and no attach is out (an attach that is out has a history
 *   of its own still to come), or when an attach fails with no read running (they go out in
 *   arrival order at once).
 * - Bounds: at most 256 items are held. The 257th finds it full: the held ones go out first, in
 *   order, then it, the history is NOT sent after them (it would be out of order) and one line
 *   says so; an explicit read has the history. A read takes one page at 3 s a request, so a
 *   server that never answers holds live chat for 3 s, and one that answers slowly for as long
 *   as the read and its follow-ups last. Each page times out at 3 s, but repeated attaches can
 *   keep the hold across further reads; the 256-item overflow still ends it.
 * - If the tracked thread changed while the read ran (a rotation), the history of the old
 *   thread is skipped with a line, and the follow-up read gives the new thread its own.
 * - A failure is logged without content and never breaks the attach; a reconnect sends nothing
 *   twice (the delivered ids are remembered, the last 1024).
 * - `dispose` drops what is held and sends nothing more, and builds nothing more: building a
 *   message makes the MessageAPI send structured output through a path the session cannot
 *   stop.
 *
 * An explicit read (`readHistory`) is bounded too: a cursor that comes back (any earlier one,
 * not only the last), 1000 pages or 60 seconds (checked after each page, so a request in flight
 * can run past it, up to its own 15 s timeout) end it, one read of a session runs at a time
 * with one waiting (a third is refused), and it stops asking as soon as `emit` throws, which
 * the transcript handler does when a send to the requester is refused. Only the session's own
 * (`main`) thread counts: a subagent's items and another window's are not this chat (subagent
 * chat is out of scope).
 *
 * A turn or item id longer than 200 characters is treated as no id (`ID_MAX_LENGTH`): an item
 * with one is not chat, and is not shown; the id is copied into every message and remembered.
 * A command and its output are cut to 500 code points each, whole characters.
 *
 * What no real frame has shown yet (live step LV-5): see ADR 0033 (Phase 6 amendment, item 9),
 * the single source of that list.
 *
 * Message prose (a user's or the agent's text) is NOT escaped, deliberately: it is shown as the
 * model or the person wrote it, and escaping would break an emoji sequence at its zero-width
 * joiner. Claude's transcript bridge does the same with Claude's text, and the push of a final
 * answer is made safe separately (`codex-turns.ts`).
 *
 * Nothing a message says is logged: not its text, its command or its output.
 */

import type { Message, ProtocolMessage, TranscriptContentBlock, UUID } from '@remi/shared';
import type { TranscriptContentMessage } from '@remi/shared';
import { createTranscriptContent, escapeUnsafeText, generateId, now } from '@remi/shared';

import { MessageAPI } from '../../api/message-api.ts';
import type { HarnessChat } from '../types.ts';
import {
  type AppServerClient,
  AppServerDisconnectedError,
  AppServerRpcError,
} from './app-server-client.ts';
import { describeError } from './describe-error.ts';
import { firstCodePoints } from './safe-text.ts';
import { type ThreadItemInfo, parseThreadItem } from './thread-protocol.ts';

/** The items asked for per page. The app-server may give fewer, or more. */
const HISTORY_PAGE_SIZE = 100;
/** An explicit history read stops after this many pages, so a cursor that never ends cannot loop for ever. */
const HISTORY_MAX_PAGES = 1000;
/**
 * The catch-up at an attach reads ONE page and delivers only a thread that ends within it: a longer
 * thread would be hundreds of replayed messages (see the header).
 */
const CATCH_UP_MAX_PAGES = 1;
/** An explicit history read stops once a page has passed this long after its start. */
const EXPLICIT_READ_DEADLINE_MS = 60_000;
/** How long one request of the catch-up may take before it is given up on (the client's own is 15 s). */
const CATCH_UP_REQUEST_TIMEOUT_MS = 3000;
/** How many live items are held until the history has gone out; the next one ends the hold. */
const HOLD_MAX = 256;
/** How many built messages whose send failed are kept for a retry. */
const BUILT_MAX = 64;
/** How many delivered items are remembered to drop a repeat of one. */
const LIVE_MEMORY = 1024;
/** Claude bounds a tool's input and output to this many characters; the shell entry, to this many code points. */
const TOOL_FIELD_MAX = 500;
const SHELL_TOOL = 'shell';
/** JSON-RPC "Invalid Request": what `thread/resume` answers for a thread with nothing written. */
const INVALID_REQUEST = -32600;

export interface CodexChatDeps {
  /** The remi session whose chat this is. */
  sessionId: UUID;
  client: Pick<AppServerClient, 'request'>;
  /** The tracked thread, read when a history is asked for; null until the session has learned it. */
  threadId: () => string | null;
  /** `ThreadTracker.role`: `main` for the tracked thread, `subagent` for a descendant, null for any other. */
  threadRole: (threadId: string) => 'main' | 'subagent' | null;
  /** The session's own message API: structures a live message and, through its events, sends the structured output. */
  messageApi: Pick<MessageAPI, 'handleMessage' | 'getMessage'>;
  /** Send a message to every client and record it for replay. */
  sendAndRecord: (message: ProtocolMessage) => void;
  log: (message: string) => void;
  /** Test seam: how long one request of the catch-up may take (default 3000). */
  catchUpRequestTimeoutMs?: number;
  /** Test seam: a monotonic clock in milliseconds, for the deadline of an explicit read (default `performance.now`). */
  clockMs?: () => number;
}

export interface CodexChat extends HarnessChat {
  /** Feed every notification of the app-server; only an `item/completed` of the main thread does anything. */
  handleNotification(method: string, params: unknown): void;
  /**
   * A `thread/resume` for the tracked thread is about to be sent: hold live items from now on, so
   * one written right behind the response is not sent before the history that comes before it.
   */
  attaching(): void;
  /**
   * The announced attach ended without attaching: release what was held, in arrival order, unless
   * a catch-up is reading (it releases them when it ends).
   */
  attachFailed(): void;
  /**
   * The attach to the thread succeeded (the first time, after a retry, a reconnect or a rotation):
   * deliver what completed before it. Never rejects; a call while one runs is not lost (one more
   * read follows it).
   */
  catchUp(): Promise<void>;
  /** The session is gone: drop what is held, and send and build nothing more. */
  dispose(): void;
}

/** What could not be read, in words with no server text: the app-server's own message may carry an id or a path. */
class CodexHistoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexHistoryError';
  }
}

type Entry =
  | { kind: 'text'; id: string; role: 'user' | 'assistant'; text: string }
  | { kind: 'shell'; id: string; command: string; output: string | null; isError: boolean };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The chat entry of an item, or null when it is not shown (not chat, blank, or still running). */
function entryOf(item: ThreadItemInfo): Entry | null {
  switch (item.type) {
    case 'userMessage':
      return item.text.trim() === ''
        ? null
        : { kind: 'text', id: item.id, role: 'user', text: item.text };
    case 'agentMessage':
      return item.text.trim() === ''
        ? null
        : { kind: 'text', id: item.id, role: 'assistant', text: item.text };
    case 'commandExecution':
      // A running command is sent when it completes (`item/completed`); a client keeps the first
      // copy of an entry it sees, so sending it now would hide its result.
      if (item.status === 'inProgress') return null;
      return {
        kind: 'shell',
        id: item.id,
        command: item.command,
        output: item.output,
        isError:
          item.status === 'failed' ||
          item.status === 'declined' ||
          (item.exitCode !== null && item.exitCode !== 0),
      };
  }
}

/** The time of a completed item as the protocol's ISO timestamp, or now when it has none that is usable. */
function timestampOf(completedAtMs: number | null): string {
  if (completedAtMs !== null) {
    const date = new Date(completedAtMs);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return now();
}

function toolBlocks(entry: Extract<Entry, { kind: 'shell' }>): TranscriptContentBlock[] {
  // Cut first, escape after (as the Phase 4 cards do): a command and its output are Codex's and the
  // program's words, and a terminal sequence or a bidi override in them is written out as visible
  // text (`escapeUnsafeText`), so the cut never lands inside an escape. The cut is on a code point,
  // so a pair is never left as a lone surrogate (Claude's own `slice` can, and is not changed here).
  const command = escapeUnsafeText(firstCodePoints(entry.command, TOOL_FIELD_MAX));
  const output = escapeUnsafeText(firstCodePoints(entry.output ?? '', TOOL_FIELD_MAX));
  return [
    {
      type: 'tool_use',
      toolUseId: entry.id,
      toolName: SHELL_TOOL,
      toolInput: JSON.stringify({ command }),
    },
    {
      type: 'tool_result',
      toolUseId: entry.id,
      toolName: SHELL_TOOL,
      ...(output !== '' ? { toolOutput: output } : {}),
      isError: entry.isError,
    },
  ];
}

/**
 * The `transcript_content` of an entry, structured by `messageApi`, or null when the API did not
 * keep the message. The structured message is built the way Claude's transcript bridge builds
 * it, and a tool-only entry reads the same: no text, the tool name, a placeholder message.
 */
function buildMessage(
  sessionId: UUID,
  entry: Entry,
  completedAtMs: number | null,
  messageApi: Pick<MessageAPI, 'handleMessage' | 'getMessage'>,
): TranscriptContentMessage | null {
  const text = entry.kind === 'text' ? entry.text : '';
  const display = entry.kind === 'text' ? entry.text : `Used ${SHELL_TOOL}`;
  const role = entry.kind === 'text' ? entry.role : 'assistant';
  const message: Message = {
    id: generateId(),
    sessionId,
    sender: role === 'user' ? 'user' : 'agent',
    content: display,
    createdAt: timestampOf(completedAtMs),
    state: 'delivered',
    stateChangedAt: now(),
    isEditing: false,
  };
  messageApi.handleMessage(message);
  const structured = messageApi.getMessage(message.id);
  if (!structured) return null;
  return createTranscriptContent(
    sessionId,
    entry.id,
    role,
    text,
    structured,
    false,
    entry.kind === 'shell' ? { tools: [SHELL_TOOL], contentBlocks: toolBlocks(entry) } : undefined,
  );
}

/** One page of `thread/items/list`: its entries (the ones that are chat or not, with their times) and the cursor on. */
interface Page {
  items: Array<{ item: ThreadItemInfo | null; completedAtMs: number | null }>;
  nextCursor: string | null;
}

function parsePage(v: unknown): Page | null {
  if (!isRecord(v) || !Array.isArray(v['data'])) return null;
  const next = v['nextCursor'];
  if (next !== undefined && next !== null && (typeof next !== 'string' || next === '')) return null;
  const items: Page['items'] = [];
  for (const entry of v['data']) {
    if (!isRecord(entry) || !isRecord(entry['item'])) continue;
    const completed = entry['completedAtMs'];
    items.push({
      item: parseThreadItem(entry['item']),
      completedAtMs: typeof completed === 'number' && Number.isFinite(completed) ? completed : null,
    });
  }
  return { items, nextCursor: next ?? null };
}

/** Words for a failed request that carry the code and nothing the server said. */
function historyError(error: unknown): CodexHistoryError {
  if (error instanceof AppServerRpcError) {
    return new CodexHistoryError(
      `the Codex app-server could not list the history (code ${error.code})`,
    );
  }
  if (error instanceof AppServerDisconnectedError) {
    return new CodexHistoryError('the link to the Codex app-server is down');
  }
  return new CodexHistoryError(`the Codex history could not be read (${describeError(error)})`);
}

/** How a paged read of a thread ended: its last page, the page limit, the deadline, or a cursor that came back. */
type PagesEnd = 'complete' | 'capped' | 'looped' | 'timeout';

export function createCodexChat(deps: CodexChatDeps): CodexChat {
  const { sessionId } = deps;
  const clockMs = deps.clockMs ?? (() => performance.now());
  /** Items already sent to every client (live or by a catch-up), oldest first. */
  const delivered = new Set<string>();
  /** Messages built whose send failed, kept for the retry, oldest first (see the header). */
  const built = new Map<string, TranscriptContentMessage>();
  let disposed = false;

  const remember = (id: string): void => {
    delivered.add(id);
    if (delivered.size > LIVE_MEMORY) {
      const oldest = delivered.values().next().value;
      if (oldest !== undefined) delivered.delete(oldest);
    }
  };

  const keepBuilt = (id: string, message: TranscriptContentMessage): void => {
    built.delete(id);
    built.set(id, message);
    if (built.size > BUILT_MAX) {
      const oldest = built.keys().next().value;
      if (oldest !== undefined) built.delete(oldest);
    }
  };

  /**
   * Page through the tracked thread's items, oldest first, handing each chat entry to `onEntry` as
   * its page arrives. Ends at the last page, at `maxPages`, once `deadlineMs` have passed since it
   * began (checked after each page that is not the last), or when a page's cursor is one already
   * asked for (the first request has none, so it is never the one repeated). Throws a
   * {@link CodexHistoryError} for every failure but the thread that has nothing written yet,
   * which is a complete, empty read.
   */
  async function readPages(
    threadId: string,
    limits: { maxPages: number; maxItems?: number; timeoutMs?: number; deadlineMs?: number },
    onEntry: (entry: Entry, completedAtMs: number | null) => void,
  ): Promise<PagesEnd> {
    const asked = new Set<string>();
    const startedAt = clockMs();
    let cursor: string | undefined;
    for (let pageNumber = 1; pageNumber <= limits.maxPages; pageNumber++) {
      let result: unknown;
      try {
        result = await deps.client.request(
          'thread/items/list',
          {
            threadId,
            sortDirection: 'asc',
            limit: HISTORY_PAGE_SIZE,
            ...(cursor !== undefined ? { cursor } : {}),
          },
          limits.timeoutMs,
        );
      } catch (error) {
        // A thread nothing was written to has no rollout yet, and `thread/resume` answers that
        // way before the first message (LV-2); asked for its first page, it is an empty history.
        if (
          pageNumber === 1 &&
          error instanceof AppServerRpcError &&
          error.code === INVALID_REQUEST &&
          /no rollout found/i.test(error.message)
        ) {
          deps.log('the thread has no history yet');
          return 'complete';
        }
        throw historyError(error);
      }

      // Catch-up bounds every raw entry, including non-chat and malformed ones, before parsing:
      // a server may exceed the requested page size, but it must not exceed the replay budget.
      if (
        limits.maxItems !== undefined &&
        isRecord(result) &&
        Array.isArray(result['data']) &&
        result['data'].length > limits.maxItems
      )
        return 'capped';

      const page = parsePage(result);
      if (page === null)
        throw new CodexHistoryError('the Codex app-server sent a history page remi cannot read');

      for (const { item, completedAtMs } of page.items) {
        const entry = item === null ? null : entryOf(item);
        if (entry !== null) onEntry(entry, completedAtMs);
      }

      if (page.nextCursor === null) return 'complete';
      if (asked.has(page.nextCursor)) return 'looped';
      asked.add(page.nextCursor);
      cursor = page.nextCursor;
      if (limits.deadlineMs !== undefined && clockMs() - startedAt >= limits.deadlineMs)
        return 'timeout';
    }
    return 'capped';
  }

  /** An explicit read: for the one who asked, through a MessageAPI of its own so the session's stream is untouched. */
  async function runExplicit(emit: (message: TranscriptContentMessage) => void): Promise<number> {
    const threadId = deps.threadId();
    // No thread yet: nothing has been said, and there is nothing to ask for.
    if (threadId === null) return 0;

    const history = new MessageAPI({ sessionId });
    const seen = new Set<string>();
    let count = 0;
    const end = await readPages(
      threadId,
      { maxPages: HISTORY_MAX_PAGES, deadlineMs: EXPLICIT_READ_DEADLINE_MS },
      (entry, completedAtMs) => {
        if (seen.has(entry.id)) return;
        const message = buildMessage(sessionId, entry, completedAtMs, history);
        if (message === null) return;
        seen.add(entry.id);
        emit(message);
        count += 1;
      },
    );
    if (end === 'looped')
      deps.log('the app-server repeated a history cursor; the history read stopped');
    else if (end === 'capped')
      deps.log(`the history read stopped after ${HISTORY_MAX_PAGES} pages`);
    else if (end === 'timeout')
      deps.log(
        `the history read stopped after ${EXPLICIT_READ_DEADLINE_MS / 1000} seconds; what it had read was sent`,
      );
    return count;
  }

  // One explicit read of the session runs at a time, with one waiting: two phones that connect together
  // both ask for the history, and a client that asks in a loop is refused, not queued without end.
  let reading: Promise<unknown> | null = null;
  let waiting = false;

  /**
   * Send one entry to every client, once: a repeat is dropped, and a failed send is tried again if it
   * is delivered again. `api` structures a message that has to be built: the session's own for a live
   * item, one of the catch-up's own for history (which sends no structured output).
   */
  function deliver(
    entry: Entry,
    completedAtMs: number | null,
    api: Pick<MessageAPI, 'handleMessage' | 'getMessage'>,
  ): void {
    // A disposed session builds nothing: building makes the MessageAPI send structured output.
    if (disposed || delivered.has(entry.id)) return;
    try {
      let message = built.get(entry.id) ?? null;
      if (message === null) {
        message = buildMessage(sessionId, entry, completedAtMs, api);
        if (message === null) return;
      }
      keepBuilt(entry.id, message);
      deps.sendAndRecord(message);
      built.delete(entry.id);
      remember(entry.id);
    } catch (error) {
      deps.log(`could not send a chat message (${describeError(error)})`);
    }
  }

  /** A live item kept until the history has gone out, with the thread it was for. */
  interface Held {
    threadId: string;
    entry: Entry;
    completedAtMs: number | null;
  }
  /** Live items waiting for the history; `overflowed` once one found it full. */
  interface Hold {
    items: Held[];
    overflowed: boolean;
  }
  let hold: Hold | null = null;
  /** A `thread/resume` has been sent and has neither failed nor been followed by `catchUp`. */
  let attachPending = false;

  /** Start holding live items (or keep holding: one hold covers an attach and the read after it). */
  function startHold(): void {
    if (hold === null || hold.overflowed) hold = { items: [], overflowed: false };
  }

  /** Send a held item live, unless its thread is no longer the session's. */
  function deliverHeld(held: Held): void {
    if (deps.threadRole(held.threadId) !== 'main') return;
    deliver(held.entry, held.completedAtMs, deps.messageApi);
  }

  /** End the hold: what it holds goes out, in arrival order. */
  function releaseHold(): void {
    const ended = hold;
    hold = null;
    if (ended === null || disposed) return;
    for (const held of ended.items) deliverHeld(held);
  }

  async function catchUpOnce(): Promise<void> {
    startHold();
    const mine = hold as Hold;
    const threadId = deps.threadId();
    if (threadId === null) return;
    const collected: Array<{ entry: Entry; completedAtMs: number | null }> = [];
    let end: PagesEnd | null = null;
    try {
      end = await readPages(
        threadId,
        {
          maxPages: CATCH_UP_MAX_PAGES,
          maxItems: HISTORY_PAGE_SIZE,
          timeoutMs: deps.catchUpRequestTimeoutMs ?? CATCH_UP_REQUEST_TIMEOUT_MS,
        },
        (entry, completedAtMs) => collected.push({ entry, completedAtMs }),
      );
    } catch (error) {
      const why = error instanceof CodexHistoryError ? error.message : describeError(error);
      deps.log(`the chat catch-up failed (${why})`);
    }
    if (disposed) return;
    // The hold overflowed (said so then): what went out is later than this history.
    if (mine.overflowed || end === null) return;
    if (deps.threadId() !== threadId) {
      deps.log(
        'the chat catch-up was skipped: the tracked thread changed while it read, so the follow-up read has the new thread',
      );
      return;
    }
    if (end !== 'complete') {
      deps.log(
        'the chat catch-up was skipped: the thread is longer than one page of 100 items (or its cursor repeated), so an explicit history read has it',
      );
      return;
    }
    // Transcript only, by an API of its own: no structured output reaches every connection.
    const api = new MessageAPI({ sessionId });
    for (const { entry, completedAtMs } of collected) deliver(entry, completedAtMs, api);
  }

  let catching: Promise<void> | null = null;
  let again = false;

  return {
    async readHistory(emit) {
      if (reading !== null) {
        if (waiting) {
          throw new CodexHistoryError(
            'another history read of this session is already waiting; try again in a moment',
          );
        }
        waiting = true;
        try {
          // Until the slot is free: a read that failed is not this one's failure, and its error is not inherited.
          while (reading !== null) await reading.catch(() => {});
        } finally {
          waiting = false;
        }
      }
      const mine = runExplicit(emit);
      reading = mine;
      try {
        return await mine;
      } finally {
        reading = null;
      }
    },

    attaching() {
      if (disposed) return;
      attachPending = true;
      startHold();
    },

    attachFailed() {
      if (disposed) return;
      attachPending = false;
      // A read that is running releases the hold when it ends, after the history.
      if (catching === null) releaseHold();
    },

    catchUp() {
      if (disposed) return Promise.resolve();
      attachPending = false;
      if (catching !== null) {
        again = true;
        return catching;
      }
      const running = (async () => {
        try {
          do {
            again = false;
            await catchUpOnce();
          } while (again && !disposed);
        } catch (error) {
          // catchUpOnce never throws; this is for a bug, which must not break the attach.
          deps.log(`the chat catch-up failed (${describeError(error)})`);
        } finally {
          catching = null;
          // An attach that is out has a history of its own still to come: the hold stays for it.
          if (!attachPending) releaseHold();
        }
      })();
      catching = running;
      return running;
    },

    dispose() {
      disposed = true;
      hold = null;
      again = false;
      built.clear();
    },

    handleNotification(method, params) {
      if (disposed || method !== 'item/completed' || !isRecord(params)) return;
      const threadId = params['threadId'];
      if (typeof threadId !== 'string' || deps.threadRole(threadId) !== 'main') return;
      const item = parseThreadItem(params['item']);
      const entry = item === null ? null : entryOf(item);
      if (entry === null || delivered.has(entry.id)) return;
      const completed = params['completedAtMs'];
      const completedAtMs =
        typeof completed === 'number' && Number.isFinite(completed) ? completed : null;
      const current = hold;
      if (current !== null && !current.overflowed) {
        if (current.items.length < HOLD_MAX) {
          current.items.push({ threadId, entry, completedAtMs });
          return;
        }
        // Full. What was held goes out first, in the order it came, then this item, and the history
        // is not sent after them (it would be out of order): one line says so.
        current.overflowed = true;
        deps.log(
          `more than ${HOLD_MAX} chat items arrived before the history went out; they were sent in order and the catch-up was dropped, so an explicit history read has the history`,
        );
        const items = current.items;
        current.items = [];
        for (const held of items) deliverHeld(held);
      }
      deliver(entry, completedAtMs, deps.messageApi);
    },
  };
}
