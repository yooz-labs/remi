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
  UserInputMessage,
  AckMessage,
  EditMessage,
  QuestionMessage,
  AnswerMessage,
  SessionUpdateMessage,
  PingMessage,
  PongMessage,
  ErrorMessage,
} from './protocol.ts';

export {
  generateId,
  now,
  serialize,
  deserialize,
  createHello,
  createHelloAck,
  createAgentOutput,
  createUserInput,
  createAck,
  createEdit,
  createPing,
  createPong,
  createError,
  createQuestion,
  createSessionUpdate,
  MessageIdTracker,
} from './protocol.ts';
