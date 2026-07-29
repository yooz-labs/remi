/**
 * Deterministic builders for the golden protocol fixtures (#895).
 *
 * One builder per {@link ProtocolMessageMap} key, each calling that type's
 * own `create*` factory (not a hand-built object literal) so the fixture
 * reflects the real wire shape the factory produces. All non-envelope
 * arguments are fixed literals so builders are reproducible; the envelope
 * `id`/`timestamp` (and, for `session_update`, the nested `session.startedAt`
 * — see `EXTRA_VOLATILE_PATHS`) are the only fields that legitimately differ
 * between calls and must be normalized out before comparison.
 *
 * Used by:
 * - `packages/shared/tests/protocol-fixtures.test.ts` (round-trip + drift
 *   detection against the checked-in JSON fixtures)
 * - `packages/shared/tests/fixtures/protocol/generate.ts` (regenerates the
 *   checked-in JSON fixtures from these same builders)
 */

import {
  createAck,
  createAgentOutput,
  createAnswer,
  createAuthChallenge,
  createAuthResponse,
  createAuthResult,
  createBulletExpandRequest,
  createBulletExpandResponse,
  createCreateSessionRequest,
  createCreateSessionResponse,
  createDaemonUpdateAvailable,
  createDetachSession,
  createDetachSessionAck,
  createEdit,
  createError,
  createHello,
  createHelloAck,
  createHubStatus,
  createKillSessionRequest,
  createKillSessionResponse,
  createPing,
  createPong,
  createQuestion,
  createQuestionResolved,
  createQuestionSnapshot,
  createRawPtyOutput,
  createRegisterDeviceToken,
  createRemiStatus,
  createReplayBatch,
  createResumeSessionRequest,
  createResumeSessionResponse,
  createSessionHistoryRequest,
  createSessionHistoryResponse,
  createSessionListRequest,
  createSessionListResponse,
  createSessionRotated,
  createSessionUpdate,
  createSessionViews,
  createStructuredAgentOutput,
  createTerminalResize,
  createTranscriptContent,
  createTranscriptLoadComplete,
  createTranscriptLoadRequest,
  createUnregisterDeviceToken,
  createUserInput,
} from '../../../src/protocol.ts';
import type {
  HubPendingQuestion,
  ProtocolMessageMap,
  RecentDirectory,
  SessionViewMeta,
  TranscriptContentBlock,
} from '../../../src/protocol.ts';
import type {
  Acknowledgment,
  Bullet,
  DiscoverableSession,
  Message,
  Question,
  QuestionOption,
  RemiStatus,
  StructuredMessage,
} from '../../../src/types.ts';

// Fixed IDs shared across builders so fixtures read coherently (all
// referencing "the same" fixture session/question where that matters).
const SESSION_ID = 'fixture-session-id';
const CLIENT_ID = 'fixture-client-id';
const CLAUDE_SESSION_ID = 'fixture-claude-session-id';
const QUESTION_ID = 'fixture-question-id';
const MESSAGE_ID = 'fixture-message-id';
const REQUEST_ID = 'fixture-request-id';
const FIXED_TIME = '2026-01-01T00:00:00.000Z';

const FIXED_MESSAGE: Message = {
  id: MESSAGE_ID,
  sessionId: SESSION_ID,
  sender: 'agent',
  content: 'Fixture message content',
  createdAt: FIXED_TIME,
  state: 'delivered',
  stateChangedAt: FIXED_TIME,
  isEditing: false,
  tool: 'Bash',
};

const FIXED_BULLET: Bullet = {
  bulletId: 1,
  content: 'A fixture bullet',
  type: 'dash',
  startLine: 0,
  endLine: 0,
  hasCodeBlock: false,
};

const FIXED_STRUCTURED_MESSAGE: StructuredMessage = {
  ...FIXED_MESSAGE,
  bullets: [FIXED_BULLET],
  firstBulletId: 1,
  lastBulletId: 1,
};

const FIXED_QUESTION_OPTION: QuestionOption = {
  label: 'Yes',
  value: 'yes',
  isRecommended: true,
  isYes: true,
  isNo: false,
};

const FIXED_QUESTION: Question = {
  id: QUESTION_ID,
  text: 'Allow Bash: ls?',
  options: [FIXED_QUESTION_OPTION],
  allowsFreeText: false,
  isAnswered: false,
};

const FIXED_ACK: Acknowledgment = {
  messageId: MESSAGE_ID,
  state: 'delivered',
  timestamp: FIXED_TIME,
};

const FIXED_DISCOVERABLE_SESSION: DiscoverableSession = {
  sessionId: SESSION_ID,
  name: 'fixture-host/fixture-project/main',
  projectPath: '/Users/fixture/project',
  status: 'active',
  createdAt: FIXED_TIME,
  lastActivity: FIXED_TIME,
  messageCount: 3,
  model: 'yooz-quality',
  lastMessage: 'Last message preview',
  source: 'daemon',
  canAttach: true,
  canResume: false,
  claudeSessionId: CLAUDE_SESSION_ID,
  transcriptPath: '/Users/fixture/transcript.jsonl',
  wsPort: 19924,
  daemonHost: 'fixture-host',
};

