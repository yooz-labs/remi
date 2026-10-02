/**
 * Worker for chat-into-menu.test.ts (#1140).
 *
 * `os.homedir()` resolves once at process start, so the trace file can only be
 * pointed at a throwaway directory by spawning a fresh process with `HOME`
 * set (see `question-trace-worker.ts`). This worker drives the real handlers
 * against a real tracker that observed the real captured Claude dialog, sends
 * one chat message into the menu, and exits non-zero unless the message was
 * refused (nothing typed, one PROMPT_WAITING error), so the parent's "tracing
 * off" case also proves the refusal does not depend on the trace.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProtocolMessage, UUID } from '@remi/shared';
import { generateId } from '@remi/shared';
import { QuestionPresenceTracker } from '../../../src/api/question-presence-tracker.ts';
import { createInputHandlers, trackerScreenDeps } from '../../../src/cli/handlers/input-events.ts';
import { configureLogger } from '../../../src/cli/logger.ts';
import type { PTYSession } from '../../../src/pty/pty-session.ts';
import { SessionBindingStore } from '../../../src/session/session-binding-store.ts';
import { SessionRegistry } from '../../../src/session/session-registry.ts';
import { SessionStore } from '../../../src/session/session-store.ts';
import { claudeMenu } from './menu-test-helpers.ts';

configureLogger({ writeLog: () => {} });

const submits: string[] = [];
const pty = {
  id: generateId(),
  write: () => {},
  submitInput: async (content: string) => {
    submits.push(content);
  },
  close: async () => {},
} as unknown as PTYSession;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-chat-trace-worker-'));
const registry = new SessionRegistry({ orphanTimeoutMs: 1000 });
const bindingStore = new SessionBindingStore(new SessionStore(path.join(tmpDir, 'sessions.json')));
const sessionId = registry.createSessionId();
const connectionId = generateId() as UUID;
registry.registerSession(sessionId, '/test/dir', pty, {
  getFullBulletContent: () => null,
} as never);
registry.attachConnection(sessionId, connectionId);

const sent: ProtocolMessage[] = [];
const tracker = new QuestionPresenceTracker((q) => {
  registry.addQuestion(sessionId, q);
  return undefined;
});
tracker.onPTYPromptVisible(claudeMenu());

const handlers = createInputHandlers({
  sessionRegistry: registry,
  bindingStore,
  send: (_id, message) => {
    sent.push(message);
    return true;
  },
  ...trackerScreenDeps((sid) => (sid === sessionId ? tracker : undefined)),
});
await handlers.onUserInput(connectionId, sessionId, 'a secret message', false);

const errors = sent.filter((m) => m.type === 'error');
const refused = submits.length === 0 && errors.length === 1;
await registry.shutdown();
fs.rmSync(tmpDir, { recursive: true, force: true });
process.exit(refused ? 0 : 1);
