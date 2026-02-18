/**
 * Signaling client for web app.
 *
 * Connects to the signaling server, joins a room via code,
 * and relays Remi protocol messages.
 */

export type SignalingState = 'disconnected' | 'connecting' | 'joined' | 'connected' | 'error';

export interface SignalingClientCallbacks {
  onStateChange: (state: SignalingState) => void;
  onMessage: (message: unknown) => void;
  onError: (code: string, message: string) => void;
}

export class WebSignalingClient {
  private ws: WebSocket | null = null;
  private readonly callbacks: SignalingClientCallbacks;
  private state: SignalingState = 'disconnected';

  constructor(callbacks: SignalingClientCallbacks) {
    this.callbacks = callbacks;
  }

  connect(signalingUrl: string, code: string): void {
    this.setState('connecting');

    this.ws = new WebSocket(signalingUrl);

    this.ws.addEventListener('open', () => {
      // Join with the provided code
      this.send({ type: 'join', code });
    });

    this.ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        switch (msg.type) {
          case 'joined':
            this.setState('joined');
            break;
          case 'peer-connected':
            this.setState('connected');
            break;
          case 'peer-disconnected':
            this.setState('disconnected');
            break;
          case 'relay':
            try {
              const payload = JSON.parse(msg.payload as string);
              this.callbacks.onMessage(payload);
            } catch {
              // ignore bad payloads
            }
            break;
          case 'error':
            this.callbacks.onError(msg.code, msg.message);
            this.setState('error');
            break;
        }
      } catch {
        // ignore parse errors
      }
    });

    this.ws.addEventListener('close', () => {
      this.ws = null;
      this.setState('disconnected');
    });

    this.ws.addEventListener('error', () => {
      // close event will follow
    });
  }

  sendMessage(message: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.send({ type: 'relay', payload: JSON.stringify(message) });
  }

  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.setState('disconnected');
  }

  get isConnected(): boolean {
    return this.state === 'connected';
  }

  get currentState(): SignalingState {
    return this.state;
  }

  private setState(state: SignalingState): void {
    this.state = state;
    this.callbacks.onStateChange(state);
  }

  private send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
}
