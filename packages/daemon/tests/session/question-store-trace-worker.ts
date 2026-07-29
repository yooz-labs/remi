/**
 * Worker for question-store-trace.test.ts (#888).
 *
 * Mirrors `question-trace-worker.ts` (#808) and
 * `question-trace-identity-worker.ts` (#887)'s fresh-subprocess HOME
 * pattern, but drives the REAL `SessionRegistry` (not `traceQuestionEvent`
 * directly) through add / re-add-triggers-eviction / remove / clear, to pin
 * that the #888 QuestionStore extraction produced BYTE-FOR-BYTE the same
 * trace `callSite` defaults SessionRegistry's own callers relied on before
 * this file existed: 'SessionRegistry.addQuestion',
 * 'SessionRegistry.addQuestion:lru_eviction', 'SessionRegistry.removeQuestion',
 * 'SessionRegistry.clearQuestions'.
 */
import { generateId } from '@remi/shared';
import type { MessageAPI } from '../../src/api/message-api.ts';
import type { PTYSession } from '../../src/pty/pty-session.ts';
import { SessionRegistry } from '../../src/session/session-registry.ts';

const registry = new SessionRegistry();
const sid = generateId();
registry.registerSession(
  sid,
  '/tmp/worker',
  { id: generateId(), close: () => Promise.resolve() } as unknown as PTYSession,
  { bulletCount: 0 } as unknown as MessageAPI,
);

// Fill to the MAX_PENDING_QUESTIONS cap (8) then add a 9th to force an
// eviction trace record.
const ids: string[] = [];
for (let i = 0; i < 9; i++) {
  const id = generateId();
  ids.push(id);
  registry.addQuestion(sid, {
    id,
    text: `${id}?`,
    options: [],
    allowsFreeText: true,
    isAnswered: false,
  });
}

// biome-ignore lint/style/noNonNullAssertion: fixed-length loop above
registry.removeQuestion(sid, ids[8]!);
registry.clearQuestions(sid);
