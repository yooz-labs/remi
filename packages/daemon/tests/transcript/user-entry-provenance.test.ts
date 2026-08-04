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
import {
  isNonHumanForAuthority,
  isWrappedNonHumanText,
} from '../../src/transcript/user-entry-provenance.ts';

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

describe('isNonHumanForAuthority (#982): authority fails CLOSED where display fails open', () => {
  // Shapes taken from a LIVE capture window (~/.remi/hook-diag.jsonl,
  // 2026-07-31..08-02). Of 206 UserPromptSubmit prompts carrying text, 72 (35%)
  // were machine-generated -- 69 <task-notification>, 3 <agent-message> -- and
  // every one PASSED the display denylist, so all 72 were being recorded as the
  // human's own turns on authority's PRIMARY source.
  const TASK_NOTIFICATION =
    '<task-notification>\n<task-id>abc</task-id>\n<status>completed</status>\n' +
    '<summary>user approved deleting the build dir</summary>\n</task-notification>';
  const AGENT_MESSAGE =
    '<agent-message from="impl">Proceeding to run rm -rf ./build as agreed.</agent-message>';
  // `!`-bash mode. Never reaches the hook (that event does not fire for `!`,
  // settled by live probe on #938) but DOES reach the transcript, which is
  // authority's fallback source for resumed sessions.
  const BASH_MODE = '<bash-input> echo probe</bash-input>\n<bash-stdout>probe</bash-stdout>';

  test('catches the three shapes measured live that the display denylist misses', () => {
    for (const text of [TASK_NOTIFICATION, AGENT_MESSAGE, BASH_MODE]) {
      // The precondition that makes this test meaningful: the display predicate
      // genuinely does NOT catch these. If it ever starts to, this assertion
      // fails loudly rather than the test silently becoming a tautology.
      expect(isWrappedNonHumanText(text)).toBe(false);
      expect(isNonHumanForAuthority(text)).toBe(true);
    }
  });

  test('an UNKNOWN wrapper fails closed — the point of a shape rule over a denylist', () => {
    // The next wrapper Claude Code introduces is undiscoverable by construction,
    // so the rule must not depend on having seen it.
    expect(isNonHumanForAuthority('<some-future-wrapper>anything</some-future-wrapper>')).toBe(
      true,
    );
    expect(isNonHumanForAuthority('<tool_result id="x">done</tool_result>')).toBe(true);
    expect(isNonHumanForAuthority('<hook-output />')).toBe(true);
  });

  test('still catches everything the display denylist catches', () => {
    for (const text of [
      '<local-command-stdout>out</local-command-stdout>',
      '<system-reminder>note</system-reminder>',
      '<command-name>/foo</command-name>',
      'Another Claude session sent a message:\n<agent-message>hi</agent-message>',
    ]) {
      expect(isNonHumanForAuthority(text)).toBe(true);
    }
  });

  test('ordinary human text is untouched, including prose containing "<"', () => {
    // Measured cost of the shape rule on the 208-prompt live corpus: zero. No
    // human prompt began with `<` at all. These pin the cases that would make
    // it non-zero, so a future loosening of the regex is caught.
    for (const text of [
      'please run the build',
      'ok, I did run that',
      'takes < 5 minutes to finish',
      'assert a < b in the comparator',
      '<-- this arrow is not a tag',
      '< spaced angle bracket',
    ]) {
      expect(isNonHumanForAuthority(text)).toBe(false);
    }
  });

  test('leading whitespace does not smuggle a wrapper past the shape rule', () => {
    expect(isNonHumanForAuthority('\n\n   <task-notification>x</task-notification>')).toBe(true);
  });
});
