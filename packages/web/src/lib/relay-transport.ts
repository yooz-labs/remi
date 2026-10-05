import type { ConnectionStatus } from '@/types';
import type { ProtocolMessage } from '@remi/shared';
import type {
  RelayMachineChannel,
  RelayMachineEvents,
  RelayMachinePin,
} from './relay-machine-channel';

export interface ConnectionTransport {
  readonly isConnected: boolean;
  readonly isTransportOpen: boolean;
  readonly isHealthy: boolean;
  send(message: ProtocolMessage): boolean;
  disconnect(): void;
  setConnected(): void;
  reconnectWithUrl(url: string): void;
  forceReconnect(): void;
}

/** Resume always uses a fresh handshake. Unconfirmed pairing is never retried automatically. */
export class RelayTransport implements ConnectionTransport {
  private channel: RelayMachineChannel | null = null;
  private generation = 0;
  private stopped = false;
  private attempts = 0;
  private enrolled = false;
  private resumeSuspended = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly makeChannel: (
    events: RelayMachineEvents,
    resume: boolean,
  ) => Promise<RelayMachineChannel>;
  private readonly identityCurrent: () => boolean;
  private readonly autoReconnect: boolean;
  private readonly events: RelayMachineEvents & { onStatus: (status: ConnectionStatus) => void };
  constructor(
    makeChannel: (events: RelayMachineEvents, resume: boolean) => Promise<RelayMachineChannel>,
    identityCurrent: () => boolean,
    autoReconnect: boolean,
    events: RelayMachineEvents & { onStatus: (status: ConnectionStatus) => void },
    alreadyEnrolled = false,
  ) {
    this.makeChannel = makeChannel;
    this.identityCurrent = identityCurrent;
    this.autoReconnect = autoReconnect;
    this.events = events;
    this.enrolled = alreadyEnrolled;
  }

  get isConnected(): boolean {
    return this.channel?.connected ?? false;
  }
  get isTransportOpen(): boolean {
    return this.isConnected;
  }
  get isHealthy(): boolean {
    return this.isConnected;
  }
  send(message: ProtocolMessage): boolean {
    return this.channel?.send(message) ?? false;
  }
  setConnected(): void {
    /* Only verified V2 ready establishes this transport. */
  }
  reconnectWithUrl(_url: string): void {
    this.forceReconnect();
  }

  async connect(): Promise<void> {
    if (this.stopped || !this.identityCurrent()) return;
    const generation = ++this.generation;
    this.events.onStatus(this.attempts ? 'reconnecting' : 'connecting');
    try {
      const channel = await this.makeChannel(
        {
          onPhase: (phase, fingerprint) => {
            if (generation !== this.generation || this.stopped) return;
            if (phase === 'handshake' || phase === 'confirmation')
              this.events.onStatus('authenticating');
            this.events.onPhase?.(phase, fingerprint);
          },
          onReady: (pin: RelayMachinePin) => {
            if (generation !== this.generation || this.stopped) return;
            try {
              this.events.onReady?.(pin);
            } catch (cause) {
              // A verified handshake is not a durable saved connection. Keep this
              // storage/capacity failure visible and never enter the resume loop.
              this.resumeSuspended = true;
              this.events.onError?.(
                cause instanceof Error ? cause : new Error('Saving the paired machine failed.'),
              );
              this.events.onStatus('disconnected');
              throw cause;
            }
            this.enrolled = true;
            this.attempts = 0;
            this.events.onStatus('connected');
          },
          onMessage: (message) => {
            if (generation === this.generation && !this.stopped) this.events.onMessage?.(message);
          },
          onError: (error) => {
            if (generation === this.generation && !this.stopped) this.events.onError?.(error);
          },
          onClose: (end) => {
            if (generation !== this.generation || this.stopped) return;
            this.events.onClose?.(end);
            this.events.onStatus('disconnected');
            if (
              this.resumeSuspended ||
              !this.enrolled ||
              !this.autoReconnect ||
              !this.identityCurrent() ||
              this.attempts >= 5
            )
              return;
            const random = crypto.getRandomValues(new Uint32Array(1))[0] / 0x100000000;
            const delay = Math.min(30000, 1000 * 2 ** this.attempts++) * (0.75 + random * 0.5);
            this.timer = setTimeout(() => {
              this.timer = null;
              void this.connect();
            }, delay);
          },
        },
        this.enrolled,
      );
      if (generation !== this.generation || this.stopped || !this.identityCurrent()) {
        await channel.close();
        return;
      }
      this.channel = channel;
      await channel.start();
    } catch (error) {
      if (generation !== this.generation || this.stopped) return;
      this.events.onError?.(error instanceof Error ? error : new Error('Relay connection failed.'));
      this.events.onStatus('error');
    }
  }

  suspendResume(): void {
    this.resumeSuspended = true;
  }
  forceReconnect(): void {
    if (this.stopped || !this.enrolled) return;
    ++this.generation;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const prior = this.channel;
    this.channel = null;
    void (async () => {
      await prior?.close();
      await this.connect();
    })();
  }
  disconnect(): void {
    this.stopped = true;
    ++this.generation;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    void this.channel?.close();
    this.channel = null;
  }
}
