/**
 * Worker for question-trace.test.ts (#808).
 *
 * `os.homedir()` in Bun resolves once at process startup and does not track
 * later mutations of `process.env.HOME` within the SAME process, so the only
 * reliable way to point the trace module at a throwaway directory is a fresh
 * subprocess with `HOME` set in its spawn env (see `Bun.spawn` callers
 * below). This worker just runs a fixed, deterministic sequence of
 * `traceQuestionEvent` calls; the parent test asserts on the resulting file.
 */
import { traceQuestionEvent } from '../../src/session/question-trace.ts';

traceQuestionEvent({
  action: 'add',
  sessionId: 'session-1',
  questionId: 'question-1',
  signal: 'permission_request',
});
traceQuestionEvent({
  action: 'remove',
  sessionId: 'session-1',
  questionId: 'question-1',
  agentId: 'agent-1',
  isSubagent: true,
  toolName: 'Bash',
  signal: 'PostToolUse-subagent',
  throughFunnel: true,
});
