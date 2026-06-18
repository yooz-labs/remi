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
  Message,
  BulletType,
  Bullet,
  StructuredMessage,
  Acknowledgment,
  Question,
  QuestionOption,
  QuestionSource,
  Session,
  ConnectionInfo,
  Result,
  SessionSource,
  DiscoverableSessionStatus,
  DiscoverableSession,
} from './types.ts';

export { ok, err, isOk, isErr, MAIN_AGENT_ID } from './types.ts';

// Permission/question defaults shared by daemon and client (#396)
export {
  DEFAULT_PERMISSION_LABELS,
  QUESTION_DEDUP_WINDOW_MS,
} from './permission-defaults.ts';

// Daemon loopback port range — single source of truth for daemon + client (#435)
export { DAEMON_BASE_PORT, DAEMON_PORT_RANGE } from './daemon-ports.ts';

// Protocol
export type {
  ProtocolMessage,
  HelloMessage,
  HelloAckMessage,
  AgentOutputMessage,
  StructuredAgentOutputMessage,
  UserInputMessage,
  AckMessage,
  EditMessage,
  QuestionMessage,
  AnswerMessage,
  SessionUpdateMessage,
  PingMessage,
  PongMessage,
  ErrorMessage,
  StaleSessionErrorDetails,
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
  RegisterDeviceTokenMessage,
  DaemonUpdateAvailableMessage,
  SessionRotatedMessage,
  SessionViewsMessage,
  SessionViewMeta,
  QuestionResolvedMessage,
  CreateHelloOptions,
} from './protocol.ts';

export {
  generateId,
  now,
  serialize,
  deserialize,
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
  createQuestion,
  createAnswer,
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
  createDaemonUpdateAvailable,
  createSessionRotated,
  createSessionViews,
  createQuestionResolved,
  MessageIdTracker,
} from './protocol.ts';

// Crypto
export type { Base64, Fingerprint, RawKeyPair, ExportedKeyPair, EncryptedData } from './crypto.ts';
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

// Error helpers
export { errorToString } from './error-utils.ts';

// Async helpers
export { sleep } from './async-utils.ts';
