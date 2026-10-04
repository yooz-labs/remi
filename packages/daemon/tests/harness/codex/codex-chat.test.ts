/**
 * Codex chat (#1180, Phase 6 of the Codex epic #1175): a session's history read from the
 * app-server's paged items, and its live `item/completed` frames, both as `transcript_content`.
 *
 * Everything under test is real: `createCodexChat`, the real `AppServerClient` talking to the
 * `FakeAppServer` (a real WebSocket server on a unix socket), and the daemon's own `MessageAPI`
 * that structures each message. The items are the real items of the spike (`realItem`,
 * `helpers/codex-threads.ts`); only the `thread/items/list` page around them is the generated
 * schema's shape (no real response was captured), which live step LV-5 checks, with whether the
 * app-server pages as assumed here.
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
      threadRole: (threadId) => ROLES[threadId] ?? null,
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

      test('a read that fails does not hold the next one', async () => {
        server.onRequest('thread/items/list', () => {
          throw { code: -32603, message: 'boom' };
        });
        const chat = make();
        await rejection(chat.readHistory(() => {}));

        servePages({ '': itemsListPage([{ item: userMessageItem('u1', 'one') }], null) });
        expect(await chat.readHistory(() => {})).toBe(1);
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

    test('the memory of delivered items is bounded: the oldest is forgotten, the newest is not', () => {
      const chat = make();
      const deliver = (id: string) =>
        chat.handleNotification(
          'item/completed',
          itemCompletedFrame(MAIN, userMessageItem(id, id))['params'],
        );
      for (let i = 0; i < 1100; i++) deliver(`u${i}`);
      const before = transcripts().length;

      deliver('u0'); // pushed out long ago: sent again (a client keeps the first copy it saw)
      deliver('u1099'); // still remembered: not sent again

      expect(before).toBe(1100);
      expect(transcripts()).toHaveLength(1101);
      expect(transcripts().at(-1)?.entryUuid).toBe('u0');
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
  });
  describe('catch-up at attach (#1180 review)', () => {
    const idsOf = () => transcripts().map((m) => m.entryUuid);

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

    test('goes out through the session’s own message stream, structured by its own MessageAPI, as a live item does', async () => {
      servePages({ '': itemsListPage([{ item: userMessageItem('u1', 'hello') }], null) });

      await make().catchUp();

      expect(structured).toHaveLength(1);
      expect(transcripts()[0]?.message.id).toBe(structured[0]?.id as string);
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
      let release: () => void = () => {};
      server.onRequest('thread/items/list', () => {
        listCalls.push({});
        return new Promise((resolve) => {
          release = () =>
            resolve(
              itemsListPage(
                [
                  { item: userMessageItem('u1', 'first prompt') },
                  { item: agentMessageItem('a1', 'also live', 'final_answer') },
                ],
                null,
              ),
            );
        });
      });
      const chat = make();

      const caughtUp = chat.catchUp();
      await server.waitFor(() => listCalls.length === 1, 'the catch-up read to ask');
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

      release();
      await caughtUp;

      expect(idsOf()).toEqual(['u1', 'a1', 'a2']);
    });

    test('more live items than the hold takes are sent at once, and none is lost', async () => {
      let release: () => void = () => {};
      server.onRequest('thread/items/list', () => {
        listCalls.push({});
        return new Promise((resolve) => {
          release = () => resolve(itemsListPage([{ item: userMessageItem('u1', 'prompt') }], null));
        });
      });
      const chat = make();
      const caughtUp = chat.catchUp();
      await server.waitFor(() => listCalls.length === 1, 'the catch-up read to ask');

      for (let i = 0; i < 300; i++) {
        chat.handleNotification(
          'item/completed',
          itemCompletedFrame(MAIN, userMessageItem(`live-${i}`, `m${i}`))['params'],
        );
      }
      // 256 are held; the rest went out when they arrived.
      expect(idsOf()).toHaveLength(44);

      release();
      await caughtUp;
      expect(idsOf()).toHaveLength(301);
      expect(new Set(idsOf()).size).toBe(301);
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

    test('a thread longer than the catch-up bound is left to an explicit history read: nothing is sent, and it says so', async () => {
      let n = 0;
      server.onRequest('thread/items/list', () => {
        n += 1;
        return itemsListPage([{ item: userMessageItem(`u${n}`, `m${n}`) }], `c${n}`);
      });

      await make().catchUp();

      // Five pages are read, the thread goes on, and the oldest 500 are not a catch-up: not sent.
      expect(n).toBe(5);
      expect(idsOf()).toEqual([]);
      expect(logs.filter((l) => /catch/i.test(l))).toHaveLength(1);
    });

    test('a thread that fits in the bound exactly is caught up whole', async () => {
      const pages: Record<string, Json> = {};
      let cursor = '';
      for (let page = 1; page <= 5; page++) {
        const next = page === 5 ? null : `c${page}`;
        pages[cursor] = itemsListPage([{ item: userMessageItem(`u${page}`, `m${page}`) }], next);
        cursor = next ?? '';
      }
      servePages(pages);

      await make().catchUp();

      expect(idsOf()).toEqual(['u1', 'u2', 'u3', 'u4', 'u5']);
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
      const gates: Array<() => void> = [];
      server.onRequest('thread/items/list', () => {
        listCalls.push({});
        return new Promise((resolve) => {
          gates.push(() =>
            resolve(
              itemsListPage(
                gates.length > 1
                  ? [
                      { item: userMessageItem('u1', 'one') },
                      { item: userMessageItem('u2', 'after reconnect') },
                    ]
                  : [{ item: userMessageItem('u1', 'one') }],
                null,
              ),
            ),
          );
        });
      });
      const chat = make();

      const first = chat.catchUp();
      await server.waitFor(() => gates.length === 1, 'the first read to ask');
      const second = chat.catchUp();
      gates[0]?.();
      await server.waitFor(() => gates.length === 2, 'the follow-up read to ask');
      gates[1]?.();
      await Promise.all([first, second]);

      expect(listCalls).toHaveLength(2);
      expect(idsOf()).toEqual(['u1', 'u2']);
    });

    test('three attaches in a row are one running read and one follow-up, not three', async () => {
      const gates: Array<() => void> = [];
      server.onRequest('thread/items/list', () => {
        listCalls.push({});
        return new Promise((resolve) => {
          gates.push(() => resolve(itemsListPage([], null)));
        });
      });
      const chat = make();

      const all = [chat.catchUp(), chat.catchUp(), chat.catchUp()];
      await server.waitFor(() => gates.length === 1, 'the first read to ask');
      gates[0]?.();
      await server.waitFor(() => gates.length === 2, 'the follow-up to ask');
      gates[1]?.();
      await Promise.all(all);

      expect(listCalls).toHaveLength(2);
    });

    test('a catch-up never delivers prose of another thread: it reads the thread tracked now', async () => {
      servePages({ '': itemsListPage([{ item: userMessageItem('u1', 'one') }], null) });
      tracked = OTHER;

      await make().catchUp();

      expect(listCalls.map((c) => c['threadId'])).toEqual([OTHER]);
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
});
