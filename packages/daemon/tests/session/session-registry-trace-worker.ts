/**
 * Worker for session-registry.test.ts's "question-lifecycle trace (#808)"
 * suite. Same rationale as question-trace-worker.ts: `os.homedir()` is
 * resolved once at process startup in Bun, so a fresh subprocess with `HOME`
 * set in its spawn env is the only reliable way to point the trace file at a
 * throwaway directory. This worker builds a REAL `SessionRegistry` (PTY and
 * MessageAPI are the two dependencies that would otherwise require spawning
 * a real OS process / real Claude session -- substituted here exactly as
 * `session-registry.test.ts`'s own `createMockPTY`/`createMockMessageAPI`
 * helpers do) and drives the exact add/remove/clear/evict sequence the
 * parent test asserts against.
 */
import { generateId } from '@remi/shared';
import type { MessageAPI } from '../../src/api/message-api.ts';
import type { PTYSession } from '../../src/pty/pty-session.ts';
import { SessionRegistry } from '../../src/session/session-registry.ts';

function fakePTY(): PTYSession {
  return { id: generateId(), close: () => Promise.resolve() } as unknown as PTYSession;
}

function fakeMessageAPI(): MessageAPI {
  return { bulletCount: 0 } as unknown as MessageAPI;
}

function mkQuestion(id: string, agentId?: string) {
  return {
    id,
    text: `${id}?`,
    options: [],
    allowsFreeText: true,
    isAnswered: false,
    ...(agentId !== undefined && { agentId }),
  };
}

const registry = new SessionRegistry();
const sid = generateId();
registry.registerSession(sid, '/test/dir', fakePTY(), fakeMessageAPI());

// 1. add (main) -- exercises the 'add' record + a default signal.
const q1 = generateId();
registry.addQuestion(sid, mkQuestion(q1));

// 2. add (subagent) with an explicit signal.
const q2 = generateId();
registry.addQuestion(sid, mkQuestion(q2, 'sub-2'), 'permission_request');

// 3. remove q1 with an explicit signal + toolName.
registry.removeQuestion(sid, q1, 'user_answer', 'Bash');

// 4. clearQuestions -- one 'remove' record for the remaining q2.
registry.clearQuestions(sid, 'session_restart');

// 5. LRU eviction: 9 adds against MAX_PENDING_QUESTIONS=8 evicts the oldest.
const evictionIds: string[] = [];
for (let i = 0; i < 9; i++) {
  const id = generateId();
  evictionIds.push(id);
  registry.addQuestion(sid, mkQuestion(id));
}

// Print the ids the parent test needs to key its assertions (generateId() is
// random, so they cannot be hardcoded).
console.log(JSON.stringify({ q1, q2, oldestEvicted: evictionIds[0] }));
