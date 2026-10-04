/**
 * ConnectionRoom: one Durable Object per machine (R2, #1197, ADR 0034).
 *
 * The room is named by the machine's room id (the hash of its public key, 32 hex
 * digits in the path), never by a code. It lives as long as the host's control
 * socket does and has NO time-to-live: the only clocks are the ones that bound
 * how long an UNADMITTED socket, a waiting client or a pending pipe may hold a
 * slot. A hibernating room costs nothing while idle; the edge answers the
 * literal text `ping` with `pong` without waking it.
 *
 * Sockets, all WebSockets, all admitted before anything else happens:
 * - host control (`/v2/host/<rid>`): at most one; the machine key holder. It
 *   changes the enrolled set (`enroll`, `revoke`), opens pairing windows
 *   (`pairing`) and is told when a client wants a pipe (`connected`).
 * - client (`/v2/client/<rid>`): an enrolled device key, or a device key
 *   presenting a ticket the host registered for a pairing window.
 * - pipe (`/v2/pipe/<rid>/<cid>`): the host's socket for one client connection,
 *   admitted by the machine key like the control socket.
 *
 * Admission: the Worker sends every new socket a fresh 32-byte nonce, valid for
 * that socket and ONE use; the endpoint answers `admit` with a signature over
 * `(role, room id, nonce)` (ADR 0034 section 4). Every refusal is the same close
 * (code 4400, reason `closed`), so a refusal says nothing about which check failed.
 *
 * Once a client socket and a pipe socket are paired the Worker sends `open` to
 * both and from then on forwards every text and binary message between exactly
 * those two sockets, UNPARSED and unlogged, never injecting anything of its own.
 * It looks at sizes only: text above `MAX_CONTROL_TEXT` bytes and binary above
 * `MAX_FRAME` are refused (the receiving library would refuse them as OVERSIZE).
 *
 * What this object stores: the enrolled device keys (public keys) and the live
 * pairing windows (hashes of tickets). What it keeps in memory: per-device
 * admission counters (reset if the object restarts). It never holds a session
 * id, a device name, a pairing secret, a key or any frame content.
 */

import {
  type Admit,
  CLOSE_CODE,
  CLOSE_REASON,
  type HostCommand,
  type HostOp,
  MAX_CONTROL_TEXT,
  MAX_FRAME,
  MAX_PAIRING_OFFERS,
  MAX_WORKER_TEXT,
  type Notice,
  b64u,
  decodeAdmit,
  decodeHostCommand,
  encodeNotice,
  fromB64u,
  isSmallOrderPublicKey,
  parseWorkerPath,
} from '@remi/shared/relay/index.ts';
import { type PairingWindow, clientProofHolds, hostProofHolds, matchTicket } from './admission.ts';
import { type LimitEnv, limit } from './limits.ts';
import { RateLimiter } from './rate-limiter.ts';

/** What the room uses of a Worker WebSocket (hibernation API). */
export interface RoomSocket {
  send(message: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

interface RoomStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list(options: { prefix: string; limit?: number }): Promise<Map<string, unknown>>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
  transaction<T>(closure: (txn: RoomStorage) => Promise<T>): Promise<T>;
}

/** What the room uses of its Durable Object state. */
export interface RoomState {
  readonly storage: RoomStorage;
  getWebSockets(tag?: string): RoomSocket[];
  acceptWebSocket(socket: RoomSocket, tags?: string[]): void;
  setWebSocketAutoResponse(pair: unknown): void;
}

export type RoomEnv = LimitEnv;

type Role = 'host' | 'client' | 'pipe';
/**
 * Where a socket is:
 * - `new`: upgraded, nonce sent, admission not yet received;
 * - `auth`: admission received and being checked (a second message is a refusal);
 * - `ctl`: the admitted host control socket;
 * - `wait`: an admitted client, no host connected;
 * - `pend`: an admitted client, the host told, its pipe not yet open;
 * - `open`: a client or pipe socket that is part of a pipe.
 */
type Stage = 'new' | 'auth' | 'ctl' | 'wait' | 'pend' | 'open';

/** Kept in the socket attachment, so it survives hibernation (2 KiB at most). */
interface Attachment {
  readonly r: Role;
  readonly st: Stage;
  /** Deadline in the room's clock, milliseconds; 0 for none. */
  readonly dl: number;
  /** Room id, lowercase hex. */
  readonly rid: string;
  /** Connection id, lowercase hex (clients and pipes). */
  readonly c?: string;
  /** Device key, lowercase hex (clients, once admitted). */
  readonly k?: string;
  /** The nonce, base64url, while the socket is `new`. */
  readonly n?: string;
}

interface Entry {
  readonly ws: RoomSocket;
  readonly att: Attachment;
}

const ROLES: readonly string[] = ['host', 'client', 'pipe'];
const STAGES: readonly string[] = ['new', 'auth', 'ctl', 'wait', 'pend', 'open'];

function readAttachment(ws: RoomSocket): Attachment | null {
  try {
    const v = ws.deserializeAttachment() as Partial<Attachment> | null;
    if (!v || !ROLES.includes(v.r as string) || !STAGES.includes(v.st as string)) return null;
    if (typeof v.dl !== 'number' || typeof v.rid !== 'string') return null;
    return v as Attachment;
  } catch {
    return null;
  }
}

const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const randomHex = (bytes: number): string => hex(crypto.getRandomValues(new Uint8Array(bytes)));
const unhex = (h: string): Uint8Array =>
  Uint8Array.from(h.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));

