import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateId } from '@remi/shared';
import type { ProtocolMessage, Question } from '@remi/shared';
import { MessageAPI } from '../../src/api/message-api.ts';
import { QuestionPresenceTracker } from '../../src/api/question-presence-tracker.ts';
import { createInputHandlers, trackerScreenDeps } from '../../src/cli/handlers/input-events.ts';
import { parseQuestion } from '../../src/parser/question-parser.ts';
import { PTYSession } from '../../src/pty/pty-session.ts';
import { SessionBindingStore } from '../../src/session/session-binding-store.ts';
import { SessionRegistry } from '../../src/session/session-registry.ts';
import { SessionStore } from '../../src/session/session-store.ts';
import { WRAPPED_DIRECTORY_DIALOG } from '../parser/fixtures/claude-dialogs.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Owned PTY did not reach the expected boundary');
    await Bun.sleep(10);
  }
}

async function pipeline(submitDelay?: () => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'remi-stale-cancel-'));
  const registry = new SessionRegistry();
  const sid = generateId();
  const cid = generateId();
  let output = '';
  // Real local terminal, no Claude/Codex process or provider request. Its
  // output acknowledges each byte actually written after the serial queue.
  const pty = new PTYSession(
    {
      command: '/bin/sh',
      args: ['-c', 'stty raw -echo; printf __ready__; exec /bin/cat'],
      cwd: home,
    },
    {
      onData: (data) => {
        output += data;
      },
    },
    submitDelay ? { submitDelay } : {},
  );
  const resolutions: string[] = [];
  const frames: ProtocolMessage[] = [];
  const api = new MessageAPI(
    { sessionId: sid, initialBulletId: 1 },
    {
      onQuestion: (q) => registry.addQuestion(sid, q, q.source ?? 'unknown'),
    },
  );
  registry.registerSession(sid, home, pty, api);
  const tracker = new QuestionPresenceTracker((q, opts) => api.handleQuestion(q, opts), {
    onHooklessQuestionGone: (id) =>
      registry.removeQuestion(sid, id as Question['id'], 'pty_render_superseded'),
  });
  const handlers = createInputHandlers({
    sessionRegistry: registry,
    bindingStore: new SessionBindingStore(new SessionStore(join(home, 'sessions.json'))),
    ...trackerScreenDeps(() => tracker),
    send: (_id, frame) => {
      frames.push(frame);
      return true;
    },
    onQuestionResolved: (_sid, qid) => {
      resolutions.push(qid);
    },
  });
  cleanups.push(async () => {
    await registry.shutdown();
    rmSync(home, { recursive: true, force: true });
  });
  pty.start();
  await until(() => output.includes('__ready__'));
  output = '';
  const parsed = parseQuestion(WRAPPED_DIRECTORY_DIALOG);
  if (!parsed.question) throw new Error('Captured Claude dialog did not parse');
  const question = parsed.question;
  tracker.onPTYPromptVisible(question);
  expect(registry.getQuestion(sid, question.id)).not.toBeNull();
  const cancel = () => handlers.onAnswer(cid, sid, question.id, '', undefined, { cancel: true });
  const drain = async () => {
    await pty.write('__boundary__');
    await until(() => output.includes('__boundary__'));
    return output;
  };
  return { registry, sid, tracker, pty, question, cancel, drain, resolutions, frames };
}

test('a still-visible captured Claude prompt takes one Cancel Esc', async () => {
  const p = await pipeline();
  await p.cancel();
  expect((await p.drain()).match(/\x1b/g)?.length).toBe(1);
  expect(p.registry.getQuestion(p.sid, p.question.id)).toBeNull();
  expect(p.resolutions).toEqual([p.question.id]);
});

test('a stale registered card after terminal progress clears without any Esc', async () => {
  const p = await pipeline();
  p.tracker.onStatusChange('executing');
  expect(p.registry.getQuestion(p.sid, p.question.id)).not.toBeNull();
  await p.cancel();
  expect(await p.drain()).not.toContain('\x1b');
  expect(p.registry.getQuestion(p.sid, p.question.id)).toBeNull();
  expect(p.resolutions).toEqual([p.question.id]);
});

test('Cancel rechecks prompt currency after an earlier queued write settles', async () => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const p = await pipeline(() => held);
  const earlier = p.pty.submitInput('earlier');
  await Bun.sleep(20);
  const cancelling = p.cancel();
  p.tracker.onStatusChange('executing');
  release();
  await earlier;
  await cancelling;
  expect(await p.drain()).not.toContain('\x1b');
});

test('a different captured prompt cannot authorize the stale card Cancel', async () => {
  const p = await pipeline();
  const other = parseQuestion(
    readFileSync(
      join(import.meta.dir, '../parser/fixtures/prompt-selection-box.clean.txt'),
      'utf8',
    ),
  ).question;
  if (!other) throw new Error('Captured trust dialog did not parse');
  expect(other.text).not.toBe(p.question.text);
  p.tracker.onPTYPromptVisible(other);
  // Recreate the reported stale-registry state using the real registry.
  p.registry.addQuestion(p.sid, p.question, 'pty');
  await p.cancel();
  expect(await p.drain()).not.toContain('\x1b');
  expect(p.registry.getQuestion(p.sid, other.id)).not.toBeNull();
});

test('a formerly held card never regains Esc authority after its hold is forgotten', async () => {
  const p = await pipeline();
  p.registry.addQuestion(p.sid, { ...p.question, held: true }, 'permission_request');
  await p.cancel();
  expect(await p.drain()).not.toContain('\x1b');
});

test('owning turn completion removes the render card; another agent and status guesses do not', async () => {
  const p = await pipeline();
  p.tracker.onAgentTurnEnded('another-agent');
  expect(p.registry.getQuestion(p.sid, p.question.id)).not.toBeNull();
  p.tracker.onStatusChange('thinking');
  expect(p.registry.getQuestion(p.sid, p.question.id)).not.toBeNull();
  p.tracker.onAgentTurnEnded();
  expect(p.registry.getQuestion(p.sid, p.question.id)).toBeNull();
  await p.cancel();
  expect(await p.drain()).not.toContain('\x1b');
});
