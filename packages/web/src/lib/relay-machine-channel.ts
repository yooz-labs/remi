import { type ProtocolMessage, createPong, deserialize, relayV2, serialize } from '@remi/shared';

export interface RelayMachinePin {
  readonly relayUrl: string;
  readonly machinePublicKey: string;
  readonly sealPublicKey?: string;
}

export type RelayPhase = 'opening' | 'handshake' | 'confirmation' | 'connected' | 'closed';
export interface RelayMachineEvents {
  readonly onPhase?: (phase: RelayPhase, fingerprint?: string) => void;
  readonly onMessage?: (message: ProtocolMessage) => void;
  readonly onReady?: (pin: RelayMachinePin) => void | Promise<void>;
  readonly onClose?: (end: relayV2.StreamEnd) => void;
  readonly onError?: (error: Error) => void;
}

/** One use of the reviewed handshake and Channel. A close is final; resume constructs a fresh instance. */
export class RelayMachineChannel {
  readonly pin: RelayMachinePin;
  private readonly machine: Uint8Array;
  private readonly device: relayV2.Signer;
  private readonly devicePublic: Uint8Array;
  private readonly identityCurrent: () => boolean;
  private readonly events: RelayMachineEvents;
  private token: relayV2.PairingToken | null;
  private ws: WebSocket | null = null;
  private first: relayV2.ClientStep1 | null = null;
  private second: relayV2.ClientStep2 | null = null;
  private channel: relayV2.Channel | null = null;
  private phase: RelayPhase = 'opening';
  private wirePhase: 'nonce' | 'admitted' | 'open' | 'ack' | 'ready' | 'data' = 'nonce';
  private started = false;
  private closing = false;
  private generation = 0;
  private startedAt = 0;
  private inbound: Promise<void> = Promise.resolve();
  private outbound: Promise<void> = Promise.resolve();
  private finished: Promise<void> | null = null;
  private deadline: ReturnType<typeof setTimeout> | null = null;
  private queuedFrames = 0;
  private queuedBytes = 0;
  private pendingSends = 0;
  private drainingSend = false;
  private failed = false;
  private peerEnded: Promise<void>;
  private resolvePeerEnded!: () => void;
  private expiry: ReturnType<typeof setTimeout> | null = null;

  private constructor(
    pin: RelayMachinePin,
    device: relayV2.Signer,
    identityCurrent: () => boolean,
    events: RelayMachineEvents,
    token: relayV2.PairingToken | null,
  ) {
    this.pin = Object.freeze({ ...pin });
    this.machine = relayV2.fromB64u(pin.machinePublicKey);
    this.device = device;
    this.devicePublic = device.publicKey.slice();
    this.identityCurrent = identityCurrent;
    this.events = events;
    this.token = token;
    this.peerEnded = new Promise((resolve) => {
      this.resolvePeerEnded = resolve;
    });
  }

  static async pair(
    text: string,
    device: relayV2.Signer,
    identityCurrent: () => boolean,
    events: RelayMachineEvents = {},
  ): Promise<RelayMachineChannel> {
    if (text.length > 4096) throw new Error('Pairing token exceeds limit.');
    const token = await relayV2.decodePairingToken(text, Math.floor(Date.now() / 1000));
    if (!identityCurrent() || relayV2.isSmallOrderPublicKey(token.machinePublicKey)) {
      token.secret.fill(0);
      throw new Error('Pairing identity or machine key is invalid.');
    }
    return new RelayMachineChannel(
      {
        relayUrl: token.relayUrl,
        machinePublicKey: relayV2.b64u(token.machinePublicKey),
        ...(token.sealPublicKey ? { sealPublicKey: relayV2.b64u(token.sealPublicKey) } : {}),
      },
      device,
      identityCurrent,
      events,
      token,
    );
  }

  static resume(
    pin: RelayMachinePin,
    device: relayV2.Signer,
    identityCurrent: () => boolean,
    events: RelayMachineEvents = {},
  ): RelayMachineChannel {
    const machine = relayV2.fromB64u(pin.machinePublicKey);
    if (
      machine.length !== 32 ||
      relayV2.isSmallOrderPublicKey(machine) ||
      !/^(wss:\/\/[a-z0-9.-]+|ws:\/\/(localhost|127\.0\.0\.1))(:[0-9]{1,5})?(\/[A-Za-z0-9._~/-]*)?$/.test(
        pin.relayUrl,
      )
    ) {
      throw new Error('Invalid public relay machine pin.');
    }
    return new RelayMachineChannel(pin, device, identityCurrent, events, null);
  }

  get connected(): boolean {
    return !this.closing && this.phase === 'connected';
  }

  private current(generation: number): boolean {
    return (
      !this.closing &&
      this.generation === generation &&
      this.identityCurrent() &&
      relayV2.ctEqual(this.devicePublic, this.device.publicKey) &&
      (!this.token || Date.now() < this.token.expiresAtSec * 1000)
    );
  }

