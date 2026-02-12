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
  MessageIdTracker,
} from './protocol.ts';
