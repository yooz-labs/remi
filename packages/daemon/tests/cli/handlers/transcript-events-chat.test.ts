/**
 * The chat seam of the transcript-load handler (#1180, Phase 6 of the Codex epic #1175): a
 * harness whose history is not a file (`HarnessSession.chat`) answers `transcript_load_request`
 * through `chatFor`, and every other session takes the path it always took.
 *
 * The handler under test is the real `createTranscriptHandlers`. `HarnessChat` is the interface
 * seam of the harness, so a test chat here is the collaborator the handler is written against;
 * the real Codex chat behind the same seam is exercised in `harness/codex/codex-chat.test.ts`
 * and, with the whole daemon, in `integration/codex-launch-characterization.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createTranscriptContent } from '@remi/shared';
import type {
  ProtocolMessage,
  StructuredMessage,
  TranscriptContentMessage,
  UUID,
} from '@remi/shared';
import { SubagentViewRegistry } from '../../../src/api/subagent-view-registry.ts';
import { createTranscriptHandlers } from '../../../src/cli/handlers/transcript-events.ts';
import { __resetLoggerForTests, configureLogger } from '../../../src/cli/logger.ts';
import { ClaudeHarness } from '../../../src/harness/index.ts';
import type { HarnessChat } from '../../../src/harness/types.ts';
import { SessionBindingStore } from '../../../src/session/session-binding-store.ts';
import { SessionStore } from '../../../src/session/session-store.ts';
import { TranscriptIndex } from '../../../src/session/transcript-index.ts';
import { TranscriptDiscovery } from '../../../src/transcript/transcript-discovery.ts';
import type { TranscriptWatcher } from '../../../src/transcript/transcript-watcher.ts';
import { stripComments } from '../../helpers/strip-comments.ts';

const CID = 'conn0000-0000-0000-0000-000000000000' as UUID;
const OTHER_CID = 'conn1111-1111-1111-1111-111111111111' as UUID;
const REQ = 'req00000-0000-0000-0000-000000000000' as UUID;
const CODEX_SESSION = 'cdx00000-0000-0000-0000-000000000000' as UUID;

function structuredFor(sessionId: UUID, text: string): StructuredMessage {
  return {
    id: crypto.randomUUID(),
    sessionId,
    sender: 'agent',
    content: text,
    createdAt: new Date().toISOString(),
    state: 'delivered',
    stateChangedAt: new Date().toISOString(),
    isEditing: false,
    bullets: [],
  };
}

function entry(sessionId: UUID, entryUuid: string, text: string): TranscriptContentMessage {
  return createTranscriptContent(
    sessionId,
    entryUuid,
    'assistant',
    text,
    structuredFor(sessionId, text),
    false,
  );
}

async function waitFor(predicate: () => boolean, what: string, maxMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > maxMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('transcript load through a harness chat (chatFor)', () => {
  let tmpDir: string;
  let projectsDir: string;
  let discovery: TranscriptDiscovery;
  let sendCalls: Array<{ connectionId: UUID; message: ProtocolMessage }>;
  let asked: UUID[];

  const send = (connectionId: UUID, message: ProtocolMessage): boolean => {
    sendCalls.push({ connectionId, message });
    return true;
  };

  function make(chatFor?: (id: UUID) => HarnessChat | undefined) {
    const sessionStore = new SessionStore(path.join(tmpDir, 'sessions.json'));
    const transcriptIndex = new TranscriptIndex(path.join(tmpDir, 'transcript-index.json'));
    return createTranscriptHandlers({
      transcriptDiscovery: discovery,
      harness: new ClaudeHarness(discovery),
      transcriptWatchers: new Map<UUID, TranscriptWatcher>(),
      bindingStore: new SessionBindingStore(sessionStore, transcriptIndex),
      transcriptIndex,
      currentOwnedSession: () => null,
      subagentViews: new SubagentViewRegistry(),
      send,
      ...(chatFor === undefined
        ? {}
        : {
            chatFor: (id: UUID) => {
              asked.push(id);
              return chatFor(id);
            },
          }),
    });
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-transcript-chat-'));
    projectsDir = path.join(tmpDir, 'claude-projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    discovery = new TranscriptDiscovery({ projectsDir });
    sendCalls = [];
    asked = [];
    configureLogger({ writeLog: () => {} });
  });

  afterEach(() => {
    __resetLoggerForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const types = (): string[] => sendCalls.map((c) => c.message.type);

  test("streams the chat's history to the requester and then completes the load with the count and the request id", async () => {
    const chat: HarnessChat = {
      readHistory: async (emit) => {
        emit(entry(CODEX_SESSION, 'e1', 'first'));
        emit(entry(CODEX_SESSION, 'e2', 'second'));
        return 2;
      },
    };

    make(() => chat).onTranscriptLoadRequest(CID, CODEX_SESSION, REQ);
    await waitFor(() => types().includes('transcript_load_complete'), 'the load to complete');

    expect(types()).toEqual([
      'transcript_content',
      'transcript_content',
      'transcript_load_complete',
    ]);
    expect(sendCalls.map((c) => c.connectionId)).toEqual([CID, CID, CID]);
    expect(
      sendCalls.slice(0, 2).map((c) => (c.message as TranscriptContentMessage).entryUuid),
    ).toEqual(['e1', 'e2']);
    expect(sendCalls[2]?.message).toMatchObject({
      type: 'transcript_load_complete',
      sessionId: CODEX_SESSION,
      messageCount: 2,
      requestId: REQ,
    });
  });

  test('an empty history completes the load with a count of zero', async () => {
    make(() => ({ readHistory: async () => 0 })).onTranscriptLoadRequest(CID, CODEX_SESSION, REQ);
    await waitFor(() => types().includes('transcript_load_complete'), 'the load to complete');

    expect(types()).toEqual(['transcript_load_complete']);
    expect((sendCalls[0]?.message as { messageCount: number }).messageCount).toBe(0);
  });

  test('asks about the session id the request names, and answers only the connection that asked', async () => {
    const chat: HarnessChat = {
      readHistory: async (emit) => {
        emit(entry(CODEX_SESSION, 'e1', 'x'));
        return 1;
      },
    };
    const handlers = make((id) => (id === CODEX_SESSION ? chat : undefined));

    handlers.onTranscriptLoadRequest(OTHER_CID, CODEX_SESSION, REQ);
    await waitFor(() => types().includes('transcript_load_complete'), 'the load to complete');

    expect(asked).toEqual([CODEX_SESSION]);
    expect(new Set(sendCalls.map((c) => c.connectionId))).toEqual(new Set([OTHER_CID]));
  });

  test('a session with no chat takes the transcript path it always took: an unknown id is NOT_FOUND, and the chat lookup did not change that', () => {
    make(() => undefined).onTranscriptLoadRequest(CID, 'bogus0-0000-0000-0000-000000000000', REQ);

    expect(asked).toEqual(['bogus0-0000-0000-0000-000000000000']);
    expect(sendCalls).toHaveLength(1);
    expect((sendCalls[0]?.message as { code?: string }).code).toBe('NOT_FOUND');
  });

  test('a handler built with no chatFor behaves exactly as before', () => {
    make().onTranscriptLoadRequest(CID, 'bogus0-0000-0000-0000-000000000000', REQ);

    expect(sendCalls).toHaveLength(1);
    expect((sendCalls[0]?.message as { code?: string }).code).toBe('NOT_FOUND');
  });

  test('a chat is consulted before any file lookup: a transcript that happens to carry the same id is not read', async () => {
    const projectDir = path.join(projectsDir, '-Users-test-project');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, `${CODEX_SESSION}.jsonl`),
      JSON.stringify({
        type: 'user',
        uuid: 'from-a-file',
        sessionId: CODEX_SESSION,
        cwd: '/Users/test/project',
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: 'from a Claude file' },
      }),
    );
    const chat: HarnessChat = {
      readHistory: async (emit) => {
        emit(entry(CODEX_SESSION, 'from-the-chat', 'from the chat'));
        return 1;
      },
    };

    make(() => chat).onTranscriptLoadRequest(CID, CODEX_SESSION, REQ);
    await waitFor(() => types().includes('transcript_load_complete'), 'the load to complete');

    const entries = sendCalls
      .filter((c) => c.message.type === 'transcript_content')
      .map((c) => (c.message as TranscriptContentMessage).entryUuid);
    expect(entries).toEqual(['from-the-chat']);
  });

  test('a history that cannot be read is a LOAD_FAILED error, and the load is not reported complete', async () => {
    const chat: HarnessChat = {
      readHistory: async (emit) => {
        emit(entry(CODEX_SESSION, 'e1', 'partial'));
        throw new Error('the app-server went away');
      },
    };

    make(() => chat).onTranscriptLoadRequest(CID, CODEX_SESSION, REQ);
    await waitFor(() => types().includes('error'), 'the error');

    const failure = sendCalls.find((c) => c.message.type === 'error')?.message as {
      code: string;
      message: string;
    };
    expect(failure.code).toBe('LOAD_FAILED');
    expect(failure.message).toContain('the app-server went away');
    expect(types()).not.toContain('transcript_load_complete');
    // What was sent before the failure was sent.
    expect(types()[0]).toBe('transcript_content');
  });

  test('a chat whose read throws before it returns a promise is the same error, not a throw out of the handler', async () => {
    const chat: HarnessChat = {
      readHistory: () => {
        throw new Error('broken synchronously');
      },
    };

    expect(() => make(() => chat).onTranscriptLoadRequest(CID, CODEX_SESSION, REQ)).not.toThrow();
    await waitFor(() => types().includes('error'), 'the error');

    expect((sendCalls[0]?.message as { code: string }).code).toBe('LOAD_FAILED');
  });
});

describe('cli.ts gives the transcript handler the sessions’ chats (source pin)', () => {
  const CLI = stripComments(
    fs.readFileSync(path.join(import.meta.dir, '..', '..', '..', 'src', 'cli.ts'), 'utf8'),
  );

  test('chatFor reads the chat of the harness session of the requested remi session id', () => {
    const start = CLI.indexOf('createTranscriptHandlers({');
    expect(start).toBeGreaterThanOrEqual(0);
    const call = CLI.slice(start, CLI.indexOf('\n});', start));
    expect(call).toContain('chatFor: (sessionId) => harnessSessions.get(sessionId)?.chat,');
  });
});