  async start(): Promise<void> {
    if (this.started || this.closing) throw new Error('Relay connection is single use.');
    this.started = true;
    this.startedAt = Date.now();
    const generation = this.generation;
    this.setDeadline(relayV2.HANDSHAKE_TIMEOUT_MS);
    if (this.token)
      this.expiry = setTimeout(
        () => this.fail(new Error('Pairing token expired.')),
        Math.max(0, this.token.expiresAtSec * 1000 - Date.now()),
      );
    try {
      const rid = await relayV2.ridOf(this.machine);
      if (!this.current(generation)) {
        await this.close();
        return;
      }
      const hex = Array.from(rid, (byte) => byte.toString(16).padStart(2, '0')).join('');
      const ws = new WebSocket(`${this.pin.relayUrl.replace(/\/$/, '')}/v2/client/${hex}`);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      ws.onmessage = (event) => {
        const received: unknown = event.data;
        const length =
          received instanceof ArrayBuffer
            ? received.byteLength
            : typeof received === 'string'
              ? received.length
              : -1;
        const limit = typeof received === 'string' ? relayV2.MAX_CONTROL_TEXT : relayV2.MAX_FRAME;
        // Bound before retaining frames or scheduling crypto. No Blob conversion or unbounded promise queue.
        if (
          length < 0 ||
          length > limit ||
          this.queuedFrames >= relayV2.MAX_PENDING_SENDS ||
          this.queuedBytes + length > 4 * relayV2.MAX_FRAME
        ) {
          this.fail(new Error('Relay receive queue or frame limit exceeded.'));
          return;
        }
        ++this.queuedFrames;
        this.queuedBytes += length;
        this.inbound = this.inbound
          .then(() => this.receive(received, rid, generation))
          .catch((error) => {
            this.fail(error);
          })
          .finally(() => {
            --this.queuedFrames;
            this.queuedBytes -= length;
          });
      };
      ws.onerror = () => this.fail(new Error('Relay transport unavailable.'));
      ws.onclose = () => {
        void this.finish();
      };
    } catch (error) {
      this.fail(error);
    }
  }

  private setDeadline(milliseconds: number): void {
    if (this.deadline) clearTimeout(this.deadline);
    this.deadline = setTimeout(
      () => this.fail(new Error('Relay handshake or local confirmation timed out.')),
      Math.max(0, this.startedAt + milliseconds - Date.now()),
    );
  }

  private sendText(text: string): void {
    if (this.closing || this.ws?.readyState !== WebSocket.OPEN)
      throw new Error('Relay transport closed.');
    this.ws.send(text);
  }

