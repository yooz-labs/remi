import {
  type AnswerMessage,
  type AnswerResultOutcome,
  type ProtocolMessage,
  type RelayDeviceRevokeResponseMessage,
  type RelayDevicesResponseMessage,
  type SecurePushRegisterResponseMessage,
  type SecurePushRegistration,
  type SecurePushUnregisterResponseMessage,
  createSecurePushRegisterRequest,
  createSecurePushUnregisterRequest,
  generateId,
  now,
} from '@remi/shared';

export interface RelayAnswerStatus {
  readonly requestId: string;
  readonly sessionId: string;
  readonly questionId: string;
  readonly outcome: AnswerResultOutcome;
}
type DeviceResponse = RelayDevicesResponseMessage | RelayDeviceRevokeResponseMessage |
  SecurePushRegisterResponseMessage | SecurePushUnregisterResponseMessage;
interface Pending {
  readonly request: ProtocolMessage;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly resolve?: (response: DeviceResponse) => void;
  readonly reject?: (error: Error) => void;
}
/** One transport generation. Every waiter registers before send; answers have no retry path. */
export class RelayRequests {
  private readonly pending = new Map<string, Pending>();
  private readonly send: (message: ProtocolMessage) => boolean;
  private readonly onAnswer: (status: RelayAnswerStatus) => void;
  constructor(
    send: (message: ProtocolMessage) => boolean,
    onAnswer: (status: RelayAnswerStatus) => void,
  ) {
    this.send = send;
    this.onAnswer = onAnswer;
  }

  answer(request: AnswerMessage): boolean {
    if (
      this.pending.size >= 128 ||
      this.pending.has(request.id) ||
      [...this.pending.values()].some(
        (item) =>
          item.request.type === 'answer' &&
          item.request.sessionId === request.sessionId &&
          item.request.questionId === request.questionId,
      )
    )
      return false;
    const timer = setTimeout(() => this.endAnswer(request, 'uncertain'), 10000);
    this.pending.set(request.id, { request, timer });
    if (this.send(request)) return true;
    clearTimeout(timer);
    this.pending.delete(request.id);
    return false;
  }
  private endAnswer(request: AnswerMessage, outcome: AnswerResultOutcome): void {
    const pending = this.pending.get(request.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(request.id);
    this.onAnswer({
      requestId: request.id,
      sessionId: request.sessionId,
      questionId: request.questionId,
      outcome,
    });
  }
  receive(message: ProtocolMessage): boolean {
    // A question resolution may be from another client or the terminal. Keep this
    // request's waiter until its correlated result or deadline; resolution is not delivery.
    if (
      !['answer_result', 'relay_devices_response', 'relay_device_revoke_response',
        'secure_push_register_response', 'secure_push_unregister_response'].includes(
        message.type,
      )
    )
      return true;
    if (!('requestId' in message)) return false;
    const pending = this.pending.get(message.requestId);
    if (!pending) return false;
    const request = pending.request;
    if (message.type === 'answer_result' && request.type === 'answer') {
      if (
        ![
          'delivered',
          'session-not-found',
          'stale-binding',
          'stale',
          'uncertain',
          'conflict',
          'busy',
        ].includes(message.outcome)
      )
        return false;
      if (message.sessionId !== request.sessionId || message.questionId !== request.questionId)
        return false;
      this.endAnswer(request, message.outcome);
      return true;
    }
    if (
      (message.type === 'relay_devices_response' && request.type === 'relay_devices_request') ||
      (message.type === 'relay_device_revoke_response' &&
        request.type === 'relay_device_revoke_request' &&
        message.fingerprint === request.fingerprint)
    ) {
      clearTimeout(pending.timer);
      this.pending.delete(request.id);
      pending.resolve?.(message);
      return true;
    }
    if ((message.type === 'secure_push_register_response' && request.type === 'secure_push_register_request') ||
        (message.type === 'secure_push_unregister_response' && request.type === 'secure_push_unregister_request')) {
      if (message.success !== true && (message.success !== false ||
          !['UNSUPPORTED','NOT_AUTHORIZED','NOT_ENROLLED','INVALID_SUBSCRIPTION','STALE_KEY_VERSION','CAPACITY','STORE_ERROR'].includes(message.error))) return false;
      if (message.type === 'secure_push_register_response' && request.type === 'secure_push_register_request' &&
          message.success && message.keyVersion !== request.keyVersion) return false;
      clearTimeout(pending.timer);
      this.pending.delete(request.id);
      pending.resolve?.(message);
      return true;
    }
    return false;
  }
  devices(): Promise<RelayDevicesResponseMessage> {
    return this.request({
      type: 'relay_devices_request',
      id: generateId(),
      timestamp: now(),
    }) as Promise<RelayDevicesResponseMessage>;
  }
  revoke(fingerprint: string): Promise<RelayDeviceRevokeResponseMessage> {
    if (!/^[0-9a-f]{16}$/.test(fingerprint))
      return Promise.reject(new Error('Invalid device fingerprint.'));
    return this.request({
      type: 'relay_device_revoke_request',
      id: generateId(),
      timestamp: now(),
      fingerprint,
    }) as Promise<RelayDeviceRevokeResponseMessage>;
  }
  registerPush(metadata: SecurePushRegistration): Promise<SecurePushRegisterResponseMessage> {
    return this.request(createSecurePushRegisterRequest(metadata)) as Promise<SecurePushRegisterResponseMessage>;
  }
  unregisterPush(): Promise<SecurePushUnregisterResponseMessage> {
    return this.request(createSecurePushUnregisterRequest()) as Promise<SecurePushUnregisterResponseMessage>;
  }
  private request(request: ProtocolMessage): Promise<DeviceResponse> {
    if (this.pending.size >= 128)
      return Promise.reject(new Error('Too many pending relay requests.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        reject(new Error('Relay outcome unverified: no response within 10 seconds.'));
      }, 10000);
      this.pending.set(request.id, { request, timer, resolve, reject });
      if (!this.send(request)) {
        clearTimeout(timer);
        this.pending.delete(request.id);
        reject(new Error('Relay connection unavailable.'));
      }
    });
  }
  closed(): void {
    for (const pending of [...this.pending.values()]) {
      if (pending.request.type === 'answer') this.endAnswer(pending.request, 'uncertain');
      else {
        clearTimeout(pending.timer);
        pending.reject?.(
          new Error('Disconnected: relay request outcome unverified.'),
        );
      }
    }
    this.pending.clear();
  }
}
