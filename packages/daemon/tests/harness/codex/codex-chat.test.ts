/**
 * Codex chat (#1180, Phase 6 of the Codex epic #1175): a session's history read from the
 * app-server's paged items, and its live `item/completed` frames, both as `transcript_content`.
 *
 * Synthetic edge cases use `createCodexChat`, the real `AppServerClient` talking to the
 * `FakeAppServer` (a real WebSocket server on a unix socket), and the daemon's own `MessageAPI`.
 * Their items come from captured Codex frames (`realItem`); `thread/items/list` request and result
 * frames are now also captured in `fixtures/codex-app-server/lv5.jsonl`. The bounded live capture
 * pins the page shape and id correspondence; the generated-shape helper here remains for paging
 * and malformed-page cases not covered by that capture.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readlinkSync } from 'node:fs';
import type {
  ProtocolMessage,
  StructuredMessage,
  TranscriptContentMessage,
  UUID,
} from '@remi/shared';
import { MessageAPI } from '../../../src/api/message-api.ts';
import { AppServerClient } from '../../../src/harness/codex/app-server-client.ts';
import { createCodexChat } from '../../../src/harness/codex/codex-chat.ts';
import { loadFixtureFrames } from '../../helpers/codex-fixtures.ts';
import {
  type Json,
  agentMessageItem,
  itemCompletedFrame,
  itemsListPage,
  realItem,
  userMessageItem,
} from '../../helpers/codex-threads.ts';
import { FakeAppServer, rejection } from '../../helpers/fake-app-server.ts';

const SID = 's0000000-0000-0000-0000-000000000000' as UUID;
const MAIN = '00000000-0000-7000-8000-0000000000a1';
const SUB = '00000000-0000-7000-8000-0000000000a2';
const OTHER = '00000000-0000-7000-8000-0000000000a3';
const ROLES: Record<string, 'main' | 'subagent'> = { [MAIN]: 'main', [SUB]: 'subagent' };

const COMMAND_ID = 'exec-00000000-0000-7000-8000-000000000004';

describe('createCodexChat', () => {
  let server: FakeAppServer;
  let client: AppServerClient;
  let logs: string[];
  let tracked: string | null;
  /** What the tracker says each thread is; a test changes it to model a rotation. */
  let roles: Record<string, 'main' | 'subagent'>;
  /** What the daemon sent every client, through `sendAndRecord`. */
  let live: ProtocolMessage[];
  /** What the session's own MessageAPI structured, as it would send `structured_agent_output`. */
  let structured: StructuredMessage[];
  let listCalls: Json[];

  beforeEach(async () => {
    server = FakeAppServer.start();
    logs = [];
    live = [];
    structured = [];
    listCalls = [];
    tracked = MAIN;
    roles = { ...ROLES };
    let ready = false;
    client = new AppServerClient(
      {
        socketPath: () => readlinkSync(server.linkPath),
        clientInfo: { name: 'remi', title: null, version: 'test' },
        backoff: { initialMs: 5, maxMs: 20 },
        log: (m) => logs.push(m),
      },
      (e) => {
        if (e.type === 'ready') ready = true;
      },
    );
    client.start();
    await server.waitFor(() => ready, 'the client to be ready');
  });

  afterEach(async () => {
    client.stop();
    await server.stop();
  });

  function make(over: Partial<Parameters<typeof createCodexChat>[0]> = {}) {
    return createCodexChat({
      sessionId: SID,
      client,
      threadId: () => tracked,
      threadRole: (threadId) => roles[threadId] ?? null,
      messageApi: new MessageAPI(
        { sessionId: SID },
        { onStructuredMessage: (message) => structured.push(message) },
      ),
      sendAndRecord: (message) => live.push(message),
      log: (m) => logs.push(m),
      ...over,
    });
  }

  /** Serve `pages` by cursor: the first has no cursor, the others the `nextCursor` the previous gave. */
  function servePages(pages: Record<string, Json>): void {
    server.onRequest('thread/items/list', (params) => {
      listCalls.push(params as Json);
      const cursor = (params as { cursor?: string }).cursor ?? '';
      const page = pages[cursor];
      if (page === undefined) throw { code: -32602, message: `no page for cursor ${cursor}` };
      return page;
    });
  }

  async function history(
    chat = make(),
  ): Promise<{ messages: TranscriptContentMessage[]; count: number }> {
    const messages: TranscriptContentMessage[] = [];
    const count = await chat.readHistory((m) => messages.push(m));
    return { messages, count };
  }

  const transcripts = (): TranscriptContentMessage[] =>
    live.filter((m): m is TranscriptContentMessage => m.type === 'transcript_content');

  describe('history', () => {
    test('parses the captured LV-5 first page and preserves its item ids as history ids', async () => {
      const capture = loadFixtureFrames('lv5.jsonl');
      const request = capture.find(
        (entry) => entry.frame['method'] === 'thread/items/list' && entry.dir === 'out',
      );
      const response = capture.find((entry) => 'result' in entry.frame && entry.dir === 'in');
      expect(request).toBeDefined();
      expect(response).toBeDefined();
      const requestParams = request?.frame['params'] as Record<string, unknown>;
      const result = response?.frame['result'] as Record<string, unknown>;
      const threadId = requestParams['threadId'] as string;
      tracked = threadId;
      roles[threadId] = 'main';
      server.onRequest('thread/items/list', (params) => {
        listCalls.push(params as Json);
        return result;
      });

      const { messages, count } = await history();

      const rows = result['data'] as Array<{ item: { id: string; type: string } }>;
      expect(requestParams).toMatchObject({ limit: 100, sortDirection: 'asc', threadId });
      expect(result).toHaveProperty('nextCursor', null);
      expect(typeof result['backwardsCursor']).toBe('string');
      expect(count).toBe(2);
      expect(rows).toHaveLength(2);
      const [userRow, assistantRow] = rows;
      if (!userRow || !assistantRow) throw new Error('Expected two captured history rows');
      expect(messages.map((m) => [m.entryUuid, m.role, m.content])).toEqual([
        [userRow.item.id, 'user', 'Reply with exactly LV5 FIRST. Do not use any tools.'],
        [assistantRow.item.id, 'assistant', 'LV5 FIRST'],
      ]);
      expect(new Set(rows.map((row) => row.item.type))).toEqual(
        new Set(['userMessage', 'agentMessage']),
      );
      expect(messages.map((m) => m.entryUuid)).toEqual(rows.map((row) => row.item.id));
      expect(listCalls).toEqual([requestParams]);
    });

    test('a captured command item has the same id in item/completed and thread/items/list', async () => {
      const capture = loadFixtureFrames('lv5.jsonl');
      const response = capture.find((entry) => entry.line === 20);
      const completed = capture.find((entry) => entry.line === 3);
      expect(response).toBeDefined();
      expect(completed).toBeDefined();
      const result = response?.frame['result'] as Record<string, unknown>;
      const rows = result['data'] as Array<{ item: { id: string; type: string } }>;
      const liveItem = (completed?.frame['params'] as { item: { id: string } }).item;
      const historyRow = rows.find((row) => row.item.id === liveItem.id);
      expect(historyRow?.item.type).toBe('commandExecution');

      const request = capture.find(
        (entry) =>
          entry.frame['method'] === 'thread/items/list' &&
          entry.dir === 'out' &&
          (entry.frame['id'] as number) === 1002,
      );
      const threadId = (request?.frame['params'] as { threadId: string }).threadId;
      tracked = threadId;
      roles[threadId] = 'main';
      server.onRequest('thread/items/list', () => result);
      const { messages, count } = await history();

      expect(count).toBe(5); // reasoning is retained in the fixture but excluded from chat
      expect(messages.filter((message) => message.entryUuid === liveItem.id)).toHaveLength(1);
      expect(messages.find((message) => message.entryUuid === liveItem.id)?.message.content).toBe(
        'Used shell',
      );
    });

    test('reads the thread oldest first, a page at a time, following the cursor until there is none', async () => {
      servePages({
        '': itemsListPage(
          [
            { item: userMessageItem('u1', 'first prompt') },
            { item: realItem('commandExecution', { id: COMMAND_ID }) },
          ],
          'c1',
        ),
        c1: itemsListPage([{ item: agentMessageItem('a1', 'second', 'final_answer') }], 'c2'),
        c2: itemsListPage([{ item: agentMessageItem('a2', 'third', 'final_answer') }], null),
      });

      const { messages, count } = await history();

      expect(messages.map((m) => m.entryUuid)).toEqual(['u1', COMMAND_ID, 'a1', 'a2']);
      expect(count).toBe(4);
      expect(listCalls).toEqual([
        { threadId: MAIN, sortDirection: 'asc', limit: 100 },
        { threadId: MAIN, sortDirection: 'asc', limit: 100, cursor: 'c1' },
        { threadId: MAIN, sortDirection: 'asc', limit: 100, cursor: 'c2' },
      ]);
      // The frames the client sent are the app-server's own method, one request each.
      const sent = server.received.filter((r) => r.frame['method'] === 'thread/items/list');
      expect(sent).toHaveLength(3);
    });

    test('emits each page as it arrives, before the next is asked for', async () => {
      let secondRequested = false;
      const seenBeforeSecond: string[] = [];
      server.onRequest('thread/items/list', (params) => {
        const cursor = (params as { cursor?: string }).cursor;
        if (cursor === undefined) {
          return itemsListPage([{ item: userMessageItem('u1', 'one') }], 'c1');
        }
        secondRequested = true;
        return itemsListPage([{ item: userMessageItem('u2', 'two') }], null);
      });

      const chat = make();
      await chat.readHistory((m) => {
        if (!secondRequested) seenBeforeSecond.push(m.entryUuid);
      });

      expect(seenBeforeSecond).toEqual(['u1']);
    });

    test('a user message is role user, an agent message role assistant, with the item id as the entry id', async () => {
      servePages({
        '': itemsListPage(
          [
            { item: userMessageItem('u1', 'Run the tests') },
            { item: agentMessageItem('a1', 'They pass.', 'final_answer') },
            { item: agentMessageItem('a2', 'Interim thought.', 'commentary') },
            { item: agentMessageItem('a3', 'No phase.', null) },
          ],
          null,
        ),
      });

      const { messages } = await history();

      expect(messages.map((m) => [m.entryUuid, m.role, m.content])).toEqual([
        ['u1', 'user', 'Run the tests'],
        ['a1', 'assistant', 'They pass.'],
        ['a2', 'assistant', 'Interim thought.'],
        ['a3', 'assistant', 'No phase.'],
      ]);
      for (const m of messages) {
        expect(m.type).toBe('transcript_content');
        expect(m.sessionId).toBe(SID);
        expect(m.isUpdate).toBe(false);
      }
      // The structured message is the daemon's own bullet structuring of the same text.
      const first = messages[0] as TranscriptContentMessage;
      expect(first.message.sender).toBe('user');
      expect(first.message.content).toBe('Run the tests');
      expect(first.message.sessionId).toBe(SID);
      expect(first.message.bullets).toEqual([]);
      expect((messages[1] as TranscriptContentMessage).message.sender).toBe('agent');
    });

    test('a message with bullets keeps them: the structure is the daemon’s own, with ids that continue within the read', async () => {
      servePages({
        '': itemsListPage(
          [
            { item: agentMessageItem('a1', '- first\n- second', 'final_answer') },
            { item: agentMessageItem('a2', '- third', 'final_answer') },
          ],
          null,
        ),
      });

      const { messages } = await history();

      const bullets = (m: TranscriptContentMessage | undefined) =>
        m?.message.bullets.map((b) => [b.bulletId, b.content]);
      expect(bullets(messages[0])).toEqual([
        [1, '- first'],
        [2, '- second'],
      ]);
      expect(bullets(messages[1])).toEqual([[3, '- third']]);
    });

    test('a command is an assistant tool entry named shell, with its input and result as content blocks', async () => {
      servePages({
        '': itemsListPage(
          [
            {
              item: realItem('commandExecution', {
                id: COMMAND_ID,
                command: "/bin/zsh -lc 'ls -la'",
                aggregatedOutput: 'total 0\nfile.txt\n',
              }),
            },
          ],
          null,
        ),
      });

      const { messages, count } = await history();

      expect(count).toBe(1);
      const m = messages[0] as TranscriptContentMessage;
      expect(m.entryUuid).toBe(COMMAND_ID);
      expect(m.role).toBe('assistant');
      // Claude's tool-only entries read the same: no text, the tool names, a placeholder message.
      expect(m.content).toBe('');
      expect(m.tools).toEqual(['shell']);
      expect(m.message.content).toBe('Used shell');
      expect(m.contentBlocks).toEqual([
        {
          type: 'tool_use',
          toolUseId: COMMAND_ID,
          toolName: 'shell',
          toolInput: JSON.stringify({ command: "/bin/zsh -lc 'ls -la'" }),
        },
        {
          type: 'tool_result',
          toolUseId: COMMAND_ID,
          toolName: 'shell',
          toolOutput: 'total 0\nfile.txt\n',
          isError: false,
        },
      ]);
    });

    test('the real command item of the spike: no output means no output text', async () => {
      servePages({ '': itemsListPage([{ item: realItem('commandExecution') }], null) });

      const m = (await history()).messages[0] as TranscriptContentMessage;

      const result = m.contentBlocks?.find((b) => b.type === 'tool_result');
      expect(result).toEqual({
        type: 'tool_result',
        toolUseId: COMMAND_ID,
        toolName: 'shell',
        isError: false,
      });
    });

    test('a declined command, a failed one and one that exited non-zero read as errors; a completed zero exit does not', async () => {
      const cmd = (id: string, over: Json) => ({
        item: realItem('commandExecution', { id, ...over }),
      });
      servePages({
        '': itemsListPage(
          [
            cmd('c-declined', { status: 'declined', exitCode: null }),
            cmd('c-failed', { status: 'failed', exitCode: null }),
            cmd('c-exit1', { status: 'completed', exitCode: 1, aggregatedOutput: 'boom' }),
            cmd('c-ok', { status: 'completed', exitCode: 0 }),
            cmd('c-unknown-exit', { status: 'completed', exitCode: null }),
          ],
          null,
        ),
      });

      const { messages } = await history();

      const isError = (id: string) =>
        messages
          .find((m) => m.entryUuid === id)
          ?.contentBlocks?.find((b) => b.type === 'tool_result')?.isError;
      expect(isError('c-declined')).toBe(true);
      expect(isError('c-failed')).toBe(true);
      expect(isError('c-exit1')).toBe(true);
      expect(isError('c-ok')).toBe(false);
      expect(isError('c-unknown-exit')).toBe(false);
    });

    test('a command and its output are bounded the way Claude bounds a tool: 500 characters, and the input stays valid JSON', async () => {
      const long = 'x'.repeat(2000);
      servePages({
        '': itemsListPage(
          [{ item: realItem('commandExecution', { command: long, aggregatedOutput: long }) }],
          null,
        ),
      });

      const m = (await history()).messages[0] as TranscriptContentMessage;

      const use = m.contentBlocks?.find((b) => b.type === 'tool_use');
      const result = m.contentBlocks?.find((b) => b.type === 'tool_result');
      expect(JSON.parse(use?.toolInput ?? '').command).toHaveLength(500);
      expect(result?.toolOutput).toHaveLength(500);
    });

    test('the cut falls between code points: a pair that straddles the 500th unit is kept whole, never left as a lone surrogate', async () => {
      const command = `${'a'.repeat(499)}\u{1F600}TAIL`;
      const output = `${'b'.repeat(499)}\u{1F600}TAIL`;
      servePages({
        '': itemsListPage(
          [{ item: realItem('commandExecution', { command, aggregatedOutput: output }) }],
          null,
        ),
      });

      const m = (await history()).messages[0] as TranscriptContentMessage;

      const use = m.contentBlocks?.find((b) => b.type === 'tool_use');
      const result = m.contentBlocks?.find((b) => b.type === 'tool_result');
      // 500 CODE POINTS: 499 letters and the whole emoji.
      expect(JSON.parse(use?.toolInput ?? '').command).toBe(`${'a'.repeat(499)}\u{1F600}`);
      expect(result?.toolOutput).toBe(`${'b'.repeat(499)}\u{1F600}`);
      expect((result?.toolOutput ?? '').isWellFormed()).toBe(true);
    });

    test('a command and its output are written out safely: control, invisible and bidi characters become visible text, after the 500-character cut', async () => {
      servePages({
        '': itemsListPage(
          [
            {
              item: realItem('commandExecution', {
                command: "echo \u202egnirts' \u001b[31m",
                aggregatedOutput: '\u001b[31mred\u001b[0m \u0007 \u200b\ttab\nnext',
              }),
            },
          ],
          null,
        ),
      });

      const m = (await history()).messages[0] as TranscriptContentMessage;

      const use = m.contentBlocks?.find((b) => b.type === 'tool_use');
      const result = m.contentBlocks?.find((b) => b.type === 'tool_result');
      expect(JSON.parse(use?.toolInput ?? '').command).toBe("echo \\u202Egnirts' \\u001B[31m");
      expect(result?.toolOutput).toBe('\\u001B[31mred\\u001B[0m \\u0007 \\u200B\ttab\nnext');
      // Nothing of the raw characters is left in what goes to the client.
      expect(JSON.stringify(m.contentBlocks)).not.toMatch(
        /[\u0000-\u0008\u000b-\u001f\u202e\u200b]/,
      );
    });

    test('the cut is made first and the escape after: 500 characters of the original, however long they then read', async () => {
      const command = `${'a'.repeat(499)}\u001bTAIL`;
      const output = `${'b'.repeat(499)}\u001bNOT-INCLUDED`;
      servePages({
        '': itemsListPage(
          [{ item: realItem('commandExecution', { command, aggregatedOutput: output }) }],
          null,
        ),
      });

      const m = (await history()).messages[0] as TranscriptContentMessage;

      const use = m.contentBlocks?.find((b) => b.type === 'tool_use');
      const result = m.contentBlocks?.find((b) => b.type === 'tool_result');
      // 499 letters and the escape character make the 500; the escape is written out whole.
      expect(JSON.parse(use?.toolInput ?? '').command).toBe(`${'a'.repeat(499)}\\u001B`);
      // The same for the output: 499 letters and the escape character are the 500.
      expect(result?.toolOutput).toBe(`${'b'.repeat(499)}\\u001B`);
    });

    test('chat prose is NOT escaped, deliberately: an emoji sequence keeps its joiner, and the text is the model’s own', async () => {
      const family = '\u{1f468}\u200d\u{1f469}\u200d\u{1f467}';
      const prose = `${family} done \u202e<- as sent, \u001b[0m`;
      servePages({
        '': itemsListPage(
          [
            { item: userMessageItem('u1', prose) },
            { item: agentMessageItem('a1', prose, 'final_answer') },
          ],
          null,
        ),
      });

      const { messages } = await history();

      for (const m of messages) {
        expect(m.content).toBe(prose);
        expect(m.message.content).toBe(prose);
      }
    });

    test('an in-progress command is not shown yet: its completion arrives live, and a client keeps the first copy it sees', async () => {
      servePages({
        '': itemsListPage(
          [
            { item: userMessageItem('u1', 'go') },
            { item: realItem('commandExecution', { id: 'c-running', status: 'inProgress' }) },
          ],
          null,
        ),
      });

      const { messages, count } = await history();

      expect(messages.map((m) => m.entryUuid)).toEqual(['u1']);
      expect(count).toBe(1);
    });

    test('what is not chat is skipped and does not count: reasoning, plans, hook prompts, file changes, tool calls, empty and image-only messages', async () => {
      servePages({
        '': itemsListPage(
          [
            { item: userMessageItem('u1', 'keep me') },
            { item: { type: 'reasoning', id: 'r1', summary: ['thinking'], content: ['more'] } },
            { item: { type: 'plan', id: 'p1', text: 'a plan' } },
            {
              item: { type: 'hookPrompt', id: 'h1', fragments: [{ text: 'hook', hookRunId: 'x' }] },
            },
            { item: { type: 'fileChange', id: 'f1', changes: [], status: 'completed' } },
            { item: { type: 'mcpToolCall', id: 'm1', server: 's', tool: 't' } },
            { item: { type: 'contextCompaction', id: 'cc1' } },
            { item: { type: 'somethingNew', id: 'n1', text: 'from a newer Codex' } },
            {
              item: realItem('userMessage', {
                id: 'u-img',
                content: [{ type: 'localImage', path: '/work/a.png' }],
              }),
            },
            { item: userMessageItem('u-empty', '   ') },
            { item: agentMessageItem('a-empty', '', 'final_answer') },
            { item: { type: 'agentMessage', id: 'a-bad', text: 7, phase: 'final_answer' } },
            { item: { type: 'agentMessage', text: 'no id', phase: 'final_answer' } },
            { item: agentMessageItem('a1', 'keep me too', 'final_answer') },
          ],
          null,
        ),
      });

      const { messages, count } = await history();

      expect(messages.map((m) => m.entryUuid)).toEqual(['u1', 'a1']);
      expect(count).toBe(2);
    });

    test('a user message of several parts joins its text parts and ignores the others', async () => {
      servePages({
        '': itemsListPage(
          [
            {
              item: realItem('userMessage', {
                id: 'u1',
                content: [
                  { type: 'text', text: 'look at this', text_elements: [] },
                  { type: 'localImage', path: '/work/shot.png' },
                  { type: 'mention', name: 'file', path: '/work/f.ts' },
                  { type: 'text', text: 'and fix it', text_elements: [] },
                ],
              }),
            },
          ],
          null,
        ),
      });

      expect(((await history()).messages[0] as TranscriptContentMessage).content).toBe(
        'look at this\nand fix it',
      );
    });

    test('the time of a message is when its item completed, and a missing time reads as now', async () => {
      servePages({
        '': itemsListPage(
          [
            { item: userMessageItem('u1', 'timed'), completedAtMs: 1_700_000_123_456 },
            { item: userMessageItem('u2', 'untimed'), completedAtMs: null },
          ],
          null,
        ),
      });

      const before = Date.now();
      const { messages } = await history();

      expect((messages[0] as TranscriptContentMessage).message.createdAt).toBe(
        new Date(1_700_000_123_456).toISOString(),
      );
      const fallback = Date.parse((messages[1] as TranscriptContentMessage).message.createdAt);
      expect(fallback).toBeGreaterThanOrEqual(before - 5);
      expect(fallback).toBeLessThanOrEqual(Date.now() + 5);
    });

    test('a time that is not a date reads as now, never an error', async () => {
      servePages({
        '': itemsListPage(
          [
            { item: userMessageItem('u1', 'far future'), completedAtMs: 1e20 },
            { item: userMessageItem('u2', 'far past'), completedAtMs: -1e20 },
          ],
          null,
        ),
      });

      const before = Date.now();
      const { messages } = await history();

      expect(messages).toHaveLength(2);
      for (const m of messages) {
        const at = Date.parse(m.message.createdAt);
        expect(at).toBeGreaterThanOrEqual(before - 5);
        expect(at).toBeLessThanOrEqual(Date.now() + 5);
      }
    });

    test('an item that appears on two pages is emitted once', async () => {
      servePages({
        '': itemsListPage(
          [{ item: userMessageItem('u1', 'one') }, { item: userMessageItem('u2', 'two') }],
          'c1',
        ),
        c1: itemsListPage(
          [{ item: userMessageItem('u2', 'two') }, { item: userMessageItem('u3', 'three') }],
          null,
        ),
      });

      const { messages, count } = await history();

      expect(messages.map((m) => m.entryUuid)).toEqual(['u1', 'u2', 'u3']);
      expect(count).toBe(3);
    });

    test('a history read is for the one who asked: it does not touch the session’s own message stream', async () => {
      servePages({ '': itemsListPage([{ item: userMessageItem('u1', 'one') }], null) });

      await history();

      expect(live).toEqual([]);
      expect(structured).toEqual([]);
    });

    describe('explicit reads of one session', () => {
      /** A list that answers only when the test lets it. */
      function gatedList() {
        const gates: Array<() => void> = [];
        server.onRequest('thread/items/list', () => {
          listCalls.push({});
          return new Promise((resolve) => {
            gates.push(() =>
              resolve(itemsListPage([{ item: userMessageItem(`u${gates.length}`, 'x') }], null)),
            );
          });
        });
        return {
          open: (n: number) => gates[n]?.(),
          asked: () => gates.length,
        };
      }

      test('a second request while one is running waits for it, then runs on its own', async () => {
        const list = gatedList();
        const chat = make();
        const first: string[] = [];
        const second: string[] = [];

        const a = chat.readHistory((m) => first.push(m.entryUuid));
        await server.waitFor(() => list.asked() === 1, 'the first read to ask');
        const b = chat.readHistory((m) => second.push(m.entryUuid));
        await new Promise((r) => setTimeout(r, 50));
        // The second has not asked: only one read of a session is in flight.
        expect(list.asked()).toBe(1);

        list.open(0);
        expect(await a).toBe(1);
        await server.waitFor(() => list.asked() === 2, 'the second read to ask');
        list.open(1);
        expect(await b).toBe(1);
        expect(first).toHaveLength(1);
        expect(second).toHaveLength(1);
      });

      test('a third request, with one running and one waiting, is refused with a clear error', async () => {
        const list = gatedList();
        const chat = make();

        const a = chat.readHistory(() => {});
        await server.waitFor(() => list.asked() === 1, 'the first read to ask');
        const b = chat.readHistory(() => {});
        const error = await rejection(chat.readHistory(() => {}));

        expect((error as Error).message).toMatch(/another history read/);
        list.open(0);
        await a;
        await server.waitFor(() => list.asked() === 2, 'the waiting read to ask');
        list.open(1);
        await b;
      });

      test('after a read has finished, two requests made together both succeed: the first runs, the second waits', async () => {
        servePages({ '': itemsListPage([{ item: userMessageItem('u1', 'one') }], null) });
        const chat = make();
        expect(await chat.readHistory(() => {})).toBe(1);

        const [a, b] = await Promise.all([chat.readHistory(() => {}), chat.readHistory(() => {})]);

        expect([a, b]).toEqual([1, 1]);
      });

      test('a request that waited leaves the waiting slot free: a later pair of reads is served the same way', async () => {
        servePages({ '': itemsListPage([{ item: userMessageItem('u1', 'one') }], null) });
        const chat = make();
        // First pair: one runs, one waits.
        await Promise.all([chat.readHistory(() => {}), chat.readHistory(() => {})]);

        // Second pair: the second must wait again, not be refused.
        const second = await Promise.all([chat.readHistory(() => {}), chat.readHistory(() => {})]);

        expect(second).toEqual([1, 1]);
      });

      test('a request that waited on a read that FAILED runs on its own: it does not inherit that read’s error', async () => {
        let call = 0;
        const releases: Array<() => void> = [];
        server.onRequest('thread/items/list', () => {
          listCalls.push({});
          const n = call++;
          return new Promise((resolve, reject) => {
            releases.push(() =>
              n === 0
                ? reject({ code: -32603, message: 'the first read fails' })
                : resolve(itemsListPage([{ item: userMessageItem('u1', 'ok') }], null)),
            );
          });
        });
        const chat = make();

        const a = rejection(chat.readHistory(() => {}));
        await server.waitFor(() => releases.length === 1, 'the first read to ask');
        const b = chat.readHistory(() => {});
        releases[0]?.();
        expect(((await a) as Error).message).toContain('code -32603');
        await server.waitFor(() => releases.length === 2, 'the waiting read to ask');
        releases[1]?.();

        expect(await b).toBe(1);
      });

      test('a read that fails does not hold the next one', async () => {
        server.onRequest('thread/items/list', () => {
          throw { code: -32603, message: 'boom' };
        });
        const chat = make();
        await rejection(chat.readHistory(() => {}));

        servePages({ '': itemsListPage([{ item: userMessageItem('u1', 'one') }], null) });
        expect(await chat.readHistory(() => {})).toBe(1);
      });

      test('a read is cut at its overall deadline (60 s), after the page that passes it, and says so', async () => {
        let clock = 0;
        let n = 0;
        server.onRequest('thread/items/list', () => {
          n += 1;
          clock += 20_000; // each answer takes 20 s of the (fake) clock
          return itemsListPage([{ item: userMessageItem(`u${n}`, `m${n}`) }], `c${n}`);
        });
        const chat = make({ clockMs: () => clock });

        const { count } = await history(chat);

        // 20 s and 40 s are inside the deadline; the third answer reaches 60 s and ends the read.
        expect(n).toBe(3);
        expect(count).toBe(3);
        expect(logs.join('\n')).toMatch(/60 seconds/);
      });

      test('the deadline of a read is counted from its own start, not the session’s: a later read gets the full time', async () => {
        let clock = 1_000_000;
        let n = 0;
        server.onRequest('thread/items/list', () => {
          n += 1;
          clock += 30_000;
          return itemsListPage(
            [{ item: userMessageItem(`u${n}`, 'x') }],
            n % 2 === 1 ? `c${n}` : null,
          );
        });
        const chat = make({ clockMs: () => clock });

        expect(await chat.readHistory(() => {})).toBe(2);
        expect(await chat.readHistory(() => {})).toBe(2);
      });

      test('after a refusal the slot is free again once the running read ends', async () => {
        const list = gatedList();
        const chat = make();
        const a = chat.readHistory(() => {});
        await server.waitFor(() => list.asked() === 1, 'the first read to ask');
        const b = chat.readHistory(() => {});
        await rejection(chat.readHistory(() => {}));
        list.open(0);
        await a;
        await server.waitFor(() => list.asked() === 2, 'the waiting read to ask');
        list.open(1);
        await b;

        const c = chat.readHistory(() => {});
        await server.waitFor(() => list.asked() === 3, 'a later read to ask');
        list.open(2);
        expect(await c).toBe(1);
      });
    });

    test('a session whose thread is not known yet has no history, and asks nothing', async () => {
      tracked = null;
      servePages({ '': itemsListPage([{ item: userMessageItem('u1', 'one') }], null) });

      const { messages, count } = await history();

      expect(messages).toEqual([]);
      expect(count).toBe(0);
      expect(listCalls).toEqual([]);
    });

    test('the thread is read when asked: after a rotation the new thread is the one read', async () => {
      servePages({ '': itemsListPage([], null) });
      const chat = make();

      await history(chat);
      tracked = OTHER;
      await history(chat);

      expect(listCalls.map((c) => c['threadId'])).toEqual([MAIN, OTHER]);
    });

    test('a page with no nextCursor at all is the last page (the field is null when there is no more, and absent reads the same)', async () => {
      server.onRequest('thread/items/list', () => ({
        data: [{ turnId: 'k', item: userMessageItem('u1', 'only page'), completedAtMs: 1 }],
      }));

      const { messages, count } = await history();

      expect(messages.map((m) => m.entryUuid)).toEqual(['u1']);
      expect(count).toBe(1);
    });

    test('an empty thread is an empty history', async () => {
      servePages({ '': itemsListPage([], null) });

      expect(await history()).toEqual({ messages: [], count: 0 });
    });

    describe('when the app-server does not answer as hoped', () => {
      test('"no rollout found" on the first page is a thread with nothing written yet: an empty history, not an error', async () => {
        server.onRequest('thread/items/list', () => {
          throw { code: -32600, message: `no rollout found for thread id ${MAIN}` };
        });

        expect(await history()).toEqual({ messages: [], count: 0 });
      });

      test('any other error on the first page is an error the client is told about', async () => {
        for (const failure of [
          { code: -32600, message: 'invalid request' },
          { code: -32601, message: 'method not found: thread/items/list' },
          { code: -32602, message: 'invalid params' },
          { code: -32603, message: 'internal error' },
        ]) {
          server.onRequest('thread/items/list', () => {
            throw failure;
          });
          const error = await rejection(make().readHistory(() => {}));
          expect((error as Error).message).toContain(`code ${failure.code}`);
        }
      });

      test('"no rollout found" past the first page is not an empty history either', async () => {
        server.onRequest('thread/items/list', (params) => {
          if ((params as { cursor?: string }).cursor === undefined) {
            return itemsListPage([{ item: userMessageItem('u1', 'one') }], 'c1');
          }
          throw { code: -32600, message: `no rollout found for thread id ${MAIN}` };
        });
        const emitted: string[] = [];

        const error = await rejection(make().readHistory((m) => emitted.push(m.entryUuid)));

        expect((error as Error).message).toContain('code -32600');
        // What the first page gave was already sent; the client gets the error after it.
        expect(emitted).toEqual(['u1']);
      });

      test('a page that is not a page is an error, never an empty history', async () => {
        for (const bad of [
          null,
          'x',
          {},
          { data: 'nope', nextCursor: null },
          { data: {}, nextCursor: null },
          { data: [], nextCursor: 7 },
          { data: [], nextCursor: '' },
          { nextCursor: null },
        ]) {
          server.onRequest('thread/items/list', () => bad);
          await rejection(make().readHistory(() => {}));
        }
      });

      test('an entry of a page that is not an object, or has no item, is skipped; the rest of the page is read', async () => {
        server.onRequest('thread/items/list', () => ({
          data: [
            null,
            'x',
            { turnId: 'k' },
            { turnId: 'k', item: null },
            { turnId: 'k', item: userMessageItem('u1', 'survivor'), completedAtMs: 1 },
          ],
          nextCursor: null,
          backwardsCursor: null,
        }));

        const { messages } = await history();

        expect(messages.map((m) => m.entryUuid)).toEqual(['u1']);
      });

      test('a link that is down is an error', async () => {
        client.stop();

        await rejection(make().readHistory(() => {}));
      });

      test('an emit that throws ends the read with that error', async () => {
        servePages({ '': itemsListPage([{ item: userMessageItem('u1', 'one') }], null) });

        const error = await rejection(
          make().readHistory(() => {
            throw new Error('the connection went away');
          }),
        );

        expect((error as Error).message).toBe('the connection went away');
      });

      test('an emit that throws stops the read from asking for more pages (the requester went away)', async () => {
        servePages({
          '': itemsListPage([{ item: userMessageItem('u1', 'one') }], 'c1'),
          c1: itemsListPage([{ item: userMessageItem('u2', 'two') }], 'c2'),
          c2: itemsListPage([{ item: userMessageItem('u3', 'three') }], null),
        });

        await rejection(
          make().readHistory(() => {
            throw new Error('gone');
          }),
        );

        expect(listCalls).toHaveLength(1);
      });

      test('a cursor that does not advance ends the read instead of looping, and says so', async () => {
        servePages({
          '': itemsListPage([{ item: userMessageItem('u1', 'one') }], 'stuck'),
          stuck: itemsListPage([{ item: userMessageItem('u2', 'two') }], 'stuck'),
        });

        const { messages } = await history();

        expect(messages.map((m) => m.entryUuid)).toEqual(['u1', 'u2']);
        expect(listCalls).toHaveLength(2);
        expect(logs.join('\n')).toMatch(/cursor/);
      });

      test('cursors that alternate between two values end the read at once, not after the page limit', async () => {
        servePages({
          '': itemsListPage([{ item: userMessageItem('u1', 'one') }], 'A'),
          A: itemsListPage([{ item: userMessageItem('u2', 'two') }], 'B'),
          B: itemsListPage([{ item: userMessageItem('u3', 'three') }], 'A'),
        });

        const { messages } = await history();

        // The third answer points back at A, which was already asked for: three requests, no more.
        expect(listCalls).toHaveLength(3);
        expect(messages.map((m) => m.entryUuid)).toEqual(['u1', 'u2', 'u3']);
        expect(logs.join('\n')).toMatch(/cursor/);
      });

      test('a history that never ends is cut at 1000 pages by default, and says so', async () => {
        let n = 0;
        server.onRequest('thread/items/list', () => {
          n += 1;
          return itemsListPage([{ item: userMessageItem(`u${n}`, `m${n}`) }], `c${n}`);
        });

        const { count } = await history();

        expect(n).toBe(1000);
        expect(count).toBe(1000);
        expect(logs.join('\n')).toMatch(/1000 pages/);
      }, 30000);

      test('the page size is a request the app-server may ignore: a bigger page is read whole', async () => {
        servePages({
          '': itemsListPage(
            Array.from({ length: 250 }, (_, i) => ({ item: userMessageItem(`u${i}`, `m${i}`) })),
            null,
          ),
        });

        const { count } = await history();

        expect(count).toBe(250);
      });
    });

    test('a failed history read says the code and none of the server’s words (the log checks hold for any code that never logs; the mutants K31 and K39 are the real guard)', async () => {
      server.onRequest('thread/items/list', () => {
        throw { code: -32603, message: 'PRIVATE-SERVER-TEXT' };
      });
      const failure = await rejection(make().readHistory(() => {}));

      // What the client and the handler's log read: the code, not the server's words, which may
      // name a thread or a path.
      expect((failure as Error).message).toContain('code -32603');
      expect((failure as Error).message).not.toContain('PRIVATE');
      expect((failure as Error).message).not.toContain(MAIN);
      // The client's own log lines (the link) are the only ones: the chat logs none for this failure.
      expect(logs.join('\n')).not.toContain('PRIVATE');
    });

    test('the lines the history read does log hold counts and names, never a message', async () => {
      servePages({
        '': itemsListPage([{ item: userMessageItem('u1', 'PRIVATE-USER-TEXT') }], 'stuck'),
        stuck: itemsListPage([{ item: userMessageItem('u2', 'PRIVATE-SECOND-TEXT') }], 'stuck'),
      });

      await history();

      // The repeated cursor is the one line a successful read can log.
      const chatLines = logs.filter((l) => /cursor|history/i.test(l));
      expect(chatLines).toHaveLength(1);
      expect(chatLines[0]).not.toContain('PRIVATE');
      expect(chatLines[0]).not.toContain('stuck');
    });
  });

  describe('live items', () => {
    test('an item that completes on the main thread goes to every client as transcript_content, structured by the session’s own MessageAPI', () => {
      make().handleNotification(
        'item/completed',
        itemCompletedFrame(MAIN, agentMessageItem('a1', 'Done.', 'final_answer'), {
          completedAtMs: 1_700_000_200_000,
        })['params'],
      );

      const [m] = transcripts();
      expect(transcripts()).toHaveLength(1);
      expect((m as TranscriptContentMessage).entryUuid).toBe('a1');
      expect((m as TranscriptContentMessage).role).toBe('assistant');
      expect((m as TranscriptContentMessage).content).toBe('Done.');
      expect((m as TranscriptContentMessage).sessionId).toBe(SID);
      expect((m as TranscriptContentMessage).isUpdate).toBe(false);
      expect((m as TranscriptContentMessage).message.createdAt).toBe(
        new Date(1_700_000_200_000).toISOString(),
      );
      // Structured through the session's message API, as Claude's transcript bridge does.
      expect(structured).toHaveLength(1);
      expect((m as TranscriptContentMessage).message.id).toBe(structured[0]?.id as string);
    });

    test('user messages and commands are the same entries a history read gives', async () => {
      const items = [
        userMessageItem('u1', 'Run it'),
        realItem('commandExecution', { id: COMMAND_ID, aggregatedOutput: 'ok' }),
        agentMessageItem('a1', 'Ran.', 'final_answer'),
      ];
      servePages({
        '': itemsListPage(
          items.map((item) => ({ item })),
          null,
        ),
      });
      const fromHistory = (await history()).messages;
      const chat = make();
      for (const item of items) {
        chat.handleNotification('item/completed', itemCompletedFrame(MAIN, item)['params']);
      }

      const fromLive = transcripts();
      const essence = (m: TranscriptContentMessage) => ({
        entryUuid: m.entryUuid,
        role: m.role,
        content: m.content,
        tools: m.tools,
        contentBlocks: m.contentBlocks,
        message: m.message.content,
      });
      expect(fromLive.map(essence)).toEqual(fromHistory.map(essence));
    });

    test('a live command is written out safely too: the same builder as history', () => {
      make().handleNotification(
        'item/completed',
        itemCompletedFrame(
          MAIN,
          realItem('commandExecution', {
            id: 'live-cmd',
            command: 'ls \u202e',
            aggregatedOutput: '\u001b[1mout',
          }),
        )['params'],
      );

      const m = transcripts()[0] as TranscriptContentMessage;
      const use = m.contentBlocks?.find((b) => b.type === 'tool_use');
      const result = m.contentBlocks?.find((b) => b.type === 'tool_result');
      expect(JSON.parse(use?.toolInput ?? '').command).toBe('ls \\u202E');
      expect(result?.toolOutput).toBe('\\u001B[1mout');
    });

    test('what is not chat is ignored, and so is an item still in progress', () => {
      const chat = make();
      for (const item of [
        { type: 'reasoning', id: 'r1', summary: ['x'], content: [] },
        { type: 'plan', id: 'p1', text: 'a plan' },
        { type: 'fileChange', id: 'f1', changes: [], status: 'completed' },
        realItem('commandExecution', { id: 'c-running', status: 'inProgress' }),
        userMessageItem('u-empty', ''),
      ]) {
        chat.handleNotification('item/completed', itemCompletedFrame(MAIN, item)['params']);
      }

      expect(live).toEqual([]);
      expect(structured).toEqual([]);
    });

    test("a subagent's items, another window's and an unknown thread's are not this session's chat", () => {
      const chat = make();
      for (const threadId of [SUB, OTHER, 'not-a-known-thread']) {
        chat.handleNotification(
          'item/completed',
          itemCompletedFrame(threadId, userMessageItem(`u-${threadId}`, 'not ours'))['params'],
        );
      }

      expect(live).toEqual([]);
    });

    test('the role is read when the item arrives: after a rotation the new thread’s items count and the old one’s do not', () => {
      const roles: Record<string, 'main' | 'subagent'> = { [MAIN]: 'main' };
      const chat = make({ threadRole: (id) => roles[id] ?? null });

      chat.handleNotification(
        'item/completed',
        itemCompletedFrame(OTHER, userMessageItem('u-new', 'new'))['params'],
      );
      delete roles[MAIN];
      roles[OTHER] = 'main';
      chat.handleNotification(
        'item/completed',
        itemCompletedFrame(MAIN, userMessageItem('u-old', 'old'))['params'],
      );
      chat.handleNotification(
        'item/completed',
        itemCompletedFrame(OTHER, userMessageItem('u-new', 'new'))['params'],
      );

      expect(transcripts().map((m) => m.entryUuid)).toEqual(['u-new']);
    });

    test('an item delivered twice is sent once', () => {
      const chat = make();
      const frame = itemCompletedFrame(MAIN, agentMessageItem('a1', 'Once.', 'final_answer'))[
        'params'
      ];

      chat.handleNotification('item/completed', frame);
      chat.handleNotification('item/completed', frame);

      expect(transcripts()).toHaveLength(1);
      expect(structured).toHaveLength(1);
    });

    test('the memory of delivered items is the last 1024: the oldest of them is still remembered, the one pushed out is not', () => {
      const chat = make();
      const deliver = (id: string) =>
        chat.handleNotification(
          'item/completed',
          itemCompletedFrame(MAIN, userMessageItem(id, id))['params'],
        );
      for (let i = 0; i < 1024; i++) deliver(`u${i}`);
      expect(transcripts()).toHaveLength(1024);

      deliver('u0'); // the 1024th most recent: still remembered, not sent again
      expect(transcripts()).toHaveLength(1024);

      deliver('u1024'); // the 1025th distinct item pushes the oldest out
      deliver('u0'); // forgotten: sent again (a client keeps the first copy it saw)
      expect(transcripts()).toHaveLength(1026);
      expect(transcripts().at(-1)?.entryUuid).toBe('u0');
      deliver('u1024'); // the newest is remembered
      expect(transcripts()).toHaveLength(1026);
    });

    test('only item/completed is chat: other methods and frames that are not an item are ignored', () => {
      const chat = make();
      const params = itemCompletedFrame(MAIN, userMessageItem('u1', 'x'))['params'];
      for (const method of [
        'item/started',
        'turn/completed',
        'item/agentMessage/delta',
        'thread/started',
      ]) {
        chat.handleNotification(method, params);
      }
      for (const bad of [
        undefined,
        null,
        'x',
        42,
        [],
        {},
        { threadId: MAIN },
        { threadId: MAIN, item: null },
        { threadId: MAIN, item: 'x' },
        { threadId: 7, item: userMessageItem('u1', 'x') },
        { item: userMessageItem('u1', 'x') },
      ]) {
        chat.handleNotification('item/completed', bad);
      }

      expect(live).toEqual([]);
    });

    test('a failing send does not throw out of the handler, is logged by name only, and the item is retried when it arrives again', () => {
      let fail = true;
      const chat = make({
        sendAndRecord: (message) => {
          if (fail) throw new TypeError('PRIVATE-SEND-DETAIL');
          live.push(message);
        },
      });
      const frame = itemCompletedFrame(MAIN, userMessageItem('u1', 'PRIVATE-USER-TEXT'))['params'];

      expect(() => chat.handleNotification('item/completed', frame)).not.toThrow();
      fail = false;
      chat.handleNotification('item/completed', frame);

      expect(logs.join('\n')).toContain('TypeError');
      expect(logs.join('\n')).not.toContain('PRIVATE');
      expect(transcripts()).toHaveLength(1);
    });

    test('the retry of a failed send reuses the message it built: the structured output went out once, and the message keeps its id', () => {
      let fail = true;
      const chat = make({
        sendAndRecord: (message) => {
          if (fail) throw new TypeError('the send failed');
          live.push(message);
        },
      });
      const frame = itemCompletedFrame(MAIN, userMessageItem('u1', 'once'))['params'];

      chat.handleNotification('item/completed', frame);
      fail = false;
      chat.handleNotification('item/completed', frame);
      chat.handleNotification('item/completed', frame);

      // The MessageAPI sent its structured output when the message was built; a rebuild would send another.
      expect(structured).toHaveLength(1);
      expect(transcripts()).toHaveLength(1);
      expect(transcripts()[0]?.message.id).toBe(structured[0]?.id as string);
    });
  });
  describe('catch-up at attach (#1180 review)', () => {
    const idsOf = () => transcripts().map((m) => m.entryUuid);
    const catchUpLines = () => logs.filter((l) => /catch/i.test(l));
    const liveFrame = (i: number) =>
      itemCompletedFrame(MAIN, userMessageItem(`live-${i}`, `m${i}`))['params'];

    /** A list that answers only when the test lets it; each call is one gate, answered with the pages given. */
    function gates(answer: (n: number) => Json = () => itemsListPage([], null)) {
      const open: Array<() => void> = [];
      server.onRequest('thread/items/list', (params) => {
        listCalls.push(params as Json);
        const n = open.length;
        return new Promise((resolve) => {
          open.push(() => resolve(answer(n)));
        });
      });
      return {
        asked: () => open.length,
        release: (n: number) => open[n]?.(),
      };
    }

    test('delivers what completed before the attach, the first prompt of a new thread included, oldest first', async () => {
      servePages({
        '': itemsListPage(
          [
            { item: userMessageItem('first-prompt', 'Run the tests') },
            { item: realItem('commandExecution', { id: COMMAND_ID }) },
            { item: agentMessageItem('a1', 'Ran them.', 'final_answer') },
          ],
          null,
        ),
      });

      await make().catchUp();

      expect(idsOf()).toEqual(['first-prompt', COMMAND_ID, 'a1']);
      const [prompt] = transcripts();
      expect(prompt?.role).toBe('user');
      expect(prompt?.content).toBe('Run the tests');
      expect(listCalls).toEqual([{ threadId: MAIN, sortDirection: 'asc', limit: 100 }]);
    });

    test('goes out as transcript_content only: no structured output to every connection, and each message still carries its structure', async () => {
      servePages({
        '': itemsListPage(
          [{ item: agentMessageItem('a1', '- first\n- second', 'final_answer') }],
          null,
        ),
      });

      await make().catchUp();

      // The web client draws an entry from its transcript_content; a structured_agent_output as
      // well would double the replay buffer and, in a bound chat, be one more message per entry.
      expect(structured).toEqual([]);
      expect(live.map((m) => m.type)).toEqual(['transcript_content']);
      expect(transcripts()[0]?.message.content).toBe('- first\n- second');
      expect(transcripts()[0]?.message.bullets.map((b) => b.content)).toEqual([
        '- first',
        '- second',
      ]);
    });

    test('an item already delivered live is not sent again, and the rest still is', async () => {
      const chat = make();
      chat.handleNotification(
        'item/completed',
        itemCompletedFrame(MAIN, agentMessageItem('a1', 'live first', 'final_answer'))['params'],
      );
      servePages({
        '': itemsListPage(
          [
            { item: userMessageItem('u1', 'before') },
            { item: agentMessageItem('a1', 'live first', 'final_answer') },
          ],
          null,
        ),
      });

      await chat.catchUp();

      expect(idsOf()).toEqual(['a1', 'u1']);
    });

    test('a second catch-up (a reconnect) sends nothing it already sent, and does send what is new', async () => {
      const chat = make();
      const items = [
        { item: userMessageItem('u1', 'one') },
        { item: userMessageItem('u2', 'two') },
      ];
      servePages({ '': itemsListPage(items, null) });
      await chat.catchUp();
      await chat.catchUp();
      expect(idsOf()).toEqual(['u1', 'u2']);

      servePages({
        '': itemsListPage(
          [...items, { item: agentMessageItem('a1', 'new', 'final_answer') }],
          null,
        ),
      });
      await chat.catchUp();
      expect(idsOf()).toEqual(['u1', 'u2', 'a1']);
    });

    test('live items that arrive while the history is being read are held and sent after it, in order', async () => {
      const list = gates(() =>
        itemsListPage(
          [
            { item: userMessageItem('u1', 'first prompt') },
            { item: agentMessageItem('a1', 'also live', 'final_answer') },
          ],
          null,
        ),
      );
      const chat = make();

      const caughtUp = chat.catchUp();
      await server.waitFor(() => list.asked() === 1, 'the catch-up read to ask');
      chat.handleNotification(
        'item/completed',
        itemCompletedFrame(MAIN, agentMessageItem('a1', 'also live', 'final_answer'))['params'],
      );
      chat.handleNotification(
        'item/completed',
        itemCompletedFrame(MAIN, agentMessageItem('a2', 'only live', 'final_answer'))['params'],
      );
      // Held: nothing has gone out yet, so the prompt cannot arrive after what it caused.
      expect(idsOf()).toEqual([]);

      list.release(0);
      await caughtUp;

      expect(idsOf()).toEqual(['u1', 'a1', 'a2']);
    });

    describe('the hold starts when the attach request is sent, not when it succeeds', () => {
      test('an item that arrives between attaching() and the catch-up is held, and goes out after the history it belongs after', async () => {
        const list = gates(() =>
          itemsListPage(
            [
              { item: userMessageItem('prompt', 'the prompt') },
              { item: agentMessageItem('answer', 'what it caused', 'final_answer') },
            ],
            null,
          ),
        );
        const chat = make();

        chat.attaching();
        // The app-server wrote the answer right behind the response of `thread/resume`, in one chunk:
        // it arrives before the callback that starts the catch-up.
        chat.handleNotification(
          'item/completed',
          itemCompletedFrame(MAIN, agentMessageItem('answer', 'what it caused', 'final_answer'))[
            'params'
          ],
        );
        expect(idsOf()).toEqual([]);
        const caughtUp = chat.catchUp();
        await server.waitFor(() => list.asked() === 1, 'the catch-up read to ask');
        list.release(0);
        await caughtUp;

        expect(idsOf()).toEqual(['prompt', 'answer']);
      });

      test('attachFailed() releases what was held, in arrival order, at once; later items are not held', () => {
        const chat = make();

        chat.attaching();
        for (const i of [0, 1, 2]) chat.handleNotification('item/completed', liveFrame(i));
        expect(idsOf()).toEqual([]);
        chat.attachFailed();
        expect(idsOf()).toEqual(['live-0', 'live-1', 'live-2']);

        chat.handleNotification('item/completed', liveFrame(3));
        expect(idsOf()).toEqual(['live-0', 'live-1', 'live-2', 'live-3']);
      });

      test('attachFailed() while a catch-up is reading leaves the hold to that read, which sends the history first', async () => {
        const list = gates(() => itemsListPage([{ item: userMessageItem('u1', 'history') }], null));
        const chat = make();
        const caughtUp = chat.catchUp();
        await server.waitFor(() => list.asked() === 1, 'the read to ask');
        chat.handleNotification('item/completed', liveFrame(0));

        chat.attachFailed();
        expect(idsOf()).toEqual([]);
        list.release(0);
        await caughtUp;

        expect(idsOf()).toEqual(['u1', 'live-0']);
      });

      test('an announced attach keeps the hold after a read that ends before it succeeds, until its own catch-up has run', async () => {
        const list = gates(() => itemsListPage([{ item: userMessageItem('u1', 'history') }], null));
        const chat = make();
        chat.attaching();
        const first = chat.catchUp();
        await server.waitFor(() => list.asked() === 1, 'the first read to ask');
        chat.attaching(); // a reconnect: the next request is out while the first read still runs
        chat.handleNotification('item/completed', liveFrame(0));
        list.release(0);
        await first;

        // The read ended, but the new attach has not: its history is still to come.
        expect(idsOf()).toEqual(['u1']);
        chat.handleNotification('item/completed', liveFrame(1));
        expect(idsOf()).toEqual(['u1']);

        const second = chat.catchUp();
        await server.waitFor(() => list.asked() === 2, 'the second read to ask');
        list.release(1);
        await second;

        expect(idsOf()).toEqual(['u1', 'live-0', 'live-1']);
      });

      test('the same item twice, once in the hold and once in the history, is sent once, at its place in the history', async () => {
        const list = gates(() =>
          itemsListPage(
            [
              { item: userMessageItem('u1', 'first') },
              { item: userMessageItem('u2', 'second') },
              { item: userMessageItem('u3', 'third') },
            ],
            null,
          ),
        );
        const chat = make();
        chat.attaching();
        const caughtUp = chat.catchUp();
        await server.waitFor(() => list.asked() === 1, 'the read to ask');
        for (const id of ['u3', 'u3', 'live-only']) {
          chat.handleNotification(
            'item/completed',
            itemCompletedFrame(MAIN, userMessageItem(id, id))['params'],
          );
        }
        list.release(0);
        await caughtUp;

        expect(idsOf()).toEqual(['u1', 'u2', 'u3', 'live-only']);
      });
    });

    test('more live items than the hold takes keep their arrival order: the held ones go first, the history is left to an explicit read, and it says so once', async () => {
      const list = gates(() => itemsListPage([{ item: userMessageItem('u1', 'prompt') }], null));
      const chat = make();
      const caughtUp = chat.catchUp();
      await server.waitFor(() => list.asked() === 1, 'the catch-up read to ask');

      for (let i = 0; i < 256; i++) chat.handleNotification('item/completed', liveFrame(i));
      // 256 fit the hold: nothing is out yet.
      expect(idsOf()).toEqual([]);
      for (let i = 256; i < 300; i++) chat.handleNotification('item/completed', liveFrame(i));
      // The 257th found it full: the held ones went out first, in the order they came, then it.
      expect(idsOf()).toEqual(Array.from({ length: 300 }, (_, i) => `live-${i}`));

      list.release(0);
      await caughtUp;

      // The history is not sent after them (it would be out of order): an explicit read has it.
      expect(idsOf()).toEqual(Array.from({ length: 300 }, (_, i) => `live-${i}`));
      expect(catchUpLines()).toHaveLength(1);
      expect(catchUpLines()[0]).not.toMatch(/live-|prompt|m\d/);
    });

    test('overflow before the resume response abandons history until that hold ends, then a later attach can catch up', async () => {
      servePages({ '': itemsListPage([{ item: userMessageItem('old-prompt', 'PROMPT') }], null) });
      const chat = make();
      chat.attaching();
      for (let i = 0; i < 257; i++) chat.handleNotification('item/completed', liveFrame(i));
      const arrived = Array.from({ length: 257 }, (_, i) => `live-${i}`);
      expect(idsOf()).toEqual(arrived);

      await chat.catchUp();
      expect(idsOf()).toEqual(arrived);
      expect(catchUpLines()).toHaveLength(1);

      // The old hold ended. A separate attach starts a new catch-up cycle.
      chat.attaching();
      await chat.catchUp();
      expect(idsOf()).toEqual([...arrived, 'old-prompt']);
    });

    test('overflow abandonment survives another attach and its follow-up while the same hold is still running', async () => {
      const list = gates(() =>
        itemsListPage([{ item: userMessageItem('old-prompt', 'PROMPT') }], null),
      );
      const chat = make();
      chat.attaching();
      const first = chat.catchUp();
      await server.waitFor(() => list.asked() === 1, 'the first catch-up to ask');
      for (let i = 0; i < 257; i++) chat.handleNotification('item/completed', liveFrame(i));
      const arrived = Array.from({ length: 257 }, (_, i) => `live-${i}`);
      chat.attaching();
      const second = chat.catchUp();
      list.release(0);
      await server.waitFor(() => list.asked() === 2, 'the follow-up to ask');
      list.release(1);
      await Promise.all([first, second]);
      expect(idsOf()).toEqual(arrived);
      expect(catchUpLines()).toHaveLength(1);
    });

    test('a failing list is logged without content, delivers nothing, never throws, and the held items still go out', async () => {
      let fail: () => void = () => {};
      server.onRequest('thread/items/list', () => {
        listCalls.push({});
        return new Promise((_resolve, reject) => {
          fail = () => reject({ code: -32603, message: 'PRIVATE-SERVER-TEXT' });
        });
      });
      const chat = make();
      const caughtUp = chat.catchUp();
      await server.waitFor(() => listCalls.length === 1, 'the catch-up read to ask');
      chat.handleNotification(
        'item/completed',
        itemCompletedFrame(MAIN, userMessageItem('held', 'PRIVATE-LIVE-TEXT'))['params'],
      );

      fail();
      await caughtUp;

      expect(idsOf()).toEqual(['held']);
      const mine = logs.filter((l) => /catch/i.test(l));
      expect(mine).toHaveLength(1);
      expect(mine[0]).toContain('code -32603');
      expect(logs.join('\n')).not.toContain('PRIVATE');
    });

    test('a list that never answers holds the live items only as long as its timeout', async () => {
      server.ignore('thread/items/list');
      const chat = make({ catchUpRequestTimeoutMs: 60 });
      const caughtUp = chat.catchUp();
      chat.handleNotification(
        'item/completed',
        itemCompletedFrame(MAIN, userMessageItem('held', 'x'))['params'],
      );
      expect(idsOf()).toEqual([]);

      await caughtUp;

      expect(idsOf()).toEqual(['held']);
      expect(logs.some((l) => /catch/i.test(l))).toBe(true);
    });

    test('the request timeout of a catch-up is 3 seconds unless the seam says otherwise', async () => {
      const timeouts: Array<number | undefined> = [];
      const chat = make({
        client: {
          request: (method, params, timeoutMs) => {
            timeouts.push(timeoutMs);
            return client.request(method, params, timeoutMs);
          },
        },
      });
      servePages({ '': itemsListPage([], null) });

      await chat.catchUp();

      expect(timeouts).toEqual([3000]);
    });

    test('a thread longer than one page is left to an explicit history read: only that page is asked for, nothing is sent, and it says so', async () => {
      let n = 0;
      server.onRequest('thread/items/list', () => {
        n += 1;
        return itemsListPage([{ item: userMessageItem(`u${n}`, `m${n}`) }], `c${n}`);
      });

      await make().catchUp();

      // One page of 100 is the bound: a thread that goes on is not a catch-up, and its prompt is not
      // sent without what came after it. (A catch-up of many pages is hundreds of replayed messages.)
      expect(n).toBe(1);
      expect(idsOf()).toEqual([]);
      expect(catchUpLines()).toHaveLength(1);
      expect(catchUpLines()[0]).toMatch(/one page/);
    });

    test('a thread of exactly one full page (100 items, no cursor on) is caught up whole; one with a cursor on is not', async () => {
      const hundred = Array.from({ length: 100 }, (_, i) => ({
        item: userMessageItem(`u${i}`, `m${i}`),
      }));
      servePages({ '': itemsListPage(hundred, null) });
      await make().catchUp();
      expect(idsOf()).toEqual(hundred.map((_, i) => `u${i}`));

      live = [];
      servePages({ '': itemsListPage(hundred, 'more') });
      await make().catchUp();
      expect(idsOf()).toEqual([]);
    });

    test('an oversized page is left to an explicit read even when its cursor ends: all 101 raw entries count', async () => {
      for (const oversized of [
        Array.from({ length: 101 }, (_, i) => ({ item: userMessageItem(`u${i}`, `m${i}`) })),
        [{ item: userMessageItem('only-chat-item', 'PRIVATE-PROMPT') }, ...Array(100).fill(null)],
      ]) {
        live = [];
        logs = [];
        servePages({ '': { data: oversized, nextCursor: null } });
        const chat = make();
        await chat.catchUp();
        expect(idsOf()).toEqual([]);
        expect(catchUpLines()).toHaveLength(1);
        expect(catchUpLines()[0]).toContain('100 items');
        expect(logs.join('\n')).not.toContain('PRIVATE-PROMPT');

        const read: TranscriptContentMessage[] = [];
        const count = await chat.readHistory((message) => read.push(message));
        expect(count).toBe(oversized[1] === null ? 1 : 101);
        expect(read).toHaveLength(count);
      }
    });

    test('a cursor that repeats is an unfinished read: nothing is sent', async () => {
      servePages({
        '': itemsListPage([{ item: userMessageItem('u1', 'one') }], 'stuck'),
        stuck: itemsListPage([{ item: userMessageItem('u2', 'two') }], 'stuck'),
      });

      await make().catchUp();

      expect(idsOf()).toEqual([]);
    });

    test('a thread with nothing written yet, and a session with no thread, are nothing to catch up', async () => {
      server.onRequest('thread/items/list', () => {
        throw { code: -32600, message: `no rollout found for thread id ${MAIN}` };
      });
      await make().catchUp();
      expect(idsOf()).toEqual([]);

      servePages({ '': itemsListPage([{ item: userMessageItem('u1', 'one') }], null) });
      tracked = null;
      listCalls = [];
      await make().catchUp();
      expect(listCalls).toEqual([]);
      expect(idsOf()).toEqual([]);
    });

    test('an attach while a catch-up is running is not lost: one more read follows it', async () => {
      const list = gates((n) =>
        itemsListPage(
          n > 0
            ? [
                { item: userMessageItem('u1', 'one') },
                { item: userMessageItem('u2', 'after reconnect') },
              ]
            : [{ item: userMessageItem('u1', 'one') }],
          null,
        ),
      );
      const chat = make();

      const first = chat.catchUp();
      await server.waitFor(() => list.asked() === 1, 'the first read to ask');
      const second = chat.catchUp();
      list.release(0);
      await server.waitFor(() => list.asked() === 2, 'the follow-up read to ask');
      list.release(1);
      await Promise.all([first, second]);

      expect(listCalls).toHaveLength(2);
      expect(idsOf()).toEqual(['u1', 'u2']);
    });

    test('three attaches in a row are one running read and one follow-up, not three', async () => {
      const list = gates();
      const chat = make();

      const all = [chat.catchUp(), chat.catchUp(), chat.catchUp()];
      await server.waitFor(() => list.asked() === 1, 'the first read to ask');
      list.release(0);
      await server.waitFor(() => list.asked() === 2, 'the follow-up to ask');
      list.release(1);
      await Promise.all(all);

      expect(listCalls).toHaveLength(2);
    });

    describe('a rotation while a catch-up is running', () => {
      const rotate = () => {
        tracked = OTHER;
        roles = { [OTHER]: 'main' };
      };

      test('the history of the thread that was tracked is skipped, with a line saying so, and the follow-up read gives the new thread its own', async () => {
        const list = gates((n) =>
          itemsListPage(
            [{ item: userMessageItem(n === 0 ? 'old-history' : 'new-history', 'x') }],
            null,
          ),
        );
        const chat = make();
        const first = chat.catchUp();
        await server.waitFor(() => list.asked() === 1, 'the read of the old thread to ask');

        rotate();
        const second = chat.catchUp(); // the attach to the new thread
        list.release(0);
        await server.waitFor(() => list.asked() === 2, 'the follow-up read to ask');
        // Nothing of the old thread has gone out.
        expect(idsOf()).toEqual([]);
        list.release(1);
        await Promise.all([first, second]);

        expect(listCalls.map((c) => c['threadId'])).toEqual([MAIN, OTHER]);
        expect(idsOf()).toEqual(['new-history']);
        expect(catchUpLines().filter((l) => /changed|rotat/i.test(l))).toHaveLength(1);
      });

      test('an item held for the old thread is dropped by its role when the hold ends; one for the new thread goes out', async () => {
        const list = gates((n) =>
          itemsListPage(n === 0 ? [] : [{ item: userMessageItem('new-history', 'x') }], null),
        );
        const chat = make();
        const first = chat.catchUp();
        await server.waitFor(() => list.asked() === 1, 'the read to ask');
        chat.handleNotification(
          'item/completed',
          itemCompletedFrame(MAIN, userMessageItem('old-live', 'old'))['params'],
        );

        rotate();
        chat.handleNotification(
          'item/completed',
          itemCompletedFrame(OTHER, userMessageItem('new-live', 'new'))['params'],
        );
        const second = chat.catchUp();
        list.release(0);
        await server.waitFor(() => list.asked() === 2, 'the follow-up read to ask');
        list.release(1);
        await Promise.all([first, second]);

        expect(idsOf()).toEqual(['new-history', 'new-live']);
      });

      test('a read that ends before the attach to the new thread has finished keeps the new thread’s items held for its own history', async () => {
        const list = gates((n) => itemsListPage([{ item: userMessageItem(`h${n}`, 'x') }], null));
        const chat = make();
        chat.attaching();
        const first = chat.catchUp();
        await server.waitFor(() => list.asked() === 1, 'the read of the old thread to ask');

        rotate();
        chat.attaching(); // the new thread's `thread/resume` is out
        chat.handleNotification(
          'item/completed',
          itemCompletedFrame(OTHER, userMessageItem('new-live', 'new'))['params'],
        );
        list.release(0);
        await first;
        // The old read has ended, and nothing of either thread has gone out: the new one's history comes first.
        expect(idsOf()).toEqual([]);

        const second = chat.catchUp();
        await server.waitFor(() => list.asked() === 2, 'the read of the new thread to ask');
        list.release(1);
        await second;

        expect(idsOf()).toEqual(['h1', 'new-live']);
      });

      test('a catch-up reads the thread tracked now, never another', async () => {
        servePages({ '': itemsListPage([{ item: userMessageItem('u1', 'one') }], null) });
        tracked = OTHER;

        await make().catchUp();

        expect(listCalls.map((c) => c['threadId'])).toEqual([OTHER]);
      });
    });

    test('a failing send is logged by name and does not stop the rest of the catch-up', async () => {
      servePages({
        '': itemsListPage(
          [{ item: userMessageItem('u1', 'PRIVATE-ONE') }, { item: userMessageItem('u2', 'two') }],
          null,
        ),
      });
      let calls = 0;
      const chat = make({
        sendAndRecord: (message) => {
          calls += 1;
          if (calls === 1) throw new TypeError('PRIVATE-SEND-DETAIL');
          live.push(message);
        },
      });

      await chat.catchUp();

      expect(idsOf()).toEqual(['u2']);
      expect(logs.join('\n')).toContain('TypeError');
      expect(logs.join('\n')).not.toContain('PRIVATE');
    });
  });

  describe('dispose (#1180 review)', () => {
    const idsOf = () => transcripts().map((m) => m.entryUuid);

    test('a held item of a disposed chat sends nothing: not a transcript_content, and not a structured output either', () => {
      const chat = make();
      chat.attaching();
      chat.handleNotification(
        'item/completed',
        itemCompletedFrame(MAIN, userMessageItem('held', 'x'))['params'],
      );

      chat.dispose();
      chat.attachFailed();

      expect(live).toEqual([]);
      expect(structured).toEqual([]);
    });

    test('a catch-up whose read finishes after dispose sends neither the history nor what it held', async () => {
      let release: () => void = () => {};
      server.onRequest('thread/items/list', () => {
        listCalls.push({});
        return new Promise((resolve) => {
          release = () =>
            resolve(itemsListPage([{ item: userMessageItem('u1', 'history') }], null));
        });
      });
      const chat = make();
      const caughtUp = chat.catchUp();
      await server.waitFor(() => listCalls.length === 1, 'the read to ask');
      chat.handleNotification(
        'item/completed',
        itemCompletedFrame(MAIN, userMessageItem('held', 'x'))['params'],
      );

      chat.dispose();
      release();
      await caughtUp;

      expect(live).toEqual([]);
      expect(structured).toEqual([]);
    });

    test('after dispose a live item is dropped, a catch-up asks nothing, and disposing twice is harmless', async () => {
      servePages({ '': itemsListPage([{ item: userMessageItem('u1', 'one') }], null) });
      const chat = make();

      chat.dispose();
      chat.dispose();
      chat.handleNotification(
        'item/completed',
        itemCompletedFrame(MAIN, userMessageItem('late', 'x'))['params'],
      );
      await chat.catchUp();

      expect(listCalls).toEqual([]);
      expect(idsOf()).toEqual([]);
      expect(structured).toEqual([]);
    });
  });
});
