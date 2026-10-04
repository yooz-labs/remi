/**
 * Fake hosts and fake clients for the end-to-end tests. They speak to the REAL
 * Worker over REAL WebSockets and use the REAL relay v2 library from
 * `@remi/shared` (the public `relayV2` surface) for every signature, key and
 * frame: no crypto is mocked.
 *
 * The Worker control messages are written here as literal JSON, not with the
 * library's encoders (the library only has the Worker's side), which is what
 * pins the wire from the other end.
 */

import { relayV2 } from '@remi/shared';
import type { TestWorker } from './harness.ts';

type Signer = relayV2.Signer;
const { b64u, ridOf, signAdmission, systemRandom } = relayV2;

export const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** A machine or device identity made by the library's production key path. */
export interface Identity {
  readonly signer: Signer;
  readonly publicKey: Uint8Array;
}

export async function newIdentity(): Promise<Identity> {
  const { signer } = await relayV2.generateIdentity();
  return { signer, publicKey: signer.publicKey };
}

export interface Machine extends Identity {
  readonly rid: Uint8Array;
  readonly ridHex: string;
}

export async function newMachine(): Promise<Machine> {
  const id = await newIdentity();
  const rid = await ridOf(id.publicKey);
  return { ...id, rid, ridHex: hex(rid) };
}

/** A message the Worker or a peer sent: its text, or its bytes. */
export type Received = string | Uint8Array;

/** An async queue: `next` waits for a push, `quiet` says nothing arrives for a while. */
export class Mailbox<T> {
  private readonly items: T[] = [];
  private waiter: ((item: T) => void) | null = null;

  push(item: T): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(item);
    } else this.items.push(item);
  }

  next(timeoutMs = 3000): Promise<T> {
    const queued = this.items.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error('timed out waiting for a message'));
      }, timeoutMs);
      this.waiter = (item) => {
        clearTimeout(timer);
        resolve(item);
      };
    });
  }

  async quiet(ms = 300): Promise<boolean> {
    if (this.items.length > 0) return false;
    try {
      await this.next(ms);
      return false;
    } catch {
      return true;
    }
  }

  /** Everything queued so far, removed from the queue. */
  drain(): T[] {
    return this.items.splice(0);
  }
}

/** A WebSocket with an inbox, so a test can `await socket.text()`. */
export class Socket {
  private readonly inbox = new Mailbox<Received>();
  private tapped: ((m: Received) => void) | null = null;
  /** Resolves with the close code and reason, once the socket has closed. */
  readonly closed: Promise<{ code: number; reason: string }>;
  isClosed = false;

  private constructor(readonly ws: WebSocket) {
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (e) => {
      const m = typeof e.data === 'string' ? e.data : new Uint8Array(e.data as ArrayBuffer);
      if (this.tapped) this.tapped(m);
      else this.inbox.push(m);
    };
    this.closed = new Promise((resolve) => {
      ws.onclose = (e) => {
        this.isClosed = true;
        resolve({ code: e.code, reason: e.reason });
      };
    });
  }

  /** Open a WebSocket; rejects when the upgrade is refused (a status other than 101). */
  static open(url: string): Promise<Socket> {
    const ws = new WebSocket(url);
    return new Promise((resolve, reject) => {
      ws.onopen = () => resolve(new Socket(ws));
      ws.onerror = () => reject(new Error(`upgrade refused: ${url}`));
    });
  }

  /** Hand every message to `fn` from now on (those already queued first), instead of the inbox. */
  tap(fn: (m: Received) => void): void {
    for (const m of this.inbox.drain()) fn(m);
    this.tapped = fn;
  }

  next(timeoutMs = 3000): Promise<Received> {
    return this.inbox.next(timeoutMs);
  }

  async text(timeoutMs?: number): Promise<string> {
    const m = await this.next(timeoutMs);
    if (typeof m !== 'string') throw new Error('expected a text message, got binary');
    return m;
  }

  async json(timeoutMs?: number): Promise<Record<string, unknown>> {
    return JSON.parse(await this.text(timeoutMs)) as Record<string, unknown>;
  }

