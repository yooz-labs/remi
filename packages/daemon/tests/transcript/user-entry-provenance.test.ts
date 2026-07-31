/**
 * Tests for #936: daemon-side provenance filtering of "user"-role transcript
 * entries Claude Code injected rather than the human actually typing.
 *
 * Two call sites are covered:
 *  - TranscriptMessageBridge.handleUserEntry — the chat-bubble path.
 *  - TranscriptDiscovery's session-list preview extraction.
 *
 * Both must:
 *  - Drop entries carrying `isMeta: true` (e.g. a subagent's own
 *    `<agent-message from="...">` report).
 *  - Drop the residual non-`isMeta` wrapper cohort (`<command-name>`,
 *    `<local-command-stdout>`, ...) via the SAME `isWrappedNonHumanText`
 *    denylist `auto-approve/authority.ts` uses, imported rather than
 *    reimplemented.
 *  - NEVER drop a genuine, unflagged human prompt. That regression (losing
 *    the user's own message with no signal) is worse than the bug being
 *    fixed here, so it gets equal test weight.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateId } from '@remi/shared';
import type { TranscriptContentMessage } from '@remi/shared';
import { MessageAPI } from '../../src/api/message-api.ts';
import { TranscriptDiscovery } from '../../src/transcript/transcript-discovery.ts';
import { TranscriptMessageBridge } from '../../src/transcript/transcript-message-bridge.ts';
import type { UserEntry } from '../../src/transcript/types.ts';

function createBridge() {
  const sid = generateId();
  const messageApi = new MessageAPI({ sessionId: sid });
  const transcriptMessages: TranscriptContentMessage[] = [];

  const bridge = new TranscriptMessageBridge({ sessionId: sid }, messageApi, {
    onTranscriptContent: (msg) => transcriptMessages.push(msg),
  });

  return { bridge, transcriptMessages };
}

function makeUserEntry(overrides?: Partial<UserEntry>): UserEntry {
  return {
    uuid: overrides?.uuid ?? generateId(),
    parentUuid: null,
    sessionId: 'test-session',
    timestamp: new Date().toISOString(),
    type: 'user',
    message: {
      role: 'user',
      content: overrides?.message?.content ?? 'Hello from user',
    },
    ...overrides,
  };
}

const AGENT_MESSAGE_CONTENT =
  'Another Claude session sent a message:\n<agent-message from="builder-534"> PR #727 is open and ready for review.';

describe('TranscriptMessageBridge.handleUserEntry provenance filtering (#936)', () => {
  test('an isMeta: true agent-message entry does not render as a user message', () => {
    const { bridge, transcriptMessages } = createBridge();
    const entry = makeUserEntry({
      isMeta: true,
      message: { role: 'user', content: AGENT_MESSAGE_CONTENT },
    });

    bridge.handleUserEntry(entry);

    expect(transcriptMessages.length).toBe(0);
    expect(bridge.processedCount).toBe(1); // still marked processed, not re-evaluated
  });

  test('a genuinely typed prompt (no isMeta) still renders normally', () => {
    const { bridge, transcriptMessages } = createBridge();
    const entry = makeUserEntry({
      message: { role: 'user', content: 'please fix the login bug' },
    });

    bridge.handleUserEntry(entry);

    expect(transcriptMessages.length).toBe(1);
    expect(transcriptMessages[0]?.role).toBe('user');
    expect(transcriptMessages[0]?.content).toBe('please fix the login bug');
  });

  test('a genuinely typed prompt with isMeta explicitly false still renders', () => {
    const { bridge, transcriptMessages } = createBridge();
    const entry = makeUserEntry({
      isMeta: false,
      message: { role: 'user', content: 'what does this function do?' },
    });

    bridge.handleUserEntry(entry);

    expect(transcriptMessages.length).toBe(1);
    expect(transcriptMessages[0]?.content).toBe('what does this function do?');
  });

  test('a <local-command-caveat> entry (isMeta: true in real samples) is handled', () => {
    const { bridge, transcriptMessages } = createBridge();
    const entry = makeUserEntry({
      isMeta: true,
      message: {
        role: 'user',
        content:
          '<local-command-caveat>Caveat: this output is not visible to the user</local-command-caveat>',
      },
    });

    bridge.handleUserEntry(entry);

    expect(transcriptMessages.length).toBe(0);
  });

  test('a <command-name> entry (never carries isMeta) is handled via the residual denylist', () => {
    const { bridge, transcriptMessages } = createBridge();
    const entry = makeUserEntry({
      message: { role: 'user', content: '<command-name>/review-pr</command-name>' },
    });

    bridge.handleUserEntry(entry);

    expect(transcriptMessages.length).toBe(0);
  });

  test('a <local-command-stdout> entry (never carries isMeta) is handled via the residual denylist', () => {
    const { bridge, transcriptMessages } = createBridge();
    const entry = makeUserEntry({
      message: { role: 'user', content: '<local-command-stdout>Goodbye!</local-command-stdout>' },
    });

    bridge.handleUserEntry(entry);

    expect(transcriptMessages.length).toBe(0);
  });

  test('isMeta is checked before content shape, so an isMeta array-content entry is also dropped', () => {
    const { bridge, transcriptMessages } = createBridge();
    const entry = makeUserEntry({
      isMeta: true,
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'scheduled task prompt' }],
      },
    });

    bridge.handleUserEntry(entry);

    expect(transcriptMessages.length).toBe(0);
  });
});

describe('TranscriptDiscovery session preview provenance filtering (#936)', () => {
  const TEMP_DIR = path.join(os.tmpdir(), 'remi-test-discovery-provenance');

  function makeProjectDir(): string {
    const dir = path.join(TEMP_DIR, '-Users-test-project');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function writeTranscript(dir: string, sessionId: string, entries: object[]): string {
    const filePath = path.join(dir, `${sessionId}.jsonl`);
    const content = `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`;
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  function jsonlUserEntry(content: string, isMeta?: boolean): object {
    return {
      type: 'user',
      uuid: crypto.randomUUID(),
      parentUuid: null,
      sessionId: 'test',
      timestamp: new Date().toISOString(),
      ...(isMeta !== undefined && { isMeta }),
      message: { role: 'user', content },
    };
  }

  function jsonlAssistantEntry(text: string): object {
    return {
      type: 'assistant',
      uuid: crypto.randomUUID(),
      parentUuid: null,
      sessionId: 'test',
      timestamp: new Date().toISOString(),
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    };
  }

  beforeEach(() => {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  });

  test('does not surface an isMeta agent-message entry as the last-message preview', () => {
    const projectDir = makeProjectDir();
    writeTranscript(projectDir, 'dead-team-session', [
      jsonlAssistantEntry('starting the review'),
      jsonlUserEntry(AGENT_MESSAGE_CONTENT, true),
    ]);

    const discovery = new TranscriptDiscovery({ projectsDir: TEMP_DIR });
    const sessions = discovery.discoverSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.lastMessage).not.toContain('agent-message');
    expect(sessions[0]?.lastMessage).not.toContain('Another Claude session sent a message');
    // Falls back to the last non-meta entry instead of surfacing nothing useful.
    expect(sessions[0]?.lastMessage).toBe('starting the review');
  });

  test('a genuinely typed final prompt still becomes the preview', () => {
    const projectDir = makeProjectDir();
    writeTranscript(projectDir, 'live-session', [
      jsonlAssistantEntry('done with the first task'),
      jsonlUserEntry('now fix the second bug please'),
    ]);

    const discovery = new TranscriptDiscovery({ projectsDir: TEMP_DIR });
    const sessions = discovery.discoverSessions();

    expect(sessions[0]?.lastMessage).toBe('now fix the second bug please');
  });

  test('an isMeta scheduled-task entry with no wrapper markup does not surface as the preview', () => {
    // Isolates the isMeta guard from the residual isWrappedNonHumanText
    // denylist: unlike the agent-message/command-name cases above, this
    // content carries no recognizable wrapper prefix at all, so only the
    // isMeta check can catch it.
    const projectDir = makeProjectDir();
    writeTranscript(projectDir, 'scheduled-task-session', [
      jsonlAssistantEntry('acknowledged, standing by'),
      jsonlUserEntry('Check on the deploy status and report back', true),
    ]);

    const discovery = new TranscriptDiscovery({ projectsDir: TEMP_DIR });
    const sessions = discovery.discoverSessions();

    expect(sessions[0]?.lastMessage).toBe('acknowledged, standing by');
  });

  test('a <command-name> final entry (no isMeta) does not surface as the preview', () => {
    const projectDir = makeProjectDir();
    writeTranscript(projectDir, 'slash-command-session', [
      jsonlAssistantEntry('sure, running it now'),
      jsonlUserEntry('<command-name>/review-pr</command-name>'),
    ]);

    const discovery = new TranscriptDiscovery({ projectsDir: TEMP_DIR });
    const sessions = discovery.discoverSessions();

    expect(sessions[0]?.lastMessage).toBe('sure, running it now');
  });
});