const FIXED_REMI_STATUS: RemiStatus = {
  pid: 1234,
  connections: 1,
  sessionStatus: 'idle',
  adapters: ['websocket'],
  wsPort: 19924,
  sessionId: SESSION_ID,
  repo: 'remi',
  branch: 'develop',
  autoApprove: {
    inFlight: 0,
    sinceS: 0,
    lastVerdict: 'none',
    lastVerdictAtS: 0,
  },
  attached: true,
  queuedCount: 0,
  mode: 'session',
  version: '0.7.4-dev.1',
};

const FIXED_RECENT_DIRECTORY: RecentDirectory = {
  directory: '/Users/fixture/project',
  lastUsed: FIXED_TIME,
  sessionCount: 2,
  displayName: 'project',
};

const FIXED_SESSION_VIEW: SessionViewMeta = {
  agentId: 'fixture-agent-id',
  agentType: 'general-purpose',
  active: true,
};

const FIXED_HUB_PENDING_QUESTION: HubPendingQuestion = {
  id: QUESTION_ID,
  sessionId: SESSION_ID,
  sessionName: 'fixture-session',
  label: 'Permission: Bash',
  createdAt: FIXED_TIME,
};

const FIXED_TRANSCRIPT_BLOCK: TranscriptContentBlock = {
  type: 'text',
  text: 'Fixture transcript text',
};

/**
 * One builder per registry key, calling that type's own factory with fixed
 * arguments. Typed against {@link ProtocolMessageMap} so adding a registry
 * key without adding a builder here is a compile error (mirrors the
 * `MessageHandlers` totality property from #896).
 */
export const FIXTURE_BUILDERS: { [K in keyof ProtocolMessageMap]: () => ProtocolMessageMap[K] } = {
  hello: () =>
    createHello(CLIENT_ID, '1.0.0', {
      directory: '/Users/fixture/project',
    }),
  hello_ack: () =>
    createHelloAck('1.0.0', SESSION_ID, {
      resumeInfo: { isResume: false, replayCount: 0, nextBulletId: 1 },
      binding: {
        claudeSessionId: CLAUDE_SESSION_ID,
        transcriptPath: '/Users/fixture/transcript.jsonl',
      },
      attachState: 'attached',
      daemonVersion: '0.7.4-dev.1',
    }),
  agent_output: () => createAgentOutput(FIXED_MESSAGE),
  structured_agent_output: () => createStructuredAgentOutput(FIXED_STRUCTURED_MESSAGE, false, [1]),
  user_input: () => createUserInput(SESSION_ID, 'echo hi', false, CLAUDE_SESSION_ID),
  ack: () => createAck(FIXED_ACK),
  edit: () => createEdit(MESSAGE_ID, 'Updated content', true, 'Edit'),
  question: () => createQuestion(FIXED_QUESTION, SESSION_ID, CLAUDE_SESSION_ID),
  answer: () => createAnswer(SESSION_ID, QUESTION_ID, 'yes', CLAUDE_SESSION_ID),
  session_update: () => createSessionUpdate(SESSION_ID, 'thinking'),
  ping: () => createPing(),
  pong: () => createPong('fixture-ping-id'),
  error: () => createError('FIXTURE_ERROR', 'Fixture error message', { detail: 'extra info' }),
  replay_batch: () => createReplayBatch(SESSION_ID, [], true),
  bullet_expand_request: () => createBulletExpandRequest(SESSION_ID, 1),
  bullet_expand_response: () =>
    createBulletExpandResponse(1, 'Full bullet content here', REQUEST_ID),
  session_list_request: () => createSessionListRequest(true),
  session_list_response: () =>
    createSessionListResponse([FIXED_DISCOVERABLE_SESSION], REQUEST_ID, [19924, 19925]),
  transcript_content: () =>
    createTranscriptContent(
      SESSION_ID,
      'fixture-entry-uuid',
      'assistant',
      'Fixture transcript content',
      FIXED_STRUCTURED_MESSAGE,
      false,
      {
        tools: ['Bash'],
        model: 'yooz-quality',
        hadThinking: true,
        usage: { input_tokens: 10, output_tokens: 20 },
        contentBlocks: [FIXED_TRANSCRIPT_BLOCK],
      },
    ),
  transcript_load_request: () => createTranscriptLoadRequest(SESSION_ID),
  transcript_load_complete: () => createTranscriptLoadComplete(SESSION_ID, 5, REQUEST_ID),
  create_session_request: () => createCreateSessionRequest('/Users/fixture/project'),
  create_session_response: () =>
    createCreateSessionResponse(true, REQUEST_ID, SESSION_ID, undefined, 19924),
  terminal_resize: () => createTerminalResize(120, 40),
  auth_challenge: () =>
    createAuthChallenge(
      'base64-challenge',
      'AA:BB:CC:DD',
      'base64-server-pubkey',
      {
        ephemeralKey: 'base64-ephemeral-key',
        signature: 'base64-kex-signature',
      },
      'base64-answer-encryption-key',
    ),
  auth_response: () =>
    createAuthResponse('base64-client-pubkey', 'base64-signature', 'EE:FF:00:11', {
      ephemeralKey: 'base64-client-ephemeral-key',
      signature: 'base64-client-kex-signature',
    }),
  auth_result: () => createAuthResult(true, 'base64-server-signature'),
  kill_session_request: () => createKillSessionRequest(SESSION_ID),
  kill_session_response: () => createKillSessionResponse(true, REQUEST_ID),
  raw_pty_output: () => createRawPtyOutput('base64-pty-bytes', SESSION_ID),
  session_history_request: () => createSessionHistoryRequest(10),
  session_history_response: () =>
    createSessionHistoryResponse([FIXED_RECENT_DIRECTORY], REQUEST_ID),
  resume_session_request: () => createResumeSessionRequest(SESSION_ID),
  resume_session_response: () => createResumeSessionResponse(true, REQUEST_ID, SESSION_ID),
  detach_session: () => createDetachSession(SESSION_ID),
  detach_session_ack: () => createDetachSessionAck(SESSION_ID, true),
  register_device_token: () => createRegisterDeviceToken('fixture-device-token', 'ios'),
  unregister_device_token: () => createUnregisterDeviceToken('fixture-device-token'),
  daemon_update_available: () =>
    createDaemonUpdateAvailable('0.7.4-dev.1', '/opt/homebrew/bin/remi'),
  hub_status: () =>
    createHubStatus({
      localClients: 1,
      remoteClients: 0,
      sessions: 2,
      hubVersion: '0.7.4-dev.1',
      pendingQuestions: 1,
      questions: [FIXED_HUB_PENDING_QUESTION],
      autostart: 'installed',
    }),
  session_rotated: () =>
    createSessionRotated(
      SESSION_ID,
      CLAUDE_SESSION_ID,
      '/Users/fixture/transcript.jsonl',
      'resume',
      'fixture-old-claude-session-id',
    ),
  session_views: () => createSessionViews(SESSION_ID, [FIXED_SESSION_VIEW]),
  question_resolved: () => createQuestionResolved(SESSION_ID, QUESTION_ID, 'answered'),
  remi_status: () => createRemiStatus(SESSION_ID, FIXED_REMI_STATUS),
  question_snapshot: () => createQuestionSnapshot(SESSION_ID, [QUESTION_ID]),
};

