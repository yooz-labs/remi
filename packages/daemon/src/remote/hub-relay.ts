/** Hub-owned v2 room. The Worker admits sockets; this host alone grants application authority. */
import {
  type AgentStatus,
  MESSAGE_DIRECTION,
  type Message,
  MessageIdTracker,
  type NativeAnswerMessage,
  type ProtocolMessage,
  type RelayDeviceRevokeResponseMessage,
  type SessionListRequestMessage,
  type SessionListResponseMessage,
  type UnlockedIdentity,
  createAgentOutput,
  createAnswerResult,
  createError,
  createSecurePushRegisterResponse,
  createSecurePushUnregisterResponse,
  createSessionListResponse,
  createSessionUpdate,
  deserialize,
  fromBase64,
  generateId,
  now,
  relayV2,
  serialize,
} from '@remi/shared';
import type { AdapterEvents, ConnectionAdapter } from '../adapters/connection-adapter.ts';
import {
  DuplicateKeyError,
  type IdentityStore,
  validatePublicKey,
} from '../auth/identity-store.ts';
import { sanitizePushPreferences } from '../notifications/push-preferences.ts';
import { type SecurePushAuthority, SecurePushStore } from '../notifications/secure-push-store.ts';
import { AnswerResults } from '../server/answer-results.ts';
import { bindConnectionId } from '../server/client-message-events.ts';
import { Connection } from '../server/connection.ts';
import type { RelayLocalControl } from '../server/websocket-server.ts';
import type { SessionRegistryFile } from '../session/session-registry-file.ts';
import { normalizeSecureRegistration } from '../storage/secure-push-subscriptions.ts';
import { ChildProxy } from './child-proxy.ts';
import { RelayDeviceStore } from './relay-device-store.ts';
import { legacyRelayUrlNotice, relayWorkerUrl } from './relay-url.ts';
import { WorkerControl } from './worker-control.ts';

type Offer = {
  id: string;
  owner: string;
  requestId: string;
  policy: relayV2.PairingOffer;
  reserved?: string;
  confirmed?: ((accept: boolean) => void) | undefined;
  fingerprint?: string;
  timer: ReturnType<typeof setTimeout>;
};
const keyBase64 = (key: Uint8Array) => Buffer.from(key).toString('base64');
/**
 * How long an orderly close waits, after the hub's BYE, for the far side to close the pipe
 * (#1225). Closing right after the BYE can reset the connection (Bun 1.3.11's client close), and
 * a reset can make the Worker lose what it had not read yet, the BYE included. A conforming client
 * closes as soon as it has the hub's BYE (the web client: `relay-machine-channel.ts`), which takes
 * one Worker round trip; 2 s leaves room for a slow link and a loaded machine, and bounds what a
 * peer that never closes costs: a revoke, a shutdown or a refused frame waits this long at most.
 */
