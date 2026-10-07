/**
 * @remi/shared - Shared types and utilities for Remi
 *
 * This package contains:
 * - Core types (Message, Session, Question, etc.)
 * - Protocol messages and serialization
 * - Utility functions
 *
 * Used by both daemon and client packages.
 */

// Types
export type {
  UUID,
  Timestamp,
  MessageState,
  MessageSender,
  AgentStatus,
  AutoApproveState,
  RemiStatus,
  Message,
  BulletType,
  Bullet,
  StructuredMessage,
  Acknowledgment,
  Question,
  QuestionOption,
  QuestionSource,
  QuestionStep,
  Session,
  ConnectionInfo,
  Result,
  SessionSource,
  DiscoverableSessionStatus,
  DiscoverableSession,
  SessionGitWorkspace,
} from './types.ts';

export { ok, err, isOk, isErr, MAIN_AGENT_ID } from './types.ts';

// Permission/question defaults shared by daemon and client (#396)
export {
  DEFAULT_PERMISSION_LABELS,
  QUESTION_DEDUP_WINDOW_MS,
} from './permission-defaults.ts';

// Daemon loopback port range — single source of truth for daemon + client (#435)
export { DAEMON_BASE_PORT, DAEMON_PORT_RANGE } from './daemon-ports.ts';

// Harness identity and the cross-harness decision vocabulary (#1162, ADR 0032)
export type {
  HarnessId,
  SessionIdentity,
  AnswerPath,
  LocalRender,
  ResolvedBy,
  Decision,
} from './harness.ts';
export {
  HARNESS_IDS,
  DEFAULT_HARNESS,
  isHarnessId,
  identityFromClaudeId,
} from './harness.ts';

// Protocol
export type {
  ProtocolMessage,
  ProtocolMessageMap,
  MessageOf,
  ClientToDaemonType,
  HelloMessage,
  HelloAckMessage,
  AgentOutputMessage,
  StructuredAgentOutputMessage,
  UserInputMessage,
  AckMessage,
  EditMessage,
  QuestionMessage,
  AnswerMessage,
  AnswerSelection,
  AnswerExtras,
  SessionUpdateMessage,
  PingMessage,
  PongMessage,
  ErrorMessage,
  StaleSessionErrorDetails,
  PromptWaitingErrorDetails,
  InputNotDeliveredErrorDetails,
  ReplayBatchMessage,
  BulletExpandRequestMessage,
  BulletExpandResponseMessage,
  SessionListRequestMessage,
  SessionListResponseMessage,
  TranscriptContentMessage,
  TranscriptContentBlock,
  TranscriptLoadRequestMessage,
  TranscriptLoadCompleteMessage,
  TranscriptUsage,
  CreateSessionRequestMessage,
  WorkspaceRequest,
  SessionWorkspace,
  CreateSessionResponseMessage,
  TerminalResizeMessage,
  AuthChallengeMessage,
  AuthResponseMessage,
  AuthResultMessage,
  KillSessionRequestMessage,
  KillSessionResponseMessage,
  RawPtyOutputMessage,
  RecentDirectory,
  SessionHistoryRequestMessage,
  SessionHistoryResponseMessage,
  ResumeSessionRequestMessage,
  ResumeSessionResponseMessage,
  DetachSessionMessage,
  DetachSessionAckMessage,
  PushPreferences,
  RegisterDeviceTokenMessage,
  UnregisterDeviceTokenMessage,
  DaemonUpdateAvailableMessage,
  HubStatusMessage,
  HubPendingQuestion,
  HubAutostartState,
  SessionRotatedMessage,
  SessionViewsMessage,
  SessionViewMeta,
  QuestionResolvedMessage,
  RemiStatusMessage,
  QuestionSnapshotMessage,
  CreateHelloAckOptions,
  CreateHelloOptions,
} from './protocol.ts';

