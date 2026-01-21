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
  MessageIdTracker,
} from './protocol.ts';