  private async receive(data: unknown, rid: Uint8Array, generation: number): Promise<void> {
    // Established frames already queued before a transport close must drain before onClose.
    const established = this.channel;
    if (established) {
      const frame = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
      if (!(frame instanceof Uint8Array) && typeof frame !== 'string')
        throw new Error('Invalid relay frame.');
      const plaintext = await established.receive(frame);
      if (plaintext === null) {
        this.resolvePeerEnded();
        void this.close();
        return;
      }
      if (this.closing || this.generation !== generation || !this.identityCurrent()) return;
      const message = deserialize(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
      if (
        !message ||
        ['auth_challenge', 'auth_result', 'raw_pty_output', 'terminal_resize'].includes(
          message.type,
        )
      ) {
        throw new Error('Unsupported relay application message.');
      }
      // Match the direct transport: the machine Connection's heartbeat is
      // answered here, even when application reads are routed elsewhere (#1202).
      if (message.type === 'ping') this.send(createPong(message.id));
      this.events.onMessage?.(message);
      return;
    }
    if (!this.current(generation)) return;
    if (typeof data !== 'string') throw new Error('Relay handshake requires canonical text.');
    if (this.wirePhase === 'nonce') {
      const notice = relayV2.decodeNotice(data);
      if (notice.t !== 'nonce') throw new Error('Unexpected relay admission notice.');
      const signature = await relayV2.signAdmission(this.device, 'client', rid, notice.nonce);
      if (!this.current(generation)) return;
      const ticket = this.token ? await relayV2.admitTag(this.token.secret) : undefined;
      if (!this.current(generation)) {
        ticket?.fill(0);
        return;
      }
      this.sendText(
        relayV2.encodeAdmit({ key: this.devicePublic, signature, ...(ticket ? { ticket } : {}) }),
      );
      ticket?.fill(0);
      this.wirePhase = 'admitted';
      return;
    }
    if (this.wirePhase === 'admitted' || this.wirePhase === 'open') {
      const notice = relayV2.decodeNotice(data);
      if (notice.t === 'admitted' && this.wirePhase === 'admitted') {
        this.wirePhase = 'open';
        return;
      }
      if (notice.t === 'host' && this.wirePhase === 'open') return;
      if (notice.t !== 'open' || this.wirePhase !== 'open')
        throw new Error('Unexpected relay pipe notice.');
      const step = await relayV2.clientStart(
        {
          machinePublicKey: this.machine,
          device: this.device,
          mode: this.token ? 'pair' : 'resume',
          ...(this.token ? { pairingSecret: this.token.secret } : {}),
          random: relayV2.systemRandom,
          deviceName: 'Remi',
        },
        this.startedAt,
      );
      if (!this.current(generation)) {
        step.abort();
        return;
      }
      this.first = step;
      this.wirePhase = 'ack';
      this.phase = 'handshake';
      this.events.onPhase?.(this.phase);
      this.sendText(step.hello);
      return;
    }
    if (this.wirePhase === 'ack' && this.first) {
      const step = await this.first.onHelloAck(data, Date.now());
      if (!this.current(generation)) {
        step.abort();
        return;
      }
      this.second = step;
      this.first = null;
      this.wirePhase = 'ready';
      this.phase = 'confirmation';
      this.setDeadline(this.token ? relayV2.PAIR_CONFIRM_TIMEOUT_MS : relayV2.HANDSHAKE_TIMEOUT_MS);
      this.events.onPhase?.(this.phase, step.fingerprint);
      this.sendText(step.auth);
      return;
    }
    if (this.wirePhase === 'ready' && this.second) {
      const channel = await this.second.onReady(data, Date.now(), {
        emit: (frame) => {
          if (
            this.generation !== generation ||
            !this.identityCurrent() ||
            (this.closing && !this.drainingSend) ||
            this.ws?.readyState !== WebSocket.OPEN
          )
            throw new Error('Relay identity or transport changed before emission.');
          this.ws.send(frame);
        },
        close: (code, reason) => this.ws?.close(code, reason),
      });
      if (!this.current(generation)) {
        await channel.transportClosed();
        return;
      }
      this.channel = channel;
      this.second = null;
      this.wirePhase = 'data';
      this.token?.secret.fill(0);
      this.token = null;
      this.clearTimers();
      await this.events.onReady?.(this.pin);
      if (!this.current(generation)) return;
      this.phase = 'connected';
      this.events.onPhase?.(this.phase);
      return;
    }
    throw new Error('Unexpected relay handshake state.');
  }

  /** Register outcome waiters before this call. A queued send never implies delivery. */
  send(message: ProtocolMessage): boolean {
    if (
      !this.connected ||
      !this.channel ||
      !this.identityCurrent() ||
      this.pendingSends >= relayV2.MAX_PENDING_SENDS
    )
      return false;
    let plaintext: Uint8Array;
    try {
      plaintext = new TextEncoder().encode(serialize(message));
    } catch {
      return false;
    }
    if (plaintext.length === 0 || plaintext.length > relayV2.MAX_PLAINTEXT) return false;
    ++this.pendingSends;
    const channel = this.channel;
    const job = channel
      .send(plaintext)
      .catch((error) => {
        // Local capacity/size refusals do not destroy the read half. Crypto/IO failures do.
        if (channel.closed) this.fail(error);
      })
      .finally(() => {
        --this.pendingSends;
      });
    this.outbound = this.outbound.then(() => job);
    return true;
  }

  private fail(error: unknown): void {
    if (!this.closing)
      this.events.onError?.(error instanceof Error ? error : new Error('Relay connection failed.'));
    this.failed = true;
    this.closing = true;
    ++this.generation;
    this.clearTimers();
    if (this.ws && this.ws.readyState < WebSocket.CLOSING)
      this.ws.close(relayV2.FAILURE_CLOSE.code, relayV2.FAILURE_CLOSE.reason);
    void this.finish();
  }

  private clearTimers(): void {
    if (this.deadline) clearTimeout(this.deadline);
    if (this.expiry) clearTimeout(this.expiry);
    this.deadline = null;
    this.expiry = null;
  }

  async close(): Promise<void> {
    if (!this.closing) {
      this.closing = true;
      this.drainingSend = true;
      this.clearTimers();
      this.first?.abort();
      this.second?.abort();
      this.first = null;
      this.second = null;
      this.token?.secret.fill(0);
      this.token = null;
      await this.outbound;
      if (this.channel && !this.channel.closed && this.identityCurrent() && !this.failed) {
        try {
          await this.channel.bye();
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            this.peerEnded,
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, 1000);
            }),
          ]);
          if (timer) clearTimeout(timer);
        } catch {
          /* A transport or identity failure is reported by the channel's stream verdict. */
        }
      }
      this.drainingSend = false;
      if (this.ws && this.ws.readyState < WebSocket.CLOSING) this.ws.close();
    }
    await this.finish();
  }

  private finish(): Promise<void> {
    if (this.finished) return this.finished;
    this.closing = true;
    ++this.generation;
    this.clearTimers();
    this.first?.abort();
    this.second?.abort();
    this.first = null;
    this.second = null;
    this.token?.secret.fill(0);
    this.token = null;
    this.finished = (async () => {
      await this.inbound;
      const end = this.channel ? await this.channel.transportClosed() : 'unclean';
      this.channel = null;
      this.phase = 'closed';
      this.events.onPhase?.(this.phase);
      this.events.onClose?.(end);
    })();
    return this.finished;
  }
}