/** A peer's close code and reason, passed on only when a socket may legally send them. */
function passedOn(code: number, reason: string): [number, string] {
  const sendable = code === 1000 || (code >= 3000 && code <= 4999);
  return sendable && reason.length <= 123 ? [code, reason] : [CLOSE_CODE, CLOSE_REASON];
}

export class ConnectionRoom {
  protected readonly state: RoomState;
  protected readonly env: RoomEnv;
  private deviceLimiter: RateLimiter | null = null;

  constructor(state: RoomState, env: RoomEnv) {
    this.state = state;
    this.env = env;
    // The edge answers this exact text itself, so an idle socket does not wake the object.
    const Pair = (
      globalThis as unknown as {
        WebSocketRequestResponsePair: new (request: string, response: string) => unknown;
      }
    ).WebSocketRequestResponsePair;
    state.setWebSocketAutoResponse(new Pair('ping', 'pong'));
  }

  /** The room's clock. A seam: a test subclass moves it instead of waiting. */
  protected now(): number {
    return Date.now();
  }

  // -- Upgrade --

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
    const route = parseWorkerPath(new URL(request.url).pathname);
    if (!route) return new Response('Not found', { status: 404 });

    // A cap on unadmitted sockets, clients and host-side sockets counted apart: a stranger who
    // knows the room id can hold a slot only for the admission deadline, and cannot starve the
    // other class or make the host do any work.
    const hostSide = route.role !== 'client';
    const pending = this.entries().filter(
      ({ att }) => (att.st === 'new' || att.st === 'auth') && (att.r !== 'client') === hostSide,
    ).length;
    if (pending >= limit(this.env, hostSide ? 'MAX_PENDING_HOST' : 'MAX_PENDING_CLIENT')) {
      return new Response('Too many unadmitted sockets', {
        status: 429,
        headers: { 'Retry-After': '5' },
      });
    }

