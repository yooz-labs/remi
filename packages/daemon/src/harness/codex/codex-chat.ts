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
 *   tool (cut first, then every control, invisible and bidirectional character written
 *   out as visible text), and an error when the command failed, was declined or exited
 *   non-zero. One
 *   still running is left for its completion, which arrives live;
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
 * connecting later replays them. Only the session's own (`main`) thread counts: a subagent's
 * items and another window's are not this chat (subagent chat is out of scope).
 *
 * What no real frame has shown yet (live step LV-5): the response of `thread/items/list`
 * (the shape here is the generated schema's `ThreadItemsListResponse`), its paging, and
 * the error it answers for a thread with nothing written.
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
import { type ThreadItemInfo, parseThreadItem } from './thread-protocol.ts';

/** The items asked for per page. The app-server may give fewer, or more. */
const HISTORY_PAGE_SIZE = 100;
/** A history read stops after this many pages, so a cursor that never ends cannot loop for ever. */
const HISTORY_MAX_PAGES = 1000;
/** How many delivered live items are remembered to drop a repeat of one. */
const LIVE_MEMORY = 1024;
/** Claude bounds a tool's input and output to this many characters; so does the shell entry. */
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
  /** Test seam: the page limit (default 1000). */
  maxPages?: number;
}

export interface CodexChat extends HarnessChat {
  /** Feed every notification of the app-server; only an `item/completed` of the main thread does anything. */
  handleNotification(method: string, params: unknown): void;
}

/** What could not be read, in words with no server text: the app-server's own message may carry an id or a path. */
export class CodexHistoryError extends Error {
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
  // text (`escapeUnsafeText`), so the cut never lands inside an escape.
  const command = escapeUnsafeText(entry.command.slice(0, TOOL_FIELD_MAX));
  const output = escapeUnsafeText(entry.output?.slice(0, TOOL_FIELD_MAX) ?? '');
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

export function createCodexChat(deps: CodexChatDeps): CodexChat {
  const { sessionId } = deps;
  const maxPages = deps.maxPages ?? HISTORY_MAX_PAGES;
  /** Live items already sent, oldest first. */
  const delivered = new Set<string>();

  const remember = (id: string): void => {
    delivered.add(id);
    if (delivered.size > LIVE_MEMORY) {
      const oldest = delivered.values().next().value;
      if (oldest !== undefined) delivered.delete(oldest);
    }
  };

  return {
    async readHistory(emit) {
      const threadId = deps.threadId();
      // No thread yet: nothing has been said, and there is nothing to ask for.
      if (threadId === null) return 0;

      // History is for the one who asked: a MessageAPI of its own, so the session's stream is untouched.
      const history = new MessageAPI({ sessionId });
      const seen = new Set<string>();
      let count = 0;
      let cursor: string | undefined;

      for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
        let result: unknown;
        try {
          result = await deps.client.request('thread/items/list', {
            threadId,
            sortDirection: 'asc',
            limit: HISTORY_PAGE_SIZE,
            ...(cursor !== undefined ? { cursor } : {}),
          });
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
            return 0;
          }
          throw historyError(error);
        }

        const page = parsePage(result);
        if (page === null)
          throw new CodexHistoryError('the Codex app-server sent a history page remi cannot read');

        for (const { item, completedAtMs } of page.items) {
          const entry = item === null ? null : entryOf(item);
          if (entry === null || seen.has(entry.id)) continue;
          const message = buildMessage(sessionId, entry, completedAtMs, history);
          if (message === null) continue;
          seen.add(entry.id);
          emit(message);
          count += 1;
        }

        if (page.nextCursor === null) return count;
        if (page.nextCursor === cursor) {
          deps.log('the app-server repeated a history cursor; the history read stopped');
          return count;
        }
        cursor = page.nextCursor;
      }
      deps.log(`the history read stopped after ${maxPages} pages`);
      return count;
    },

    handleNotification(method, params) {
      if (method !== 'item/completed' || !isRecord(params)) return;
      const threadId = params['threadId'];
      if (typeof threadId !== 'string' || deps.threadRole(threadId) !== 'main') return;
      const item = parseThreadItem(params['item']);
      const entry = item === null ? null : entryOf(item);
      if (entry === null || delivered.has(entry.id)) return;
      const completed = params['completedAtMs'];
      try {
        const message = buildMessage(
          sessionId,
          entry,
          typeof completed === 'number' && Number.isFinite(completed) ? completed : null,
          deps.messageApi,
        );
        if (message === null) return;
        deps.sendAndRecord(message);
        // Only after it went out: a failed send is tried again if the item is delivered again.
        remember(entry.id);
      } catch (error) {
        deps.log(`could not send a chat message (${describeError(error)})`);
      }
    },
  };
}
