/**
 * Signaling client for web app.
 *
 * Connects to the signaling server via code-named room,
 * joins as client, and relays Remi protocol messages.
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
  private intentionallyClosed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private peerRejoinTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private peerRejoinAttempts = 0;
  private readonly maxReconnectAttempts = 3;
  private readonly maxPeerRejoinAttempts = 10;
  private readonly peerRejoinIntervalMs = 3000;
  private baseUrl: string | null = null;
  private code: string | null = null;

  constructor(callbacks: SignalingClientCallbacks) {
    this.callbacks = callbacks;
  }

  connect(baseUrl: string, code: string): void {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.code = code;
    this.intentionallyClosed = false;
    this.reconnectAttempts = 0;
    this.connectInternal();
  }

  private connectInternal(): void {
    if (!this.baseUrl || !this.code) return;

    this.setState('connecting');

    // Connect to the code-named room directly
    const wsUrl = `${this.baseUrl}/${this.code}`;
    this.ws = new WebSocket(wsUrl);

    const code = this.code;

    this.ws.addEventListener('open', () => {
      this.reconnectAttempts = 0;
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
            // Peer reconnected; cancel any pending rejoin loop
            if (this.peerRejoinTimer) {
              clearTimeout(this.peerRejoinTimer);
              this.peerRejoinTimer = null;
            }
            this.peerRejoinAttempts = 0;
            this.setState('connected');
            break;
          case 'peer-disconnected':
            // Peer (daemon) dropped; stay in room and periodically re-join
            // to wait for peer to come back
            this.setState('joined');
            this.schedulePeerRejoin();
            break;
          case 'relay':
            try {
              const payload = JSON.parse(msg.payload as string);
              this.callbacks.onMessage(payload);
            } catch (e) {
              console.warn('Failed to parse relay payload:', e instanceof Error ? e.message : e);
            }
            break;
          case 'error':
            this.callbacks.onError(msg.code, msg.message);
            this.setState('error');
            break;
          default:
            console.warn(`Unknown signaling message type: ${msg.type}`);
        }
      } catch (e) {
        console.warn('Failed to parse signaling message:', e instanceof Error ? e.message : e);
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
      // close event will follow
    });
  }

  sendMessage(message: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[SignalingClient] Message dropped: WebSocket not open');
      return;
    }
    this.send({ type: 'relay', payload: JSON.stringify(message) });
  }

  close(): void {
    this.intentionallyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.peerRejoinTimer) {
      clearTimeout(this.peerRejoinTimer);
      this.peerRejoinTimer = null;
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
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.intentionallyClosed) {
        this.connectInternal();
      }
    }, 5000);
  }

  /**
   * Periodically re-send join to wait for peer to reconnect.
   * Stops after maxPeerRejoinAttempts or when peer connects.
   */
  private schedulePeerRejoin(): void {
    if (this.peerRejoinTimer || this.intentionallyClosed) return;
    this.peerRejoinAttempts = 0;
    this.peerRejoinLoop();
  }

  private peerRejoinLoop(): void {
    if (this.intentionallyClosed || this.state === 'connected') return;
    if (this.peerRejoinAttempts >= this.maxPeerRejoinAttempts) {
      console.warn(`[SignalingClient] Peer rejoin attempts exhausted (${this.maxPeerRejoinAttempts})`);
      this.setState('disconnected');
      return;
    }
    this.peerRejoinAttempts++;
    this.peerRejoinTimer = setTimeout(() => {
      this.peerRejoinTimer = null;
      if (this.intentionallyClosed || this.state === 'connected') return;
      // Re-send join in the existing WebSocket to signal we are still waiting
      if (this.code) {
        this.send({ type: 'join', code: this.code });
      }
      this.peerRejoinLoop();
    }, this.peerRejoinIntervalMs);
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