    const nonce = crypto.getRandomValues(new Uint8Array(32));
    const cid = route.role === 'client' ? randomHex(16) : route.cid;
    const tags =
      route.role === 'host'
        ? ['host']
        : [route.role, `${route.role === 'pipe' ? 'p' : 'c'}:${cid}`];
    const Pair = (globalThis as unknown as { WebSocketPair: new () => Record<number, RoomSocket> })
      .WebSocketPair;
    const pair = new Pair();
    const [clientSide, serverSide] = [pair[0] as RoomSocket, pair[1] as RoomSocket];
    const deadline = this.now() + limit(this.env, 'ADMIT_TIMEOUT_MS');
    this.state.acceptWebSocket(serverSide, tags);
    this.setAttachment(serverSide, {
      r: route.role,
      st: 'new',
      dl: deadline,
      rid: route.ridHex,
      n: b64u(nonce),
      ...(cid ? { c: cid } : {}),
    });
    this.notice(serverSide, { t: 'nonce', nonce });
    await this.arm(deadline);
    return new Response(null, { status: 101, webSocket: clientSide } as ResponseInit);
  }

  // -- Messages --

  async webSocketMessage(ws: RoomSocket, data: string | ArrayBuffer): Promise<void> {
    const att = readAttachment(ws);
    // A socket whose attachment this code does not understand (one a previous version of the
    // Worker left behind) is closed: nothing is guessed about it.
    if (!att) return this.shut(ws);
    try {
      switch (att.st) {
        case 'new':
          return await this.onAdmit(ws, att, data);
        case 'ctl':
          return await this.onCommand(ws, att, data);
        case 'open':
          return this.forward(ws, att, data);
        default:
          // `auth`, `wait` and `pend`: a client must wait for `open` before it says anything.
          return this.discard(ws, att);
      }
    } catch {
      this.discard(ws, att);
    }
  }

  async webSocketClose(ws: RoomSocket, code: number, reason: string): Promise<void> {
    const att = readAttachment(ws);
    if (att) this.gone(ws, att, code, reason);
  }

  async webSocketError(ws: RoomSocket): Promise<void> {
    const att = readAttachment(ws);
    if (att) this.gone(ws, att, 1006, '');
  }

  /** Closes every socket whose deadline passed, then arms the next deadline. */
  async alarm(): Promise<void> {
    const now = this.now();
    let next = Number.POSITIVE_INFINITY;
    for (const ws of this.state.getWebSockets()) {
      const att = readAttachment(ws);
      if (!att) {
        this.shut(ws);
        continue;
      }
      if (att.dl === 0) continue;
      if (att.dl <= now) this.discard(ws, att);
      else next = Math.min(next, att.dl);
    }
    if (next !== Number.POSITIVE_INFINITY) await this.arm(next);
  }

  // -- Admission --

  private async onAdmit(ws: RoomSocket, att: Attachment, data: string | ArrayBuffer) {
    if (typeof data !== 'string' || data.length > MAX_WORKER_TEXT || !att.n) return this.shut(ws);
    let admit: Admit;
    try {
      admit = decodeAdmit(data);
    } catch {
      return this.discard(ws, att);
    }
    // The nonce is spent by the first attempt, whatever its outcome: it leaves the attachment now.
    const nonce = fromB64u(att.n);
    const { n: _spent, ...rest } = att;
    this.setAttachment(ws, { ...rest, st: 'auth' });
    const rid = unhex(att.rid);
    const admitted =
      att.r === 'client'
        ? await this.admitClient(ws, rest, admit, rid, nonce)
        : (await hostProofHolds(rid, nonce, admit)) &&
          (att.r === 'host' ? await this.admitHost(ws, rest) : this.admitPipe(ws, rest));
    if (!admitted) this.discard(ws, { ...rest, st: 'auth' });
  }

  private async admitHost(ws: RoomSocket, att: Omit<Attachment, 'n'>): Promise<boolean> {
    const now = this.now();
    this.setAttachment(ws, { ...att, st: 'ctl', dl: 0 });
    // Only the holder of the machine key reaches here, so a new control socket replaces the old.
    for (const e of this.socketsTagged('host')) {
      if (e.ws !== ws && e.att.st === 'ctl') this.shut(e.ws);
    }
    this.notice(ws, { t: 'admitted' });
    // Waiting clients learn the host is back; every waiting or pending client is announced to it.
    let deadline = 0;
    for (const e of this.socketsTagged('client')) {
      if (e.att.st !== 'wait' && e.att.st !== 'pend') continue;
      if (e.att.st === 'wait') this.notice(e.ws, { t: 'host', up: true });
      deadline = now + limit(this.env, 'PIPE_TIMEOUT_MS');
      this.setAttachment(e.ws, { ...e.att, st: 'pend', dl: deadline });
      this.notice(ws, { t: 'connected', cid: e.att.c as string });
    }
    if (deadline > 0) await this.arm(deadline);
    return true;
  }

  private admitPipe(ws: RoomSocket, att: Omit<Attachment, 'n'>): boolean {
    const client = this.socketsTagged(`c:${att.c}`).find((e) => e.att.st === 'pend');
    if (!client) return false;
    this.setAttachment(ws, { ...att, st: 'open', dl: 0 });
    this.setAttachment(client.ws, { ...client.att, st: 'open', dl: 0 });
    this.notice(ws, { t: 'open' });
    this.notice(client.ws, { t: 'open' });
    return true;
  }

  /**
   * A client enters only on a signature by the device key it names, over the Worker's nonce, AND
   * either the key is enrolled or it presents a ticket the host registered. Cheap checks run before
   * the signature, and the per-device budget counts VERIFIED admissions only, so a flood of bad
   * signatures under someone else's key cannot spend that device's budget.
   */
  private async admitClient(
    ws: RoomSocket,
    att: Omit<Attachment, 'n'>,
    admit: Admit,
    rid: Uint8Array,
    nonce: Uint8Array,
  ): Promise<boolean> {
    const key = hex(admit.key);
    let window: string | null = null;
    if (admit.ticket) {
      window = await matchTicket(admit.ticket, await this.windows(), this.now());
      if (window === null) return false;
    } else if ((await this.state.storage.get(`dev:${key}`)) === undefined) {
      return false;
    }
    if (!(await clientProofHolds(rid, nonce, admit))) return false;
    if (!this.deviceAllowed(key)) return false;
    if (window !== null && !(await this.burnWindow(window))) return false;

    // From here to `setAttachment` nothing is awaited, so two admissions of one key cannot both stay.
    for (const e of this.socketsTagged('client')) {
      if (e.ws !== ws && e.att.k === key) this.discard(e.ws, e.att);
    }
    const admitted = this.socketsTagged('client').filter(
      (e) => e.ws !== ws && e.att.st !== 'new' && e.att.st !== 'auth',
    );
    if (admitted.length >= limit(this.env, 'MAX_CLIENTS')) return false;
    const up = this.hostUp();
    const deadline = this.now() + limit(this.env, up ? 'PIPE_TIMEOUT_MS' : 'WAIT_TIMEOUT_MS');
    this.setAttachment(ws, { ...att, st: up ? 'pend' : 'wait', k: key, dl: deadline });
    this.notice(ws, { t: 'admitted', hostUp: up });
    if (up) this.tellHost({ t: 'connected', cid: att.c as string });
    await this.arm(deadline);
    return true;
  }

  // -- The host's commands --

  private async onCommand(ws: RoomSocket, att: Attachment, data: string | ArrayBuffer) {
    if (typeof data !== 'string' || data.length > MAX_WORKER_TEXT) return this.discard(ws, att);
    let command: HostCommand;
    try {
      command = decodeHostCommand(data);
    } catch {
      return this.discard(ws, att);
    }
    switch (command.t) {
      case 'enroll':
        return this.ack(ws, 'enroll', await this.enroll(command.key));
      case 'revoke':
        await this.revoke(command.key);
        return this.ack(ws, 'revoke', true);
      case 'pairing':
        return this.ack(
          ws,
          'pairing',
          await this.openWindow(command.ticketHash, command.ttlSeconds),
        );
    }
  }

  private async enroll(key: Uint8Array): Promise<boolean> {
    if (isSmallOrderPublicKey(key)) return false;
    const row = `dev:${hex(key)}`;
    if ((await this.state.storage.get(row)) !== undefined) return true;
    const max = limit(this.env, 'MAX_ENROLLED');
    if ((await this.state.storage.list({ prefix: 'dev:', limit: max })).size >= max) return false;
    await this.state.storage.put(row, { at: this.now() });
    return true;
  }

  /** Removes the key and closes its live connections, so revocation holds at the edge. */
  private async revoke(key: Uint8Array): Promise<void> {
    const k = hex(key);
    await this.state.storage.delete(`dev:${k}`);
    for (const e of this.socketsTagged('client')) {
      if (e.att.k === k) this.discard(e.ws, e.att);
    }
  }

  private async windows(): Promise<PairingWindow[]> {
    return (await this.state.storage.get<PairingWindow[]>('pw')) ?? [];
  }

  /** Registers the hash of a ticket for `ttlSeconds`; at most `MAX_PAIRING_OFFERS` stay live. */
  private async openWindow(ticketHash: Uint8Array, ttlSeconds: number): Promise<boolean> {
    const now = this.now();
    const live = (await this.windows()).filter((w) => w.exp > now);
    if (live.length >= MAX_PAIRING_OFFERS) return false;
    live.push({ id: randomHex(8), h: b64u(ticketHash), exp: now + ttlSeconds * 1000 });
    await this.state.storage.put('pw', live);
    return true;
  }

  /**
   * Deletes a window in one storage transaction, true only for the call that found it, so two
   * presentations of one ticket admit at most one socket. The window is named by its handle:
   * no hash is compared here.
   */
  private burnWindow(id: string): Promise<boolean> {
    return this.state.storage.transaction(async (txn) => {
      const list = (await txn.get<PairingWindow[]>('pw')) ?? [];
      const at = list.findIndex((w) => w.id === id);
      if (at < 0) return false;
      list.splice(at, 1);
      await txn.put('pw', list);
      return true;
    });
  }

  private deviceAllowed(key: string): boolean {
    this.deviceLimiter ??= new RateLimiter(
      limit(this.env, 'LIMIT_DEVICE_ADMITS'),
      limit(this.env, 'LIMIT_WINDOW_MS'),
    );
    return this.deviceLimiter.check(key);
  }

  // -- Forwarding --

  private forward(ws: RoomSocket, att: Attachment, data: string | ArrayBuffer): void {
    const tooBig =
      typeof data === 'string' ? data.length > MAX_CONTROL_TEXT : data.byteLength > MAX_FRAME;
    const peer =
      tooBig || !att.c
        ? undefined
        : this.socketsTagged(`${att.r === 'client' ? 'p' : 'c'}:${att.c}`).find(
            (e) => e.att.st === 'open',
          );
    if (!peer) {
      this.discard(ws, att);
      return;
    }
    try {
      peer.ws.send(data);
    } catch {
      this.discard(ws, att);
    }
  }

  // -- Endings --

  /** A socket closed (by its peer, by an error or by this room): tell whoever depended on it. */
  private gone(ws: RoomSocket, att: Attachment, code: number, reason: string): void {
    if (att.r === 'host') {
      if (att.st === 'ctl') this.hostLeft(ws);
    } else if (att.r === 'client') {
      if (att.st === 'pend' && att.c) this.tellHost({ t: 'gone', cid: att.c });
      if (att.st === 'open' && att.c) {
        for (const e of this.socketsTagged(`p:${att.c}`))
          this.shut(e.ws, ...passedOn(code, reason));
      }
    } else if (att.st === 'open' && att.c) {
      for (const e of this.socketsTagged(`c:${att.c}`)) this.shut(e.ws, ...passedOn(code, reason));
    }
  }

  /** Without a control socket, pending clients go back to waiting. */
  private hostLeft(closed: RoomSocket): void {
    if (this.socketsTagged('host').some((e) => e.ws !== closed && e.att.st === 'ctl')) return;
    const deadline = this.now() + limit(this.env, 'WAIT_TIMEOUT_MS');
    let any = false;
    for (const e of this.socketsTagged('client')) {
      if (e.att.st !== 'pend') continue;
      any = true;
      this.setAttachment(e.ws, { ...e.att, st: 'wait', dl: deadline });
      this.notice(e.ws, { t: 'host', up: false });
    }
    if (any) void this.arm(deadline);
  }

  /** Close with the one generic failure close, and run what depended on the socket. */
  private discard(ws: RoomSocket, att: Attachment): void {
    this.shut(ws);
    this.gone(ws, att, CLOSE_CODE, CLOSE_REASON);
  }

  private shut(ws: RoomSocket, code: number = CLOSE_CODE, reason: string = CLOSE_REASON): void {
    try {
      ws.close(code, reason);
    } catch {
      try {
        ws.close(CLOSE_CODE, CLOSE_REASON);
      } catch {
        // already closed
      }
    }
  }

  // -- Helpers --

  private entries(): Entry[] {
    return this.state.getWebSockets().flatMap((ws) => {
      const att = readAttachment(ws);
      return att ? [{ ws, att }] : [];
    });
  }

  private socketsTagged(tag: string): Entry[] {
    return this.state.getWebSockets(tag).flatMap((ws) => {
      const att = readAttachment(ws);
      return att ? [{ ws, att }] : [];
    });
  }

  private hostUp(): boolean {
    return this.socketsTagged('host').some((e) => e.att.st === 'ctl');
  }

  private setAttachment(ws: RoomSocket, att: Attachment): void {
    ws.serializeAttachment(att);
  }

  private notice(ws: RoomSocket, notice: Notice): void {
    try {
      ws.send(encodeNotice(notice));
    } catch {
      // The socket is gone; its close handler runs what depended on it.
    }
  }

  private tellHost(notice: Notice): void {
    for (const e of this.socketsTagged('host')) if (e.att.st === 'ctl') this.notice(e.ws, notice);
  }

  private ack(ws: RoomSocket, op: HostOp, ok: boolean): void {
    this.notice(ws, { t: 'ack', op, ok });
  }

  /** Make sure the alarm fires no later than `deadline` (in the room's clock). */
  private async arm(deadline: number): Promise<void> {
    const at = Date.now() + Math.max(50, deadline - this.now());
    const current = await this.state.storage.getAlarm();
    if (current === null || at < current) await this.state.storage.setAlarm(at);
  }
}