export const ORDERLY_CLOSE_GRACE_MS = 2000;
/** Resolve when `promise` does or after `ms`, whichever is first. Never rejects. */
async function waitAtMost(promise: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    promise.catch(() => {}),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  clearTimeout(timer);
}
type Peer = {
  answers: AnswerResults;
  answerIds: MessageIdTracker;
  revisions: ReadonlyMap<string, number>;
  orderlyClosing: boolean;
  transportClosing: boolean;
  /** The hub asked to close this pipe (its own close or a channel failure), for the close log. */
  hubClosed: boolean;
  /** Resolves once the pipe has closed or failed, whichever side ended it. */
  gone: Promise<void>;
  markGone: () => void;
  ending?: Promise<void>;
  closing?: Promise<void>;
  pendingFrames: number;
  pendingApplications: number;
  pendingSends: number;
  sendNotice: 'PAYLOAD_TOO_LARGE' | 'SEND_QUEUE_FULL' | undefined;
  historyOverflow: boolean;
  listing: boolean;
  cid: string;
  ws: WebSocket;
  cancelled: boolean;
  stage: 'admit' | 'hello' | 'auth' | 'confirm' | 'ready';
  step1?: relayV2.HostStep1;
  step2?: relayV2.HostStep2;
  channel?: relayV2.Channel;
  connection?: Connection;
  proxy?: ChildProxy;
  key?: string;
  pushAuthority?: SecurePushAuthority;
  authorityVerdict?: 'fault' | 'revoked' | undefined;
  pushMutation?: number;
  revision?: number;
  timer: ReturnType<typeof setTimeout>;
  offers: readonly Offer[];
  policy: readonly relayV2.PairingOffer[];
  receiveTail: Promise<void>;
  historyFailed: Set<string>;
  hubLists: Map<string, (response: SessionListResponseMessage) => void>;
};
export interface HubRelayConfig {
  relayUrl: string;
  identity: UnlockedIdentity;
  trust: IdentityStore;
  dir: string;
  registry: SessionRegistryFile;
  /**
   * Whether this daemon can actually send a secure push right now (#1200, B5). A subscription
   * is acknowledged only while it can be served: enrolling a device latches legacy push off for
   * good, so a phone registered with no sender would receive nothing at all. Production wires
   * the existence of the secure push service (`cli.ts`); absent, registration is not gated.
   */
  securePushSender?: () => boolean;
  random?: relayV2.Rng;
  ephemeral?: () => Promise<relayV2.EcPair>;
  log?: (message: string) => void;
}
export class HubRelay implements ConnectionAdapter, RelayLocalControl {
  readonly type = 'relay';
  private running = false;
  private control: WorkerControl | undefined;
  private machine: relayV2.Signer | undefined;
  private rid: Uint8Array = new Uint8Array();
  private readonly peers = new Map<string, Peer>();
  /** Peers whose close is still running (a pipe in its orderly grace, #1225), for `stop()`. */
  private readonly closingPeers = new Set<Peer>();
  private readonly offers = new Map<string, Offer>();
  private readonly locals = new Map<string, (text: string) => void>();
  private readonly devices: RelayDeviceStore;
  private readonly subscriptions: SecurePushStore;
  private stateTail: Promise<unknown> = Promise.resolve();
  private readonly revisions = new Map<string, number>();
  private reconnect: ReturnType<typeof setTimeout> | undefined;
  private stable: ReturnType<typeof setTimeout> | undefined;
  private attempts = 0;
  constructor(
    private readonly cfg: HubRelayConfig,
    private readonly events: Partial<AdapterEvents> = {},
  ) {
    const legacyNotice = legacyRelayUrlNotice(cfg.relayUrl);
    if (legacyNotice) throw new Error(legacyNotice);
    if (
      (cfg.random ?? relayV2.systemRandom) !== relayV2.systemRandom ||
      cfg.ephemeral !== undefined
    )
      throw new Error('RELAY_PRODUCTION_CRYPTO_REQUIRED');
    this.devices = new RelayDeviceStore(cfg.dir, cfg.trust);
    this.subscriptions = new SecurePushStore(cfg.dir, cfg.trust);
  }
  get connectionCount(): number {
    return [...this.peers.values()].filter((peer) => peer.stage === 'ready' && this.current(peer))
      .length;
  }
  get isRunning(): boolean {
    return this.running;
  }
  private log(message: string): void {
    this.cfg.log?.(message);
  }
  async start(): Promise<void> {
    if (this.running) throw new Error('RELAY_ALREADY_STARTED');
    this.machine = await relayV2.signerFromKey(
      this.cfg.identity.privateKey,
      new Uint8Array(fromBase64(this.cfg.identity.publicKeyRaw)),
    );
    this.rid = await relayV2.ridOf(this.machine.publicKey);
    this.running = true;
    void this.connect();
  }
  private url(role: 'host' | 'pipe', cid?: string): string {
    return relayWorkerUrl(this.cfg.relayUrl, role, this.rid, cid);
  }
  private async connect(): Promise<void> {
    if (!this.running || !this.machine) return;
    const control = new WorkerControl(
      this.url('host'),
      this.machine,
      this.rid,
      (cid) => {
        if (this.control === control) this.openPeer(cid);
      },
      (cid) => {
        const peer = this.peers.get(cid);
        if (peer) void this.transportEnd(peer);
      },
      () => {
        if (this.control === control) this.lostControl();
      },
    );
    this.control = control;
    try {
      await control.start();
      if (!this.running || this.control !== control) {
        control.stop();
        return;
      }
      await this.serial(async () => {
        // Reconnect enrollment shares the grant/revoke ordering domain. Never
        // reenroll a captured entry after its durable revocation has completed.
        for (const device of this.devices.list()) {
          if (!this.running || this.control !== control) return;
          const revision = this.revisions.get(device.publicKey) ?? 0;
          if (!this.devices.isEnrolled(device.publicKey)) continue;
          const key = new Uint8Array(fromBase64(device.publicKey));
          if (!(await control.command({ t: 'enroll', key })))
            throw new Error('RELAY_ENROLL_REFUSED');
          if (!this.running || this.control !== control) return;
          if (
            revision !== (this.revisions.get(device.publicKey) ?? 0) ||
            !this.devices.isEnrolled(device.publicKey)
          ) {
            if (!(await control.command({ t: 'revoke', key })))
              throw new Error('RELAY_REVOKE_UNCERTAIN');
          }
        }
      });
      if (!this.running || this.control !== control) return;
      this.stable = setTimeout(() => {
        if (this.control === control) this.attempts = 0;
      }, 30000);
      this.log('Relay control admitted');
    } catch {
      control.stop();
      if (this.control === control) this.lostControl();
    }
  }
  private lostControl(): void {
    this.control = undefined;
    if (this.stable) clearTimeout(this.stable);
    for (const peer of this.peers.values()) void this.closePeer(peer);
    // Offers are tied to the admitted control generation; secrets never survive reconnect.
    for (const offer of [...this.offers.values()]) this.discard(offer);
    if (!this.running || this.reconnect) return;
    const bytes = relayV2.systemRandom(4);
    const unit = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0) / 0xffffffff;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.attempts++, 5)) * (0.75 + unit * 0.5);
    this.log('Relay control disconnected; reconnect scheduled');
    this.reconnect = setTimeout(() => {
      this.reconnect = undefined;
      void this.connect();
    }, delay);
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.stateTail.then(operation);
    this.stateTail = result.catch(() => {});
    return result;
  }
  private active(peer: Peer): boolean {
    return this.running && !peer.cancelled && this.peers.get(peer.cid) === peer;
  }
  private enrolled(peer: Peer): boolean {
    try {
      return !!peer.key && this.devices.isEnrolled(peer.key);
    } catch {
      this.log('Relay authorization store unreadable; routing refused');
      return false;
    }
  }
  private current(peer: Peer): boolean {
    const current =
      this.active(peer) &&
      !peer.transportClosing &&
      !!peer.key &&
      peer.revision === (this.revisions.get(peer.key) ?? 0) &&
      (peer.pushAuthority
        ? this.authorityCurrent(peer, peer.pushAuthority)
        : peer.stage !== 'ready') &&
      (peer.stage !== 'ready' || this.enrolled(peer));
    // Every READY check retires a refused peer, including checks after awaits and
    // connection queries (#1224). Otherwise a transient store fault can consume
    // one request while leaving its ordered channel usable. Do not await closure:
    // the receive queue must remain free to drain the counterpart's reply BYE.
    // An existing transport close owns its uncertainty and cleanup instead.
    if (!current && peer.stage === 'ready' && this.active(peer) && !peer.transportClosing)
      void this.closePeer(peer, true);
    return current;
  }
  /**
   * Whether the peer's captured authority is still current (#1201). A revoked grant and an
   * unreadable store (lock contention, a damaged file) both answer false, and both close the
   * admitted READY peer through `current`. That is deliberate for the store fault too:
   * the channel is ordered and complete, so refusing one frame and staying open would drop it
   * silently and leave the client's state diverged, while a close makes the client reconnect
   * and resync. A reconnect re-captures authority under the same lock, so a persistent fault
   * keeps the peer out and a transient one recovers. Only the log tells them apart, once per
   * change of verdict, so the check that runs on every outbound frame cannot flood it.
   */
  private authorityCurrent(peer: Peer, authority: SecurePushAuthority): boolean {
    let fault: unknown;
    let faulted = false;
    const current = this.subscriptions.isCurrentAuthority(authority, (error) => {
      faulted = true;
      fault = error;
    });
    const verdict = current ? undefined : faulted ? 'fault' : 'revoked';
    if (verdict !== peer.authorityVerdict) {
      peer.authorityVerdict = verdict;
      if (verdict === 'fault')
        this.log(
          `Relay authority store unreadable (${fault instanceof Error ? fault.name : typeof fault}); failing closed, not a revocation`,
        );
      else if (verdict === 'revoked') this.log('Relay authority no longer current; failing closed');
    }
    return current;
  }
  private openPeer(cid: string): void {
    if (!this.running || !this.machine || this.peers.has(cid)) return;
    if ([...this.peers.values()].filter((peer) => peer.stage !== 'ready').length >= 8) {
      this.log('Relay handshake capacity refused');
      return;
    }
    let markGone: () => void = () => {};
    const gone = new Promise<void>((resolve) => {
      markGone = resolve;
    });
    const ws = new WebSocket(this.url('pipe', cid));
    ws.binaryType = 'arraybuffer';
    const peer: Peer = {
      cid,
      ws,
      cancelled: false,
      answers: new AnswerResults(),
      answerIds: new MessageIdTracker(),
      orderlyClosing: false,
      transportClosing: false,
      hubClosed: false,
      gone,
      markGone,
      revisions: new Map(this.revisions),
      pendingFrames: 0,
      pendingApplications: 0,
      pendingSends: 0,
      sendNotice: undefined,
      historyOverflow: false,
      listing: false,
      stage: 'admit',
      timer: setTimeout(() => {
        void this.closePeer(peer);
      }, relayV2.HANDSHAKE_TIMEOUT_MS),
      offers: [],
      policy: [],
      receiveTail: Promise.resolve(),
      historyFailed: new Set(),
      hubLists: new Map(),
    };
    this.peers.set(cid, peer);
    let pipeStage = 'nonce';
    ws.onmessage = (event) => {
      const size =
        typeof event.data === 'string'
          ? new TextEncoder().encode(event.data).length
          : event.data instanceof ArrayBuffer
            ? event.data.byteLength
            : Number.POSITIVE_INFINITY;
      if (size > (peer.stage === 'ready' ? relayV2.MAX_FRAME : relayV2.MAX_WORKER_TEXT)) {
        void this.closePeer(peer);
        return;
      }
      if (++peer.pendingFrames > 64) {
        void this.closePeer(peer);
        return;
      }
      peer.receiveTail = peer.receiveTail
        .then(async () => {
          // Three checks keep a frame from acting after this peer stops being current: this
          // `active()` guard, the `current()` check after the ready stage's receive and the one
          // at the top of `route()`. They are redundant on purpose; at the ready stage removing
          // this guard alone changes nothing a test can see. The branch below exists for a peer
          // that is no longer enrolled: the ready stage's enrollment check would refuse its reply
          // BYE before the channel could read it.
          if (!this.active(peer)) {
            // In an orderly close's grace (#1225) the peer's reply BYE still arrives: open it so
            // the stream ends clean. Only the channel reads it; nothing after the hub's BYE is
            // acted on, a data frame here is opened and dropped, and a frame that fails to open
            // fails the channel, which closes the pipe with the failure close.
            if (peer.orderlyClosing && peer.channel && typeof event.data !== 'string')
              await peer.channel.receive(new Uint8Array(event.data)).catch(() => undefined);
            return;
          }
          if (peer.stage === 'admit') {
            const notice = relayV2.decodeNotice(event.data);
            if (pipeStage === 'nonce' && notice.t === 'nonce') {
              pipeStage = 'open';
              const signature = await relayV2.signAdmission(
                this.machine as relayV2.Signer,
                'host',
                this.rid,
                notice.nonce,
              );
              if (this.active(peer))
                ws.send(
                  relayV2.encodeAdmit({
                    key: (this.machine as relayV2.Signer).publicKey,
                    signature,
                  }),
                );
            } else if (pipeStage === 'open' && notice.t === 'open') peer.stage = 'hello';
            else throw new Error('RELAY_PIPE_ORDER');
          } else if (peer.stage === 'hello') {
            const offers = [...this.offers.values()].filter(
              (offer) => !offer.reserved && relayV2.isLiveOffer(offer.policy, Date.now()),
            );
            peer.offers = Object.freeze([...offers]);
            peer.policy = Object.freeze(offers.map((offer) => Object.freeze({ ...offer.policy })));
            const step = await relayV2.hostOnHello(
              { machine: this.machine as relayV2.Signer, random: relayV2.systemRandom },
              event.data,
              { offers: peer.policy, isEnrolled: (key) => this.devices.isEnrolled(keyBase64(key)) },
              Date.now(),
            );
            if (!this.active(peer)) {
              step.abort();
              return;
            }
            peer.step1 = step;
            peer.stage = 'auth';
            ws.send(step.helloAck);
          } else if (peer.stage === 'auth') {
            const step = await peer.step1?.onAuth(
              event.data,
              { offers: peer.policy, isEnrolled: (key) => this.devices.isEnrolled(keyBase64(key)) },
              Date.now(),
            );
            if (!step) throw new Error('RELAY_PIPE_ORDER');
            if (!this.active(peer)) {
              step.abort();
              return;
            }
            peer.step2 = step;
            if (relayV2.isSmallOrderPublicKey(step.devicePublicKey))
              throw new Error('RELAY_INVALID_KEY');
            peer.key = keyBase64(step.devicePublicKey);
            peer.revision = peer.revisions.get(peer.key) ?? 0;
            let offer: Offer | undefined;
            if (step.offerIndex !== null) {
              offer = peer.offers[step.offerIndex];
              if (
                !offer ||
                this.offers.get(offer.id) !== offer ||
                offer.reserved ||
                !relayV2.isLiveOffer(offer.policy, Date.now()) ||
                !this.locals.has(offer.owner)
              )
                throw new Error('RELAY_OFFER_GONE');
              offer.reserved = cid;
              offer.fingerprint = step.fingerprint;
              peer.stage = 'confirm';
              clearTimeout(peer.timer);
              peer.timer = setTimeout(
                () => {
                  void this.closePeer(peer);
                },
                Math.min(relayV2.PAIR_CONFIRM_TIMEOUT_MS, offer.policy.expiresAtMs - Date.now()),
              );
              const accepted = new Promise<boolean>((resolve) => {
                (offer as Offer).confirmed = resolve;
              });
              this.local(offer.owner, {
                t: 'compare',
                id: offer.requestId,
                offerId: offer.id,
                connectionId: cid,
                fingerprint: step.fingerprint,
                deviceName: step.deviceName,
              });
              if (
                !(await accepted) ||
                !this.current(peer) ||
                !relayV2.isLiveOffer(offer.policy, Date.now())
              )
                throw new Error('RELAY_PAIR_DENIED');
              offer.policy = { ...offer.policy, used: true };
            }
            await this.serial(async () => {
              if (!this.current(peer)) throw new Error('RELAY_CANCELLED');
              await validatePublicKey(peer.key as string);
              if (!this.current(peer)) throw new Error('RELAY_CANCELLED');
              if (offer) {
                try {
                  await this.cfg.trust.addAuthorizedKey(peer.key as string, step.deviceName, () =>
                    this.current(peer),
                  );
                } catch (e) {
                  if (!(e instanceof DuplicateKeyError)) throw e;
                }
                if (!this.current(peer)) throw new Error('RELAY_CANCELLED');
                await this.devices.add(
                  peer.key as string,
                  step.deviceName,
                  () =>
                    this.current(peer) &&
                    this.cfg.trust
                      .loadAuthorizedKeys()
                      .keys.some((key) => key.publicKey === peer.key),
                );
                // Capture before edge enrollment/READY awaits. A same-key
                // regrant or re-pair cannot refresh this channel's authority.
                const authority = this.subscriptions.captureAuthority(peer.key as string);
                if (!authority) throw new Error('RELAY_CANCELLED');
                peer.pushAuthority = authority;
                if (
                  !this.current(peer) ||
                  !(await this.control?.command({ t: 'enroll', key: step.devicePublicKey }))
                )
                  throw new Error('RELAY_ENROLL_UNCERTAIN');
              } else {
                const authority = this.subscriptions.captureAuthority(peer.key as string);
                if (!authority) throw new Error('RELAY_REVOKED');
                peer.pushAuthority = authority;
              }
              if (!this.current(peer) || !this.enrolled(peer)) throw new Error('RELAY_CANCELLED');
              const ready = await step.ready(Date.now(), {
                emit: (frame) => {
                  if (
                    !this.current(peer) &&
                    !(peer.orderlyClosing && frame[0] === relayV2.TYPE_BYE)
                  ) {
                    void this.closePeer(peer, true);
                    throw new Error('RELAY_CANCELLED');
                  }
                  ws.send(frame);
                },
                close: (code, reason) => {
                  if (ws.readyState < WebSocket.CLOSING) peer.hubClosed = true;
                  ws.close(code, reason);
                },
              });
              if (!this.current(peer) || !this.enrolled(peer)) {
                await ready.channel.transportClosed();
                return;
              }
              peer.channel = ready.channel;
              peer.stage = 'ready';
              clearTimeout(peer.timer);
              this.install(peer);
              ws.send(ready.ready);
              if (offer) {
                this.local(offer.owner, {
                  t: 'paired',
                  id: offer.requestId,
                  fingerprint: step.fingerprint,
                });
                this.discard(offer);
              }
            });
          } else if (peer.stage === 'ready') {
            if (typeof event.data === 'string') throw new Error('RELAY_TEXT_AFTER_READY');
            if (!peer.key || !this.devices.isEnrolled(peer.key)) throw new Error('RELAY_REVOKED');
            const bytes = await peer.channel?.receive(new Uint8Array(event.data));
            if (!this.current(peer) || bytes === undefined) return;
            if (bytes === null) {
              await this.closePeer(peer, true);
              return;
            }
            // Preserve a leading BOM so strict JSON validation sees the original bytes (#1201).
            const message = deserialize(
              new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
            );
            if (!message || MESSAGE_DIRECTION[message.type] === 'd2c')
              throw new Error('RELAY_INVALID_MESSAGE');
            if (peer.pendingApplications >= 32) {
              this.sendRaw(
                peer.cid,
                createError('BUSY', 'Relay application request capacity reached', {
                  requestId: message.id,
                }),
              );
              return;
            }
            peer.pendingApplications++;
            // Decrypt in order; read-only queries/child waits cannot hold up decisions.
            void this.route(peer, message)
              .catch(() => {
                void this.closePeer(peer);
              })
              .finally(() => {
                peer.pendingApplications--;
              });
          } else throw new Error('RELAY_PIPE_ORDER');
        })
        .catch(() => {
          void this.closePeer(peer);
        })
        .finally(() => {
          peer.pendingFrames--;
        });
    };
    ws.onerror = () => {
      peer.markGone();
      void this.closePeer(peer);
    };
    ws.onclose = (event) => {
      peer.markGone();
      // Who ended the pipe and how this side saw the close (#1225), in a fixed form with no
      // connection id (#1200).
      this.log(
        `Relay pipe closed by ${peer.hubClosed ? 'the hub' : 'the far side'} (${event.code}${event.wasClean ? '' : ', unclean'})`,
      );
      void this.transportEnd(peer);
    };
  }
  private transportEnd(peer: Peer): Promise<void> {
    if (peer.ending) return peer.ending;
    // A ready pipe may have BYE in the wrapper queue, outside Channel.recvTail.
    // Stop application effects immediately, then consume that authenticated tail.
    peer.transportClosing = true;
    if (peer.stage !== 'ready') void this.closePeer(peer);
    peer.ending = (async () => {
      await peer.receiveTail;
      const verdict = await peer.channel?.transportClosed();
      if (verdict === 'unclean' || verdict === 'failed')
        this.log(`Relay delivery uncertain: ${verdict}`);
      await this.closePeer(peer);
    })();
    return peer.ending;
  }
  private install(peer: Peer): void {
    peer.proxy = new ChildProxy(
      this.cfg.registry,
      peer.key as string,
      (message) => {
        this.sendRaw(peer.cid, message);
      },
      (sessionId) => {
        this.sendRaw(
          peer.cid,
          createError('SESSION_NOT_FOUND', 'Child connection closed; pending delivery uncertain', {
            sessionId,
          }),
        );
      },
      () => this.current(peer),
    );
    peer.connection = new Connection(
      {
        get readyState() {
          return peer.cancelled ? WebSocket.CLOSED : WebSocket.OPEN;
        },
        send: (text) => {
          const message = deserialize(text);
          if (message) this.sendRaw(peer.cid, message);
        },
        close: () => {
          void this.closePeer(peer, true);
        },
      },
      {
        ...bindConnectionId(peer.cid, this.events),
        onConnect: () =>
          this.events.onConnect?.(peer.cid, {
            adapterType: 'relay',
            displayName: 'enrolled-device',
            platformData: { kind: 'relay', code: null },
          }),
        onDisconnect: (reason) => this.events.onDisconnect?.(peer.cid, reason),
      },
      { skipHelloAck: true },
      peer.cid,
    );
  }
  private async sessionList(peer: Peer, request: SessionListRequestMessage): Promise<void> {
    const deadline = Date.now() + 5000;
    let localTimedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const local = new Promise<SessionListResponseMessage>((resolve) => {
      peer.hubLists.set(request.id, resolve);
      timer = setTimeout(() => {
        localTimedOut = true;
        resolve(createSessionListResponse([], request.id));
      }, 5000);
    });
    this.events.onSessionListRequest?.(peer.cid, request.id, request.includeExternal ?? false);
    const localResponse = await local;
    if (timer) clearTimeout(timer);
    peer.hubLists.delete(request.id);
    if (!this.current(peer) || !peer.proxy) return;
    const all = this.cfg.registry.listLive();
    const live = all.slice(0, 32);
    const sessions = new Map(localResponse.sessions.map((session) => [session.sessionId, session]));
    let failed = localTimedOut || all.length > live.length;
    // Eight private child handshakes at once, finite five-second list waits.
    for (let offset = 0; offset < live.length; offset += 8) {
      const batch = Promise.allSettled(
        live.slice(offset, offset + 8).map(async (entry) => ({
          entry,
          response: await peer.proxy?.list(entry.sessionId, request.includeExternal ?? false),
        })),
      );
      let batchTimer: ReturnType<typeof setTimeout> | undefined;
      const responses = await Promise.race([
        batch,
        new Promise<null>((resolve) => {
          batchTimer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()));
        }),
      ]);
      if (batchTimer) clearTimeout(batchTimer);
      if (responses === null) {
        failed = true;
        break;
      }
      if (!this.current(peer)) return;
      for (const result of responses) {
        if (result.status !== 'fulfilled' || !result.value.response) {
          failed = true;
          continue;
        }
        const { entry, response } = result.value;
        const current = this.cfg.registry
          .listLive()
          .find((item) => item.sessionId === entry.sessionId);
        if (current?.pid !== entry.pid || current.wsPort !== entry.wsPort) {
          failed = true;
          continue;
        }
        for (const session of response.sessions) {
          if (
            session.sessionId === entry.sessionId ||
            (request.includeExternal && session.source !== 'daemon')
          )
            sessions.set(session.sessionId, session);
        }
      }
    }
    if (failed)
      this.sendRaw(
        peer.cid,
        createError(
          'CHILD_LIST_PARTIAL',
          'Session list is partial: one or more child sessions could not be verified',
          { requestId: request.id },
        ),
      );
    this.sendRaw(peer.cid, createSessionListResponse([...sessions.values()], request.id), true);
  }
  private nextPushMutation(peer: Peer): number {
    const current = peer.pushMutation ?? 0;
    if (current >= Number.MAX_SAFE_INTEGER) throw new Error('RELAY_REQUEST_CAPACITY');
    peer.pushMutation = current + 1;
    return peer.pushMutation;
  }
  private async route(peer: Peer, message: ProtocolMessage): Promise<void> {
    if (!this.current(peer) || !this.devices.isEnrolled(peer.key as string))
      throw new Error('RELAY_REVOKED');
    if (message.type === 'native_answer') {
      await this.routeNativeAnswer(peer, message);
      return;
    }
    if (message.type === 'secure_push_register_request') {
      const authority = peer.pushAuthority;
      if (!authority) throw new Error('RELAY_REVOKED');
      if (this.cfg.securePushSender?.() === false) {
        this.log('Secure push registration refused: no secure push sender');
        this.sendRaw(
          peer.cid,
          createSecurePushRegisterResponse(message.id, { success: false, error: 'UNSUPPORTED' }),
        );
        return;
      }
      const allowed = [
        'type',
        'id',
        'timestamp',
        'token',
        'environment',
        'pushPublicKey',
        'keyVersion',
        'pushPrefs',
      ];
      let registration: ReturnType<typeof normalizeSecureRegistration>;
      try {
        if (Object.keys(message).some((key) => !allowed.includes(key)))
          throw new Error('INVALID_SUBSCRIPTION');
        registration = normalizeSecureRegistration({
          token: message.token,
          environment: message.environment,
          pushPublicKey: message.pushPublicKey,
          keyVersion: message.keyVersion,
          // Malformed preferences fail toward delivering, never refuse (#1200, B7).
          pushPrefs: sanitizePushPreferences(message.pushPrefs),
        });
      } catch {
        this.sendRaw(
          peer.cid,
          createSecurePushRegisterResponse(message.id, {
            success: false,
            error: 'INVALID_SUBSCRIPTION',
          }),
        );
        return;
      }
      const mutation = this.nextPushMutation(peer);
      const result = await this.subscriptions.register(
        authority,
        registration,
        () =>
          this.active(peer) &&
          !peer.transportClosing &&
          peer.stage === 'ready' &&
          peer.pushMutation === mutation &&
          peer.pushAuthority === authority,
      );
      // register's commit callback is inside the authorization lock: use only
      // in-memory lifecycle state there, never current()'s nested disk lock.
      this.sendRaw(peer.cid, createSecurePushRegisterResponse(message.id, result));
      return;
    }
    if (message.type === 'secure_push_unregister_request') {
      const authority = peer.pushAuthority;
      if (!authority) throw new Error('RELAY_REVOKED');
      let result: Parameters<typeof createSecurePushUnregisterResponse>[1];
      try {
        if (Object.keys(message).some((key) => !['type', 'id', 'timestamp'].includes(key))) {
          result = { success: false, error: 'INVALID_SUBSCRIPTION' };
        } else {
          // Cancel older asynchronous preparation before this synchronous removal.
          this.nextPushMutation(peer);
          result = this.subscriptions.unregister(authority)
            ? { success: true }
            : { success: false, error: 'NOT_AUTHORIZED' };
        }
      } catch {
        result = { success: false, error: 'STORE_ERROR' };
      }
      this.sendRaw(peer.cid, createSecurePushUnregisterResponse(message.id, result));
      return;
    }
    if (message.type === 'session_list_request') {
      if (peer.listing) {
        this.sendRaw(
          peer.cid,
          createError('BUSY', 'Session list query already active', { requestId: message.id }),
        );
        return;
      }
      peer.listing = true;
      try {
        await this.sessionList(peer, message);
      } finally {
        peer.listing = false;
      }
      return;
    }
    if (message.type === 'relay_devices_request') {
      this.sendRaw(peer.cid, {
        type: 'relay_devices_response',
        id: generateId(),
        timestamp: now(),
        requestId: message.id,
        devices: this.devices.list(),
      });
      return;
    }
    if (message.type === 'relay_device_revoke_request') {
      const result = await this.revoke(message.fingerprint);
      this.sendRaw(peer.cid, {
        type: 'relay_device_revoke_response',
        id: generateId(),
        timestamp: now(),
        requestId: message.id,
        fingerprint: message.fingerprint,
        ...result,
      });
      return;
    }
    if (message.type === 'transcript_load_request') {
      if (peer.historyOverflow) {
        this.sendRaw(
          peer.cid,
          createError(
            'DELIVERY_UNCERTAIN',
            'History delivery could not be tracked; reconnect before retrying',
            { requestId: message.id },
          ),
        );
        return;
      }
      peer.historyFailed.delete(message.sessionId);
    }
    const sessionId =
      message.type === 'hello'
        ? message.resumeSessionId
        : 'sessionId' in message
          ? message.sessionId
          : undefined;
    if (typeof sessionId === 'string' && sessionId && message.type !== 'create_session_request') {
      if (message.type === 'answer') {
        const live = this.cfg.registry.listLive().find((entry) => entry.sessionId === sessionId);
        const generation = live
          ? JSON.stringify([live.pid, live.wsPort, live.startedAt])
          : 'missing';
        const result = await peer.answers.run(
          message,
          peer.answerIds.checkAndMark(message.id),
          async () => (peer.proxy ? await peer.proxy.answer(message) : 'uncertain'),
          generation,
        );
        this.sendRaw(peer.cid, result);
        return;
      }
      try {
        await peer.proxy?.send(sessionId, message);
      } catch {
        this.sendRaw(
          peer.cid,
          createError('SESSION_NOT_FOUND', 'Child session unverified; delivery uncertain', {
            sessionId,
          }),
        );
      }
    } else peer.connection?.handleMessage(serialize(message));
  }
  private async routeNativeAnswer(peer: Peer, message: NativeAnswerMessage): Promise<void> {
    const machine = this.machine;
    const key = peer.key;
    try {
      if (!machine || !key) throw new Error('RELAY_NOT_READY');
      await relayV2.verifyNativeAnswer(
        message,
        {
          rid: Buffer.from(this.rid).toString('hex'),
          machinePublicKey: relayV2.b64u(machine.publicKey),
          devicePublicKey: Buffer.from(key, 'base64').toString('base64url'),
        },
        Math.floor(Date.now() / 1000),
      );
    } catch {
      this.sendRaw(
        peer.cid,
        createAnswerResult(message.id, message.sessionId, message.questionId, 'stale'),
      );
      return;
    }
    if (!this.current(peer) || !this.enrolled(peer) || this.machine !== machine || peer.key !== key)
      return;
    let outcome: import('@remi/shared').AnswerResultOutcome = 'uncertain';
    try {
      outcome = (await peer.proxy?.nativeAnswer(message)) ?? 'uncertain';
    } catch {
      // A lost child result never grants permission to send a second answer.
    }
    this.sendRaw(
      peer.cid,
      createAnswerResult(message.id, message.sessionId, message.questionId, outcome),
    );
  }

  private closePeer(peer: Peer, orderly = false): Promise<void> {
    if (peer.closing) return peer.closing;
    // Cancel synchronously, before crypto/storage may resume; only BYE may leave afterward.
    peer.cancelled = true;
    peer.orderlyClosing = orderly;
    clearTimeout(peer.timer);
    peer.step1?.abort();
    peer.step2?.abort();
    peer.proxy?.close();
    for (const [id, resolve] of peer.hubLists) resolve(createSessionListResponse([], id));
    peer.hubLists.clear();
    for (const offer of [...this.offers.values()])
      if (offer.reserved === peer.cid) this.discard(offer);
    peer.closing = (async () => {
      try {
        // The first step is an await, so the `add` below always runs before the `delete`.
        await Promise.resolve();
        let byeSent = false;
        if (orderly && peer.channel) {
          try {
            await peer.channel.bye();
            byeSent = true;
          } catch {}
        }
        peer.connection?.close('Relay closed');
        this.peers.delete(peer.cid);
        // After the BYE, leave the close to the far side for a while (#1225): the client closes
        // once it has the BYE, so the pipe ends without this side resetting it.
        if (byeSent) await waitAtMost(peer.gone, ORDERLY_CLOSE_GRACE_MS);
        if (peer.ws.readyState < WebSocket.CLOSING) peer.hubClosed = true;
        peer.ws.close(
          orderly ? 1000 : relayV2.FAILURE_CLOSE.code,
          orderly ? '' : relayV2.FAILURE_CLOSE.reason,
        );
        if (peer.channel) await peer.channel.transportClosed();
      } finally {
        this.closingPeers.delete(peer);
      }
    })();
    // The peer leaves `peers` before its grace, so `stop()` finds a closing pipe here. The body
    // removes it in a finally, so nothing else handles this promise: a rejection still reaches
    // the process guard through the callers that `void` it.
    this.closingPeers.add(peer);
    return peer.closing;
  }
  open(id: string, send: (text: string) => void): void {
    this.locals.set(id, send);
  }
  private local(id: string, value: unknown): void {
    this.locals.get(id)?.(JSON.stringify(value));
  }
  message(owner: string, text: string): void {
    void this.localRequest(owner, text).catch(() =>
      this.local(owner, { t: 'error', error: 'RELAY_CONTROL_REFUSED' }),
    );
  }
  private async localRequest(owner: string, text: string): Promise<void> {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (
      !value ||
      typeof value !== 'object' ||
      typeof value['id'] !== 'string' ||
      value['id'].length > 64 ||
      !this.locals.has(owner)
    )
      throw new Error('CONTROL');
    const id = value['id'];
    if (value['t'] === 'pair' && Object.keys(value).length === 2) {
      if (!this.running || !this.control || !this.machine) throw new Error('RELAY_NOT_READY');
      if (this.offers.size >= 8) {
        this.local(owner, { t: 'error', id, error: 'PAIRING_CAPACITY' });
        return;
      }
      const policy = relayV2.createPairingOffer(relayV2.systemRandom, Date.now());
      const offerId = generateId();
      const offer: Offer = {
        id: offerId,
        owner,
        requestId: id,
        policy,
        timer: setTimeout(() => this.discard(offer), 600000),
      };
      this.offers.set(offerId, offer);
      try {
        const hash = await relayV2.admitTagHash(await relayV2.admitTag(policy.secret));
        const ttlSeconds = Math.max(1, Math.floor((policy.expiresAtMs - Date.now()) / 1000));
        if (!(await this.control.command({ t: 'pairing', ticketHash: hash, ttlSeconds })))
          throw new Error('PAIRING_CAPACITY');
        if (
          !this.locals.has(owner) ||
          this.offers.get(offerId) !== offer ||
          !relayV2.isLiveOffer(policy, Date.now())
        )
          return;
        const token = relayV2.encodePairingToken({
          relayUrl: this.cfg.relayUrl,
          machinePublicKey: this.machine.publicKey,
          secret: policy.secret,
          expiresAtSec: Math.floor(policy.expiresAtMs / 1000),
        });
        this.local(owner, { t: 'offer', id, offerId, token });
      } catch {
        this.discard(offer);
        this.local(owner, { t: 'error', id, error: 'PAIRING_REFUSED' });
      }
    } else if (value['t'] === 'confirm' && Object.keys(value).length === 6) {
      const offer = this.offers.get(String(value['offerId']));
      if (
        !offer ||
        offer.owner !== owner ||
        offer.requestId !== id ||
        offer.reserved !== value['connectionId'] ||
        offer.fingerprint !== value['fingerprint'] ||
        typeof value['accept'] !== 'boolean' ||
        !relayV2.isLiveOffer(offer.policy, Date.now())
      )
        throw new Error('CONFIRMATION_REFUSED');
      const confirm = offer.confirmed;
      offer.confirmed = undefined;
      confirm?.(value['accept']);
    } else if (value['t'] === 'devices' && Object.keys(value).length === 2)
      this.local(owner, { t: 'devices', id, devices: this.devices.list() });
    else if (
      value['t'] === 'revoke' &&
      Object.keys(value).length === 3 &&
      typeof value['fingerprint'] === 'string'
    )
      this.local(owner, {
        t: 'revoked',
        id,
        fingerprint: value['fingerprint'],
        ...(await this.revoke(value['fingerprint'])),
      });
    else throw new Error('CONTROL');
  }
  close(owner: string): void {
    this.locals.delete(owner);
    for (const offer of [...this.offers.values()]) if (offer.owner === owner) this.discard(offer);
  }
  private discard(offer: Offer): void {
    if (this.offers.get(offer.id) !== offer) return;
    this.offers.delete(offer.id);
    clearTimeout(offer.timer);
    offer.confirmed?.(false);
    offer.policy.secret.fill(0);
    const peer = offer.reserved ? this.peers.get(offer.reserved) : undefined;
    if (peer && peer.stage !== 'ready') void this.closePeer(peer);
  }
  private async revoke(
    fingerprint: string,
  ): Promise<Pick<RelayDeviceRevokeResponseMessage, 'success' | 'edgeAcknowledged' | 'error'>> {
    if (!/^[0-9a-f]{16}$/.test(fingerprint))
      return { success: false, edgeAcknowledged: false, error: 'NOT_FOUND' };
    const authorized = this.cfg.trust
      .loadAuthorizedKeys()
      .keys.find((key) => key.fingerprint === fingerprint);
    if (!authorized) return { success: false, edgeAcknowledged: false, error: 'NOT_FOUND' };
    this.revisions.set(authorized.publicKey, (this.revisions.get(authorized.publicKey) ?? 0) + 1);
    for (const peer of this.peers.values())
      if (peer.key === authorized.publicKey) void this.closePeer(peer, true);
    return this.serial(async () => {
      try {
        this.cfg.trust.removeAuthorizedKey(fingerprint);
        this.devices.remove(fingerprint);
      } catch {
        return { success: false, edgeAcknowledged: false, error: 'STORAGE_ERROR' };
      }
      try {
        if (
          await this.control?.command({
            t: 'revoke',
            key: new Uint8Array(fromBase64(authorized.publicKey)),
          })
        )
          return { success: true, edgeAcknowledged: true };
      } catch {}
      return { success: true, edgeAcknowledged: false, error: 'EDGE_UNVERIFIED' };
    });
  }
  sendMessage(id: string, message: Message): boolean {
    return this.sendRaw(id, createAgentOutput(message));
  }
  sendStatus(id: string, status: AgentStatus, context?: string): boolean {
    return this.sendRaw(id, createSessionUpdate(id, status, context));
  }
  private refuseSemantic(
    peer: Peer,
    message: ProtocolMessage,
    code: 'PAYLOAD_TOO_LARGE' | 'SEND_QUEUE_FULL',
  ): false {
    if ('sessionId' in message && typeof message.sessionId === 'string') {
      if (peer.historyFailed.size < 32 || peer.historyFailed.has(message.sessionId))
        peer.historyFailed.add(message.sessionId);
      else peer.historyOverflow = true;
    }
    peer.sendNotice = code;
    this.log(`Relay semantic send refused: ${code}; delivery uncertain`);
    this.flushNotice(peer);
    return false;
  }
  private flushNotice(peer: Peer): void {
    if (
      !peer.sendNotice ||
      peer.pendingSends >= relayV2.MAX_PENDING_SENDS ||
      !this.current(peer) ||
      !peer.channel
    )
      return;
    const code = peer.sendNotice;
    peer.sendNotice = undefined;
    this.enqueue(
      peer,
      new TextEncoder().encode(
        serialize(createError(code, 'Relay delivery uncertain: semantic message refused')),
      ),
    );
  }
  private enqueue(peer: Peer, bytes: Uint8Array): void {
    peer.pendingSends++;
    void peer.channel
      ?.send(bytes)
      .catch(() => {
        this.log('Relay semantic send failed; delivery uncertain');
      })
      .finally(() => {
        peer.pendingSends--;
        this.flushNotice(peer);
      });
  }
  sendRaw(id: string, message: ProtocolMessage, aggregated = false): boolean {
    const peer = this.peers.get(id);
    if (peer && message.type === 'session_list_response' && !aggregated) {
      peer.hubLists.get(message.requestId)?.(message);
      return false;
    }
    if (!peer || !peer.channel || message.type === 'raw_pty_output') return false;
    if (!this.current(peer)) {
      void this.closePeer(peer, true);
      return false;
    }
    if (
      message.type === 'transcript_load_complete' &&
      (peer.historyOverflow || peer.historyFailed.has(message.sessionId))
    )
      return false;
    const bytes = new TextEncoder().encode(serialize(message));
    if (bytes.length > relayV2.MAX_PLAINTEXT)
      return this.refuseSemantic(peer, message, 'PAYLOAD_TOO_LARGE');
    if (peer.pendingSends >= relayV2.MAX_PENDING_SENDS)
      return this.refuseSemantic(peer, message, 'SEND_QUEUE_FULL');
    this.enqueue(peer, bytes);
    return true;
  }
  broadcast(message: ProtocolMessage): void {
    if (message.type === 'raw_pty_output') return;
    for (const id of this.peers.keys()) this.sendRaw(id, message);
  }
  hasConnection(id: string): boolean {
    const peer = this.peers.get(id);
    return !!peer && peer.stage === 'ready' && this.current(peer);
  }
  closeConnection(id: string): boolean {
    const peer = this.peers.get(id);
    if (!peer) return false;
    void this.closePeer(peer, true);
    return true;
  }
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.reconnect) clearTimeout(this.reconnect);
    if (this.stable) clearTimeout(this.stable);
    // Forget the control before closing it: on Bun 1.3.11 its close handler runs inside close(),
    // and while it is still the current control that handler treats the close as a lost control
    // and closes every pipe with the failure close, before the orderly close below (#1225).
    const control = this.control;
    this.control = undefined;
    control?.stop();
    for (const peer of [...this.peers.values()]) void this.closePeer(peer, true);
    // Every close still running, including a pipe that was already in its grace (#1225).
    await Promise.all([...this.closingPeers].map((peer) => peer.closing));
    for (const offer of [...this.offers.values()]) this.discard(offer);
    this.locals.clear();
    await this.stateTail;
  }
}
