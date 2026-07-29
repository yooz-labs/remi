/**
 * Worker for question-trace-identity.test.ts (#887).
 *
 * Mirrors `question-trace-worker.ts` (#808) exactly (fresh-subprocess HOME
 * override, see that file's header comment) but exercises the two fields
 * #887 added to `QuestionTraceRecord`: `promptId` (the hook's turn-scoped
 * correlation key) and `callSite` (which internal function emitted the
 * record). Kept in its own worker/test pair rather than extending the #808
 * one, which must pass unmodified per #887's own constraints.
 */
import { traceQuestionEvent } from '../../src/session/question-trace.ts';

traceQuestionEvent({
  action: 'add',
  sessionId: 'session-1',
  questionId: 'question-1',
  promptId: 'turn-abc',
  signal: 'permission_request',
  callSite: 'SessionRegistry.addQuestion',
});
traceQuestionEvent({
  action: 'remove',
  sessionId: 'session-1',
  questionId: 'question-1',
  promptId: 'turn-abc',
  agentId: 'agent-1',
  isSubagent: true,
  toolName: 'Bash',
  signal: 'PostToolUse-subagent',
  callSite: 'AutoApproveGate.resolveSupersededQuestion',
  throughFunnel: true,
});
// A genuinely hook-less (PTY-only) question carries no promptId at all --
// the field must stay optional/absent, not coerced to null/empty-string.
traceQuestionEvent({
  action: 'add',
  sessionId: 'session-1',
  questionId: 'question-2',
  signal: 'tracker-push',
  callSite: 'SessionRegistry.addQuestion',
});