  async binary(timeoutMs?: number): Promise<Uint8Array> {
    const m = await this.next(timeoutMs);
    if (typeof m === 'string') throw new Error('expected a binary message, got text');
    return m;
  }

  sendText(text: string): void {
    this.ws.send(text);
  }

  sendBinary(bytes: Uint8Array): void {
    this.ws.send(bytes);
  }

  /** Nothing arrives within `ms`: an absence a test relies on, so it is bounded and short. */
  quiet(ms = 300): Promise<boolean> {
    return this.inbox.quiet(ms);
  }

  close(code = 1000): void {
    this.ws.close(code);
  }
}

/** The close every refusal and failure uses (ADR 0034 section 8). */
export const REFUSED = { code: 4400, reason: 'closed' } as const;

/** The status of an upgrade request, for a refusal before the WebSocket exists. */
export async function upgradeStatus(url: string): Promise<number> {
  const res = await fetch(url.replace(/^ws/, 'http'), {
    headers: {
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version': '13',
    },
    keepalive: false,
  } as RequestInit);
  await res.body?.cancel();
  return res.status;
}

export const hostUrl = (w: TestWorker, ridHex: string): string => `${w.wsUrl}/v2/host/${ridHex}`;
export const clientUrl = (w: TestWorker, ridHex: string): string =>
  `${w.wsUrl}/v2/client/${ridHex}`;
export const pipeUrl = (w: TestWorker, ridHex: string, cid: string): string =>
  `${w.wsUrl}/v2/pipe/${ridHex}/${cid}`;

/** The first message of every socket: the Worker's nonce. */
export async function readNonce(socket: Socket): Promise<Uint8Array> {
  const first = await socket.json();
  if (first['t'] !== 'nonce' || typeof first['n'] !== 'string') {
    throw new Error(`expected a nonce, got ${JSON.stringify(first)}`);
  }
  return relayV2.fromB64u(first['n']);
}

/** `{"t":"admit",...}` as the wire carries it. */
export function admitText(key: Uint8Array, signature: Uint8Array, ticket?: Uint8Array): string {
  return JSON.stringify({
    t: 'admit',
    k: b64u(key),
    s: b64u(signature),
    ...(ticket ? { a: b64u(ticket) } : {}),
  });
}

/** Read the nonce, sign it for `role`, and send the admission. */
export async function admit(
  socket: Socket,
  who: Identity,
  role: 'host' | 'client',
  rid: Uint8Array,
  ticket?: Uint8Array,
): Promise<void> {
  const nonce = await readNonce(socket);
  socket.sendText(
    admitText(who.publicKey, await signAdmission(who.signer, role, rid, nonce), ticket),
  );
}

/** The host's control socket, admitted. Notices and acknowledgments arrive in separate queues. */
export class FakeHost {
  private readonly notices = new Mailbox<Record<string, unknown>>();
  private readonly acks = new Mailbox<Record<string, unknown>>();
  private readonly pongs = new Mailbox<string>();

  private constructor(
    readonly worker: TestWorker,
    readonly machine: Machine,
    readonly control: Socket,
  ) {
    control.tap((m) => {
      if (m === 'pong') return this.pongs.push(m);
      const message = JSON.parse(String(m)) as Record<string, unknown>;
      (message['t'] === 'ack' ? this.acks : this.notices).push(message);
    });
  }

  static async start(worker: TestWorker, machine: Machine): Promise<FakeHost> {
    const control = await Socket.open(hostUrl(worker, machine.ridHex));
    await admit(control, machine, 'host', machine.rid);
    const reply = await control.json();
    if (reply['t'] !== 'admitted') throw new Error(`host not admitted: ${JSON.stringify(reply)}`);
    return new FakeHost(worker, machine, control);
  }

  /** Send a command and return the Worker's acknowledgment. */
  async command(message: object): Promise<Record<string, unknown>> {
    this.control.sendText(JSON.stringify(message));
    return this.acks.next();
  }

  enroll(devicePublicKey: Uint8Array): Promise<Record<string, unknown>> {
    return this.command({ t: 'enroll', k: b64u(devicePublicKey) });
  }

  revoke(devicePublicKey: Uint8Array): Promise<Record<string, unknown>> {
    return this.command({ t: 'revoke', k: b64u(devicePublicKey) });
  }