/**
 * Dotted paths, per message type, to fields that are legitimately volatile
 * beyond the universal envelope `id`/`timestamp` (every message has those
 * two; see `generateId()`/`now()` call sites in `protocol.ts`). Only
 * `session_update` has one: `createSessionUpdate` calls `now()` again for
 * the nested `session.startedAt` (protocol.ts, `createSessionUpdate`).
 */
const EXTRA_VOLATILE_PATHS: Partial<Record<keyof ProtocolMessageMap, readonly string[]>> = {
  session_update: ['session.startedAt'],
};

/** A plain JSON-shaped object, as produced by `JSON.parse`. */
type JsonRecord = Record<string, unknown>;

/** Returns a shallow copy of `obj` without `keys` (non-mutating). */
function omitKeys(obj: JsonRecord, keys: readonly string[]): JsonRecord {
  const drop = new Set(keys);
  return Object.fromEntries(Object.entries(obj).filter(([key]) => !drop.has(key)));
}

/** Returns a copy of `obj` with the dotted `path` removed (non-mutating). */
function omitPath(obj: JsonRecord, path: string): JsonRecord {
  const dot = path.indexOf('.');
  if (dot === -1) {
    return omitKeys(obj, [path]);
  }
  const head = path.slice(0, dot);
  const rest = path.slice(dot + 1);
  const child = obj[head];
  if (typeof child !== 'object' || child === null) {
    return obj;
  }
  return { ...obj, [head]: omitPath(child as JsonRecord, rest) };
}

/**
 * Strips the fields that are expected to differ between two otherwise
 * identical messages of `type` (the envelope `id`/`timestamp`, plus any
 * type-specific volatile field from {@link EXTRA_VOLATILE_PATHS}) so the
 * remainder can be compared for wire-shape drift.
 */
export function normalizeForComparison(
  type: keyof ProtocolMessageMap,
  obj: JsonRecord,
): JsonRecord {
  let result = omitKeys(obj, ['id', 'timestamp']);
  for (const path of EXTRA_VOLATILE_PATHS[type] ?? []) {
    result = omitPath(result, path);
  }
  return result;
}
