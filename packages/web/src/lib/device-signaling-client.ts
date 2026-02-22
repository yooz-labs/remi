/**
 * Device signaling client for web app.
 *
 * Connects to a persistent device room for reconnection.
 * Handles HMAC challenge-response authentication using Web Crypto API.
 */

export type DeviceSignalingState =
  | 'disconnected'
  | 'connecting'
  | 'authenticating'
  | 'connected'
  | 'error';

export interface DeviceSignalingCallbacks {
  onStateChange: (state: DeviceSignalingState) => void;
  onMessage: (message: unknown) => void;
  onError: (code: string, message: string) => void;
}

export class WebDeviceSignalingClient {
  private ws: WebSocket | null = null;
  private readonly callbacks: DeviceSignalingCallbacks;
  private state: DeviceSignalingState = 'disconnected';
  private intentionallyClosed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 5;
  private baseUrl: string | null = null;
  private deviceId: string | null = null;
  private clientId: string | null = null;
  private pairingToken: string | null = null;

  constructor(callbacks: DeviceSignalingCallbacks) {
    this.callbacks = callbacks;
  }

  connect(
    baseUrl: string,
    deviceId: string,
    clientId: string,
    pairingToken: string,
  ): void {
    this.baseUrl = baseUrl.replace(/\/connect\/?$/, '').replace(/\/$/, '');
    this.deviceId = deviceId;
    this.clientId = clientId;
    this.pairingToken = pairingToken;
    this.intentionallyClosed = false;
    this.reconnectAttempts = 0;
    this.connectInternal();
  }

  private connectInternal(): void {
    if (!this.baseUrl || !this.deviceId || !this.clientId) return;

    this.setState('connecting');

    const wsUrl = `${this.baseUrl}/device/${this.deviceId}`;
    this.ws = new WebSocket(wsUrl);

    this.ws.addEventListener('open', () => {
      this.reconnectAttempts = 0;
      // Request connection to the device
      this.send({ type: 'connect_device', deviceId: this.deviceId, clientId: this.clientId });
    });

    this.ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        switch (msg.type) {
          case 'peer-connected':
            this.setState('authenticating');
            break;
          case 'peer-disconnected':
            this.setState('disconnected');
            break;
          case 'relay':
            this.handleRelay(msg.payload);
            break;
          case 'error':
            this.callbacks.onError(msg.code, msg.message);
            this.setState('error');
            break;
          default:
            console.warn(`Unknown device signaling message: ${msg.type}`);
        }
      } catch (e) {
        console.warn('Failed to parse device signaling message:', e instanceof Error ? e.message : e);
      }
    });

    this.ws.addEventListener('close', () => {
      this.ws = null;
      if (!this.intentionallyClosed && this.reconnectAttempts < this.maxReconnectAttempts) {
        this.scheduleReconnect();
      } else {
        this.setState('disconnected');
      }
    });

    this.ws.addEventListener('error', () => {
      this.callbacks.onError('TRANSPORT_ERROR', 'Connection to signaling server failed');
    });
  }

  private async handleRelay(payloadStr: string): Promise<void> {
    try {
      const payload = JSON.parse(payloadStr);

      // Handle auth challenge from daemon
      if (payload.type === 'auth_challenge' && payload.nonce) {
        await this.respondToChallenge(payload.nonce);
        return;
      }

      // Handle auth result from daemon
      if (payload.type === 'auth_result') {
        if (payload.accepted) {
          this.setState('connected');
        } else {
          this.callbacks.onError('AUTH_FAILED', payload.error ?? 'Authentication failed');
          this.setState('error');
        }
        return;
      }

      // Forward other messages (only if connected/authenticated)
      if (this.state === 'connected') {
        this.callbacks.onMessage(payload);
      }
    } catch (e) {
      console.warn('Failed to parse device relay payload:', e instanceof Error ? e.message : e);
    }
  }

  private async respondToChallenge(nonce: string): Promise<void> {
    if (!this.pairingToken || !this.clientId) return;

    try {
      const hmac = await computeHmac(this.pairingToken, nonce);
      this.send({
        type: 'relay',
        payload: JSON.stringify({
          type: 'auth_response',
          clientId: this.clientId,
          hmac,
        }),
      });
    } catch (e) {
      console.error('Failed to compute HMAC:', e);
      this.callbacks.onError('AUTH_ERROR', 'Failed to compute authentication response');
      this.setState('error');
    }
  }

  sendMessage(message: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.state !== 'connected') return;
    this.send({ type: 'relay', payload: JSON.stringify(message) });
  }

  close(): void {
    this.intentionallyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.setState('disconnected');
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectAttempts++;
    const delay = Math.min(5000 * 2 ** (this.reconnectAttempts - 1), 60000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.intentionallyClosed) {
        this.connectInternal();
      }
    }, delay);
  }

  get isConnected(): boolean {
    return this.state === 'connected';
  }

  get currentState(): DeviceSignalingState {
    return this.state;
  }

  private setState(state: DeviceSignalingState): void {
    this.state = state;
    this.callbacks.onStateChange(state);
  }

  private send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
}

/** Compute HMAC-SHA256 using Web Crypto API. Returns hex string. */
async function computeHmac(tokenHex: string, nonce: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = hexToBytes(tokenHex);

  const key = await crypto.subtle.importKey(
    'raw',
    keyData.buffer as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(nonce));
  return bytesToHex(new Uint8Array(signature));
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
