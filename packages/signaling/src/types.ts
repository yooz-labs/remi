/**
 * Signaling types for WebRTC connection establishment.
 */

/** Unique connection code (e.g., "AXBY-1234") */
export type ConnectionCode = string;

/** WebSocket session ID */
export type SessionId = string;

/** Role in the signaling handshake */
export type PeerRole = 'host' | 'client';

/**
 * Signaling message types.
 */
export type SignalingMessage =
  | RegisterMessage
  | RegisteredMessage
  | JoinMessage
  | JoinedMessage
  | OfferMessage
  | AnswerMessage
  | IceCandidateMessage
  | ErrorMessage
  | PeerConnectedMessage
  | PeerDisconnectedMessage
  | RelayMessage;

/** Host registers to get a connection code */
export interface RegisterMessage {
  readonly type: 'register';
}

/** Response with connection code */
export interface RegisteredMessage {
  readonly type: 'registered';
  readonly code: ConnectionCode;
  readonly expiresAt: string;
}

/** Client joins using connection code */
export interface JoinMessage {
  readonly type: 'join';
  readonly code: ConnectionCode;
}

/** Response when joined successfully */
export interface JoinedMessage {
  readonly type: 'joined';
  readonly code: ConnectionCode;
}

/** SDP offer from one peer */
export interface OfferMessage {
  readonly type: 'offer';
  readonly sdp: string;
}

/** SDP answer from other peer */
export interface AnswerMessage {
  readonly type: 'answer';
  readonly sdp: string;
}

/** ICE candidate for NAT traversal */
export interface IceCandidateMessage {
  readonly type: 'ice-candidate';
  readonly candidate: string;
  readonly sdpMid: string | null;
  readonly sdpMLineIndex: number | null;
}

/** Error message */
export interface ErrorMessage {
  readonly type: 'error';
  readonly code: string;
  readonly message: string;
}

/** Peer connected notification */
export interface PeerConnectedMessage {
  readonly type: 'peer-connected';
  readonly role: PeerRole;
}

/** Peer disconnected notification */
export interface PeerDisconnectedMessage {
  readonly type: 'peer-disconnected';
  readonly role: PeerRole;
}

/** Relay message - forwarded between host and client */
export interface RelayMessage {
  readonly type: 'relay';
  readonly payload: string;
}

/**
 * Parse a signaling message from JSON.
 */
export function parseMessage(data: string): SignalingMessage | null {
  try {
    const parsed = JSON.parse(data) as unknown;
    if (typeof parsed !== 'object' || parsed === null) {
      console.warn('Signaling message is not a JSON object');
      return null;
    }

    const obj = parsed as Record<string, unknown>;
    if (typeof obj.type !== 'string') {
      console.warn('Signaling message missing "type" field');
      return null;
    }

    const validTypes = [
      'register',
      'registered',
      'join',
      'joined',
      'offer',
      'answer',
      'ice-candidate',
      'error',
      'peer-connected',
      'peer-disconnected',
      'relay',
    ];

    if (!validTypes.includes(obj.type)) {
      console.warn(`Unknown signaling message type: ${obj.type}`);
      return null;
    }

    return parsed as SignalingMessage;
  } catch (e) {
    console.warn('Failed to parse signaling message:', e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Serialize a signaling message to JSON.
 */
export function serializeMessage(message: SignalingMessage): string {
  return JSON.stringify(message);
}
