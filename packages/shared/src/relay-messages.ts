/** Application outcomes inside the relay channel; delivery is decided by the child answer core. */
import { generateId, now } from './protocol.ts';
import type { Timestamp, UUID } from './types.ts';

export type AnswerOutcome = 'delivered' | 'session-not-found' | 'stale-binding' | 'stale';
export type AnswerResultOutcome = AnswerOutcome | 'uncertain' | 'conflict' | 'busy';
export interface AnswerResultMessage {
  readonly type: 'answer_result';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  readonly requestId: UUID;
  readonly sessionId: UUID;
  readonly questionId: UUID;
  readonly outcome: AnswerResultOutcome;
}
export interface RelayDevice {
  readonly fingerprint: string;
  readonly publicKey: string;
  readonly label: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}
export interface RelayDevicesRequestMessage {
  readonly type: 'relay_devices_request';
  readonly id: UUID;
  readonly timestamp: Timestamp;
}
export interface RelayDevicesResponseMessage {
  readonly type: 'relay_devices_response';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  readonly requestId: UUID;
  readonly devices: readonly RelayDevice[];
}
export interface RelayDeviceRevokeRequestMessage {
  readonly type: 'relay_device_revoke_request';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  readonly fingerprint: string;
}
export interface RelayDeviceRevokeResponseMessage {
  readonly type: 'relay_device_revoke_response';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  readonly requestId: UUID;
  readonly fingerprint: string;
  readonly success: boolean;
  readonly edgeAcknowledged: boolean;
  readonly error?: 'STORAGE_ERROR' | 'EDGE_UNVERIFIED' | 'NOT_FOUND';
}
export function createAnswerResult(
  requestId: UUID,
  sessionId: UUID,
  questionId: UUID,
  outcome: AnswerResultOutcome,
): AnswerResultMessage {
  return {
    type: 'answer_result',
    id: generateId(),
    timestamp: now(),
    requestId,
    sessionId,
    questionId,
    outcome,
  };
}