  /** Open a pairing window for a ticket: register `SHA-256(A)`. */
  async openWindow(pairingSecret: Uint8Array, ttl = 600): Promise<Record<string, unknown>> {
    const hash = await relayV2.admitTagHash(await relayV2.admitTag(pairingSecret));
    return this.command({ t: 'pairing', h: b64u(hash), ttl });
  }

  /** The edge ping: send the literal text `ping` and wait for the edge's `pong`. */
  async ping(): Promise<string> {
    this.control.sendText('ping');
    return this.pongs.next();
  }

  nextAck(timeoutMs?: number): Promise<Record<string, unknown>> {
    return this.acks.next(timeoutMs);
  }

  /** The next notice that is not an acknowledgment. */
  notice(timeoutMs?: number): Promise<Record<string, unknown>> {
    return this.notices.next(timeoutMs);
  }

  quiet(ms?: number): Promise<boolean> {
    return this.notices.quiet(ms);
  }

  /** The next client the Worker announces. */
  async nextConnection(): Promise<string> {
    const notice = await this.notice();
    if (notice['t'] !== 'connected' || typeof notice['c'] !== 'string') {
      throw new Error(`expected connected, got ${JSON.stringify(notice)}`);
    }
    return notice['c'];
  }

  /** Open and admit the pipe socket for a connection; resolves once the pipe is open. */
  async openPipe(cid: string): Promise<Socket> {
    const pipe = await Socket.open(pipeUrl(this.worker, this.machine.ridHex, cid));
    await admit(pipe, this.machine, 'host', this.machine.rid);
    const open = await pipe.json();
    if (open['t'] !== 'open') throw new Error(`pipe not open: ${JSON.stringify(open)}`);
    return pipe;
  }
}

/** A client socket, admitted (and, when the host is up, told so). */
export async function connectClient(
  worker: TestWorker,
  machine: Machine,
  device: Identity,
  ticket?: Uint8Array,
): Promise<{ socket: Socket; hostUp: boolean }> {
  const socket = await Socket.open(clientUrl(worker, machine.ridHex));
  await admit(socket, device, 'client', machine.rid, ticket);
  const reply = await socket.json();
  if (reply['t'] !== 'admitted') throw new Error(`client not admitted: ${JSON.stringify(reply)}`);
  return { socket, hostUp: reply['up'] === true };
}

/** What the debug entry reports about a room. */
export interface RoomState {
  storage: Record<string, unknown>;
  alarm: number | null;
  sockets: ({ r: string; st: string; dl: number; k?: string; c?: string; n?: string } | null)[];
  boot: string;
  skewMs: number;
}

export async function roomState(worker: TestWorker, ridHex: string): Promise<RoomState> {
  const res = await fetch(`${worker.url}/__room/${ridHex}/__state`, {
    keepalive: false,
  } as RequestInit);
  return (await res.json()) as RoomState;
}

export async function roomSeen(
  worker: TestWorker,
  ridHex: string,
): Promise<{ role: string; stage: string; kind: 'text' | 'binary'; bytes: string }[]> {
  const res = await fetch(`${worker.url}/__room/${ridHex}/__seen`, {
    keepalive: false,
  } as RequestInit);
  return (await res.json()) as never;
}

export async function advanceClock(worker: TestWorker, ridHex: string, ms: number): Promise<void> {
  await fetch(`${worker.url}/__room/${ridHex}/__clock`, {
    method: 'POST',
    body: JSON.stringify({ advanceMs: ms }),
    keepalive: false,
  } as RequestInit);
}

/** Hold the next `size` ticket admissions just before the burn, then release them together. */
export async function holdBurns(worker: TestWorker, ridHex: string, size: number): Promise<void> {
  await fetch(`${worker.url}/__room/${ridHex}/__barrier`, {
    method: 'POST',
    body: JSON.stringify({ size }),
    keepalive: false,
  } as RequestInit);
}

export async function runAlarm(worker: TestWorker, ridHex: string): Promise<void> {
  await fetch(`${worker.url}/__room/${ridHex}/__alarm`, {
    method: 'POST',
    keepalive: false,
  } as RequestInit);
}

export { systemRandom };
