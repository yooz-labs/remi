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
          expect((error as { code?: number }).code).toBe(failure.code);
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

        expect((error as { code?: number }).code).toBe(-32600);
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

      test('a history that never ends is cut at the page limit, and says so', async () => {
        let n = 0;
        server.onRequest('thread/items/list', () => {
          n += 1;
          return itemsListPage([{ item: userMessageItem(`u${n}`, `m${n}`) }], `c${n}`);
        });

        const { messages, count } = await history(make({ maxPages: 3 }));

        expect(count).toBe(3);
        expect(messages.map((m) => m.entryUuid)).toEqual(['u1', 'u2', 'u3']);
        expect(n).toBe(3);
        expect(logs.join('\n')).toMatch(/3 pages/);
      });

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

    test('nothing a message says reaches a log line', async () => {
      servePages({
        '': itemsListPage(
          [
            { item: userMessageItem('u1', 'PRIVATE-USER-TEXT') },
            {
              item: realItem('commandExecution', {
                command: 'PRIVATE-COMMAND',
                aggregatedOutput: 'PRIVATE-OUTPUT',
              }),
            },
          ],
          null,
        ),
      });
      await history();
      server.onRequest('thread/items/list', () => {
        throw { code: -32603, message: 'PRIVATE-SERVER-TEXT' };
      });
      const failure = await rejection(make().readHistory(() => {}));

      const log = logs.join('\n');
      expect(log).not.toContain('PRIVATE');
      expect(log).not.toContain(MAIN);
      // The error a client and the handler's log read carries the code, not the server's words
      // (which may name a thread or a path).
      expect((failure as Error).message).not.toContain('PRIVATE');
      expect((failure as Error).message).toContain('-32603');
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
});
