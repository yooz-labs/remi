/** A remote device chooses a session id; only a live local registry chooses its port. */
import {
  type AnswerMessage,
  type AnswerResultOutcome,
  type HelloAckMessage,
  type NativeAnswerMessage,
  type ProtocolMessage,
  type SessionListResponseMessage,
  createHello,
  createPong,
  createSessionListRequest,
  deserialize,
  relayV2,
  serialize,
} from '@remi/shared';
import {
  RELAY_CHAT_AUTHORITY_HEADER,
  encodeRelayChatAuthority,
} from '../auth/relay-chat-authority';
import { capabilityWsOptions } from '../cli/capability-client.ts';
import type { SecurePushAuthority } from '../notifications/secure-push-store';
import type { SessionRegistryFile } from '../session/session-registry-file.ts';

export class ChildProxy {
  private readonly children = new Map<
    string,
    {
      ws: WebSocket;
      port: number;
      generation: string;
      ready: Promise<void>;
      hello: HelloAckMessage | undefined;
      chatOwner: boolean;
    }
  >();
  private closed = false;
  /** A consumed child sequence must never move to a replacement socket on this channel. */
  private retireChatOwner(sessionId: string, ws?: WebSocket): boolean {
    const child = this.children.get(sessionId);
    if (!child?.chatOwner || (ws && child.ws !== ws)) return false;
    this.close();
    this.failed(sessionId, true);
    return true;
  }
  private readonly lists = new Map<
    string,
    {
      sessionId: string;
      ws?: WebSocket;
      resolve: (response: SessionListResponseMessage) => void;
      reject: (error: Error) => void;
    }
  >();
  async list(sessionId: string, includeExternal: boolean): Promise<SessionListResponseMessage> {
    const request = createSessionListRequest(includeExternal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = new Promise<SessionListResponseMessage>((resolve, reject) => {
      this.lists.set(request.id, { sessionId, resolve, reject });
      timer = setTimeout(() => reject(new Error('CHILD_LIST_UNCERTAIN')), 5000);
    });
    // A connection refusal can race the result timeout; observe both promises immediately.
    void result.catch(() => {});
    try {
      await this.send(sessionId, request);
      return await result;
    } finally {
      if (timer) clearTimeout(timer);
      this.lists.delete(request.id);
    }
  }

  private readonly answers = new Map<
    string,
    {
      sessionId: string;
      questionId: string;
      ws?: WebSocket;
      resolve: (outcome: AnswerResultOutcome) => void;
      result: Promise<AnswerResultOutcome>;
      nativeDigest?: string;
    }
  >();
  async answer(message: AnswerMessage): Promise<AnswerResultOutcome> {
    return this.forwardAnswer(message);
  }
  async nativeAnswer(input: NativeAnswerMessage): Promise<AnswerResultOutcome> {
    try {
      const message = relayV2.decodeNativeAnswer(relayV2.encodeNativeAnswer(input));
      const digest = await relayV2.nativeAnswerDigest(message);
      if (Date.now() >= message.expiresAt * 1000) return 'stale';
      return this.forwardAnswer(message, digest);
    } catch {
      return 'stale';
    }
  }
  private async forwardAnswer(
    message: AnswerMessage | NativeAnswerMessage,
    nativeDigest?: string,
  ): Promise<AnswerResultOutcome> {
    if (this.closed || !this.authorized()) return 'uncertain';
    const previous = this.answers.get(message.id);
    if (previous) {
      // Register only one waiter for an id. Ordinary request collisions cannot
      // overwrite a native proof's correlation; an exact proof shares its wait.
      return nativeDigest !== undefined &&
        previous.nativeDigest === nativeDigest &&
        previous.sessionId === message.sessionId &&
        previous.questionId === message.questionId
        ? previous.result
        : 'conflict';
    }
    if (this.answers.size >= 32) return 'busy';
    let timer: ReturnType<typeof setTimeout> | undefined;
    let complete!: (outcome: AnswerResultOutcome) => void;
    const result = new Promise<AnswerResultOutcome>((resolve) => {
      complete = resolve;
    });
    const entry = {
      sessionId: message.sessionId,
      questionId: message.questionId,
      resolve: complete,
      result,
      ...(nativeDigest !== undefined ? { nativeDigest } : {}),
    };
    this.answers.set(message.id, entry);
    const remaining =
      message.type === 'native_answer' ? Math.max(0, message.expiresAt * 1000 - Date.now()) : 10000;
    timer = setTimeout(() => complete('uncertain'), Math.min(10000, remaining));
    let outcome: AnswerResultOutcome;
    try {
      await this.send(message.sessionId, message);
      outcome = await result;
    } catch (error) {
      outcome =
        error instanceof Error && error.message === 'SESSION_NOT_FOUND'
          ? 'session-not-found'
          : 'uncertain';
    } finally {
      if (timer) clearTimeout(timer);
      if (this.answers.get(message.id) === entry) this.answers.delete(message.id);
    }
    // Every coalesced waiter shares `result` (#1201). A send that fails before any child
    // answer_result leaves it unsettled, and its timer is cleared above, so settle it with
    // the first caller's outcome on every exit path. Settling an already settled result is a no-op.
    complete(outcome);
    return outcome;
  }
  private refuseAnswers(sessionId?: string, ws?: WebSocket): void {
    for (const entry of this.answers.values())
      if ((!sessionId || entry.sessionId === sessionId) && (!ws || entry.ws === ws))
        entry.resolve('uncertain');
  }

  constructor(
    private readonly registry: SessionRegistryFile,
    private readonly deviceId: string,
    private readonly receive: (message: ProtocolMessage) => void,
    private readonly failed: (sessionId: string, chatOwnerLost?: boolean) => void,
    private readonly authorized: () => boolean,
    private readonly relayAuthority?: SecurePushAuthority,
  ) {}
  async send(sessionId: string, message: ProtocolMessage): Promise<void> {
    const live = this.registry.listLive().find((entry) => entry.sessionId === sessionId);
    if (
      this.closed ||
      !this.authorized() ||
      !live ||
      !Number.isInteger(live.wsPort) ||
      live.wsPort < 1 ||
      live.wsPort > 65535
    ) {
      this.retireChatOwner(sessionId);
      throw new Error('SESSION_NOT_FOUND');
    }
    const generation = JSON.stringify([live.pid, live.wsPort, live.startedAt]);
    const matches = () => {
      const entry = this.registry.listLive().find((entry) => entry.sessionId === sessionId);
      return entry && JSON.stringify([entry.pid, entry.wsPort, entry.startedAt]) === generation;
    };
    let child = this.children.get(sessionId);
    if (child && child.generation !== generation) {
      if (this.retireChatOwner(sessionId, child.ws)) throw new Error('CHILD_OWNER_RETIRED');
      child.ws.close();
      this.children.delete(sessionId);
      child = undefined;
    }
    if (!child) {
      if (this.children.size >= 32) throw new Error('CHILD_CAPACITY');
      const options = capabilityWsOptions();
      if (!options) throw new Error('LOCAL_CAPABILITY_REQUIRED');
      if (this.relayAuthority)
        options.headers[RELAY_CHAT_AUTHORITY_HEADER] = encodeRelayChatAuthority(
          this.relayAuthority,
        );
      const ws = new WebSocket(`ws://127.0.0.1:${live.wsPort}/ws`, options as never);
      let verified = false;
      const ready = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('CHILD_UNVERIFIED'));
          ws.close();
        }, 10000);
        ws.onopen = () => {
          if (this.closed || !this.authorized() || !matches()) {
            ws.close();
            return;
          }
          ws.send(
            serialize(
              createHello(this.deviceId, '2.0.0', {
                resumeSessionId: sessionId,
                deviceId: this.deviceId,
              }),
            ),
          );
        };
        ws.onmessage = (event) => {
          if (
            this.closed ||
            !this.authorized() ||
            !matches() ||
            this.children.get(sessionId)?.ws !== ws
          ) {
            this.retireChatOwner(sessionId, ws);
            reject(new Error('CHILD_UNAVAILABLE'));
            ws.close();
            return;
          }
          const incoming = typeof event.data === 'string' ? deserialize(event.data) : null;
          if (!incoming || incoming.type === 'auth_challenge' || incoming.type === 'auth_result') {
            this.retireChatOwner(sessionId, ws);
            reject(new Error('CHILD_UNVERIFIED'));
            ws.close();
            return;
          }
          if (!verified) {
            if (incoming.type !== 'hello_ack') return;
            if (incoming.sessionId !== sessionId || !incoming.attachState) {
              reject(new Error('CHILD_UNVERIFIED'));
              ws.close();
              return;
            }
            if (this.closed || !this.authorized() || !matches()) {
              reject(new Error('CHILD_UNVERIFIED'));
              ws.close();
              return;
            }
            const child = this.children.get(sessionId);
            if (child) child.hello = incoming;
            verified = true;
            clearTimeout(timer);
            resolve();
          }
          if (incoming.type === 'hello_ack') return;
          if (incoming.type === 'ping') {
            // The hub is this child's peer. A sessionless remote Pong would
            // reach the machine Connection, not this verified socket (#1202).
            try {
              if (ws.readyState !== WebSocket.OPEN) throw new Error('CHILD_UNAVAILABLE');
              ws.send(serialize(createPong(incoming.id)));
            } catch {
              reject(new Error('CHILD_UNAVAILABLE'));
              ws.close();
            }
            return;
          }
          if (incoming.type === 'session_list_response') {
            const list = this.lists.get(incoming.requestId);
            if (list?.sessionId === sessionId && list.ws === ws) list.resolve(incoming);
            return;
          }
          if (incoming.type === 'answer_result') {
            const answer = this.answers.get(incoming.requestId);
            if (
              answer?.sessionId === incoming.sessionId &&
              answer.ws === ws &&
              answer.questionId === incoming.questionId &&
              [
                'delivered',
                'session-not-found',
                'stale-binding',
                'stale',
                'uncertain',
                'conflict',
                'busy',
              ].includes(incoming.outcome)
            )
              answer.resolve(incoming.outcome);
            return;
          }
          // Defense before forwarding: the remote relay never receives raw terminal bytes.
          if (incoming.type !== 'raw_pty_output' && !this.closed) this.receive(incoming);
        };
        ws.onerror = () => {
          clearTimeout(timer);
          this.retireChatOwner(sessionId, ws);
          reject(new Error('CHILD_UNAVAILABLE'));
        };
        ws.onclose = () => {
          clearTimeout(timer);
          this.retireChatOwner(sessionId, ws);
          reject(new Error('CHILD_UNAVAILABLE'));
          const current = this.children.get(sessionId)?.ws === ws;
          if (current) this.children.delete(sessionId);
          this.refuseAnswers(sessionId, ws);
          for (const list of this.lists.values())
            if (list.sessionId === sessionId && list.ws === ws)
              list.reject(new Error('CHILD_UNAVAILABLE'));
          if (!this.closed && current) this.failed(sessionId);
        };
      });
      child = { ws, port: live.wsPort, generation, ready, hello: undefined, chatOwner: false };
      this.children.set(sessionId, child);
    }
    await child.ready;
    if (
      this.closed ||
      !this.authorized() ||
      !matches() ||
      this.children.get(sessionId)?.ws !== child.ws ||
      child.ws.readyState !== WebSocket.OPEN
    ) {
      this.retireChatOwner(sessionId, child.ws);
      throw new Error('CHILD_UNAVAILABLE');
    }
    const pendingAnswer = this.answers.get(message.id);
    if (pendingAnswer) pendingAnswer.ws = child.ws;
    const pendingList = this.lists.get(message.id);
    if (pendingList) pendingList.ws = child.ws;
    if (message.type === 'hello') {
      if (child.hello) this.receive(child.hello);
    } else {
      if (message.type === 'native_answer' && Date.now() >= message.expiresAt * 1000)
        throw new Error('CHILD_PROOF_EXPIRED');
      // Mark before the possible send, including a refused/unavailable writer.
      // A failed send cannot establish non-delivery or grant a replacement counter.
      if (message.type === 'chat_submit_request') child.chatOwner = true;
      try {
        child.ws.send(serialize(message));
      } catch (error) {
        this.retireChatOwner(sessionId, child.ws);
        throw error;
      }
    }
  }
  close(): void {
    this.closed = true;
    this.refuseAnswers();
    for (const list of this.lists.values()) list.reject(new Error('CHILD_UNAVAILABLE'));
    this.lists.clear();
    for (const child of this.children.values()) child.ws.close();
    this.children.clear();
  }
}
