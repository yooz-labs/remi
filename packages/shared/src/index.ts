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
  Session,
  ConnectionInfo,
  Result,
  SessionSource,
  DiscoverableSessionStatus,
  DiscoverableSession,
} from './types.ts';

export { ok, err, isOk, isErr } from './types.ts';

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
  ReplayBatchMessage,
  BulletExpandRequestMessage,
  BulletExpandResponseMessage,
  SessionListRequestMessage,
  SessionListResponseMessage,
  TranscriptContentMessage,
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
  serializeIdentity,
  deserializeIdentity,
  createAuthorizedKey,
  createAuthorizedKeysFile,
} from './identity.ts';
