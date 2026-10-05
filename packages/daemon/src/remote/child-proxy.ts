/** A remote device chooses a session id; only a live local registry chooses its port. */
import {
  type AnswerMessage,
  type AnswerResultOutcome,
  type HelloAckMessage,
  type ProtocolMessage,
  type SessionListResponseMessage,
  createHello,
  createSessionListRequest,
  deserialize,
  serialize,
} from '@remi/shared';
import { capabilityWsOptions } from '../cli/capability-client.ts';
import type { SessionRegistryFile } from '../session/session-registry-file.ts';

export class ChildProxy {
  private readonly children = new Map<
    string,
    { ws: WebSocket; port: number; ready: Promise<void>; hello: HelloAckMessage | undefined }
  >();
  private closed = false;
  private readonly lists = new Map<
    string,
    {
      sessionId: string;
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
    { sessionId: string; questionId: string; resolve: (outcome: AnswerResultOutcome) => void }
  >();
  async answer(message: AnswerMessage): Promise<AnswerResultOutcome> {
    if (this.answers.size >= 32) return 'busy';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = new Promise<AnswerResultOutcome>((resolve) => {
      this.answers.set(message.id, {
        sessionId: message.sessionId,
        questionId: message.questionId,
        resolve,
      });
      timer = setTimeout(() => resolve('uncertain'), 10000);
    });
    try {
      await this.send(message.sessionId, message);
      return await result;
    } catch (error) {
      return error instanceof Error && error.message === 'SESSION_NOT_FOUND'
        ? 'session-not-found'
        : 'uncertain';
    } finally {
      if (timer) clearTimeout(timer);
      this.answers.delete(message.id);
    }
  }
  private refuseAnswers(sessionId?: string): void {
    for (const entry of this.answers.values())
      if (!sessionId || entry.sessionId === sessionId) entry.resolve('uncertain');
  }

  constructor(
    private readonly registry: SessionRegistryFile,
    private readonly deviceId: string,
    private readonly receive: (message: ProtocolMessage) => void,
    private readonly failed: (sessionId: string) => void,
  ) {}
  async send(sessionId: string, message: ProtocolMessage): Promise<void> {
    const live = this.registry.listLive().find((entry) => entry.sessionId === sessionId);
    if (
      this.closed ||
      !live ||
      !Number.isInteger(live.wsPort) ||
      live.wsPort < 1 ||
      live.wsPort > 65535
    )
      throw new Error('SESSION_NOT_FOUND');
    let child = this.children.get(sessionId);
    if (child && child.port !== live.wsPort) {
      child.ws.close();
      this.children.delete(sessionId);
      child = undefined;
    }
    if (!child) {
      if (this.children.size >= 32) throw new Error('CHILD_CAPACITY');
      const options = capabilityWsOptions();
      if (!options) throw new Error('LOCAL_CAPABILITY_REQUIRED');
      const ws = new WebSocket(`ws://127.0.0.1:${live.wsPort}/ws`, options as never);
      let verified = false;
      const ready = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('CHILD_UNVERIFIED'));
          ws.close();
        }, 10000);
        ws.onopen = () => {
          if (this.closed) {
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
          const incoming = typeof event.data === 'string' ? deserialize(event.data) : null;
          if (!incoming || incoming.type === 'auth_challenge' || incoming.type === 'auth_result') {
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
            const current = this.registry.listLive().find((entry) => entry.sessionId === sessionId);
            if (this.closed || current?.wsPort !== live.wsPort) {
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
          if (incoming.type === 'session_list_response') {
            const list = this.lists.get(incoming.requestId);
            if (list?.sessionId === sessionId) list.resolve(incoming);
            return;
          }
          if (incoming.type === 'answer_result') {
            const answer = this.answers.get(incoming.requestId);
            if (
              answer?.sessionId === incoming.sessionId &&
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
          reject(new Error('CHILD_UNAVAILABLE'));
        };
        ws.onclose = () => {
          clearTimeout(timer);
          reject(new Error('CHILD_UNAVAILABLE'));
          if (this.children.get(sessionId)?.ws === ws) this.children.delete(sessionId);
          this.refuseAnswers(sessionId);
          for (const list of this.lists.values())
            if (list.sessionId === sessionId) list.reject(new Error('CHILD_UNAVAILABLE'));
          if (!this.closed) this.failed(sessionId);
        };
      });
      child = { ws, port: live.wsPort, ready, hello: undefined };
      this.children.set(sessionId, child);
    }
    await child.ready;
    const current = this.registry.listLive().find((entry) => entry.sessionId === sessionId);
    if (this.closed || current?.wsPort !== child.port || child.ws.readyState !== WebSocket.OPEN)
      throw new Error('CHILD_UNAVAILABLE');
    if (message.type === 'hello') {
      if (child.hello) this.receive(child.hello);
    } else child.ws.send(serialize(message));
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