export {
  generateId,
  now,
  serialize,
  deserialize,
  MESSAGE_DIRECTION,
  createHello,
  createHelloAck,
  createAgentOutput,
  createStructuredAgentOutput,
  createUserInput,
  createAck,
  createEdit,
  createPing,
  createPong,
  createError,
  createPromptWaitingError,
  PROMPT_WAITING_ERROR_CODE,
  PROMPT_WAITING_HELD_MESSAGE,
  PROMPT_WAITING_MESSAGE,
  PROMPT_WAITING_TERMINAL_MESSAGE,
  createInputNotDeliveredError,
  INPUT_NOT_DELIVERED_ERROR_CODE,
  INPUT_NOT_DELIVERED_MESSAGE,
  createQuestion,
  createAnswer,
  createAuqAnswer,
  createCancelQuestion,
  createSessionUpdate,
  createReplayBatch,
  createBulletExpandRequest,
  createBulletExpandResponse,
  createSessionListRequest,
  createSessionListResponse,
  createTranscriptContent,
  createTranscriptLoadRequest,
  createTranscriptLoadComplete,
  createCreateSessionRequest,
  createCreateSessionResponse,
  createTerminalResize,
  createAuthChallenge,
  createAuthResponse,
  createAuthResult,
  createKillSessionRequest,
  createKillSessionResponse,
  createRawPtyOutput,
  createSessionHistoryRequest,
  createSessionHistoryResponse,
  createResumeSessionRequest,
  createResumeSessionResponse,
  createDetachSession,
  createDetachSessionAck,
  createRegisterDeviceToken,
  createUnregisterDeviceToken,
  createDaemonUpdateAvailable,
  createHubStatus,
  createSessionRotated,
  createSessionViews,
  createQuestionResolved,
  createRemiStatus,
  createQuestionSnapshot,
  isValidMessage,
  MessageIdTracker,
} from './protocol.ts';

// Total-dispatch helpers over the protocol registry (#896)
export type { MessageHandlers } from './dispatch.ts';
export { dispatchMessage, assertNever } from './dispatch.ts';

// Crypto
export type { Base64, Fingerprint, RawKeyPair, ExportedKeyPair, EncryptedData } from './crypto.ts';
export * from './relay-crypto.ts';
export * from './sealed-answer.ts';
export {
  PBKDF2_ITERATIONS,
  SALT_SIZE,
  IV_SIZE,
  CHALLENGE_SIZE,
  FINGERPRINT_LENGTH,
  toBase64,
  fromBase64,
  generateKeyPair,
  exportKeyPair,
  importPublicKey,
  importPrivateKey,
  sign,
  verify,
  deriveKeyFromPassphrase,
  encryptPrivateKey,
  decryptPrivateKey,
  fingerprint,
  generateChallenge,
} from './crypto.ts';

// Identity
export type {
  RemiIdentity,
  AuthorizedKey,
  AuthorizedKeysFile,
  UnlockedIdentity,
  KnownHost,
} from './identity.ts';
export {
  isEncrypted,
  createIdentity,
  unlockIdentity,
  rekeyIdentity,
  serializeIdentity,
  deserializeIdentity,
  createAuthorizedKey,
  createAuthorizedKeysFile,
} from './identity.ts';

// Native lock-screen relay bridge (#591 P2)
export type { NativeIdentityRecord } from './native-bridge.ts';
export { deriveNativeIdentity } from './native-bridge.ts';

// Error helpers
export { errorToString } from './error-utils.ts';

// Async helpers
export { sleep } from './async-utils.ts';

// Text a peer controls, made safe to show (#1178)
export { escapeUnsafeText } from './display-text.ts';
// The protocol version and capabilities on hello_ack (#1237, ADR 0035)
export type { HubSupport, HubSupportAck } from './protocol-version.ts';
export { hubSupport, PROTOCOL_CAPABILITIES, PROTOCOL_VERSION } from './protocol-version.ts';

// Ed25519 admission defense shared by direct auth and relay (#873).
export { isSmallOrderPublicKey } from './ed25519-public-key.ts';
