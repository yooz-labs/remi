/** One admitted Worker control generation. Any uncertain ACK destroys its correlation domain. */
import { relayV2 } from '@remi/shared';
type Signer = relayV2.Signer;
type HostCommand = relayV2.HostCommand;

export class WorkerControl {
  private socket: WebSocket | undefined;
  private admitted = false;
  private poisoned = false;
  private tail: Promise<unknown> = Promise.resolve();
  private pending:
    | {
        op: relayV2.HostOp;
        resolve: (ok: boolean) => void;
        reject: (e: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  constructor(
    private readonly url: string,
    private readonly machine: Signer,
    private readonly rid: Uint8Array,
    private readonly connected: (cid: string) => void,
    private readonly gone: (cid: string) => void,
    private readonly closed: () => void,
  ) {}
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.socket = ws;
      let stage = 'nonce';
      let finished = false;
      const timer = setTimeout(() => fail(), 10000);
      const fail = () => {
        if (!finished) {
          finished = true;
          clearTimeout(timer);
          reject(new Error('RELAY_CONTROL_UNAVAILABLE'));
        }
        this.poison();
      };
      let incoming = Promise.resolve();
      ws.onmessage = (event) => {
        incoming = incoming
          .then(async () => {
            if (this.poisoned) return;
            if (this.admitted && event.data === 'pong') return;
            const notice = relayV2.decodeNotice(event.data);
            if (stage === 'nonce' && notice.t === 'nonce') {
              stage = 'admitting';
              const signature = await relayV2.signAdmission(
                this.machine,
                'host',
                this.rid,
                notice.nonce,
              );
              if (!this.poisoned)
                ws.send(relayV2.encodeAdmit({ key: this.machine.publicKey, signature }));
            } else if (
              stage === 'admitting' &&
              notice.t === 'admitted' &&
              notice.hostUp === undefined
            ) {
              stage = 'ready';
              this.admitted = true;
              finished = true;
              clearTimeout(timer);
              this.heartbeat = setInterval(() => {
                if (this.poisoned) return;
                try {
                  if (ws.readyState !== WebSocket.OPEN)
                    throw new Error('RELAY_CONTROL_UNAVAILABLE');
                  ws.send('ping');
                } catch {
                  fail();
                }
              }, 10000);
              resolve();
            } else if (this.admitted && notice.t === 'connected') this.connected(notice.cid);
            else if (this.admitted && notice.t === 'gone') this.gone(notice.cid);
            else if (this.admitted && notice.t === 'ack' && this.pending?.op === notice.op) {
              const pending = this.pending;
              this.pending = undefined;
              clearTimeout(pending.timer);
              pending.resolve(notice.ok);
            } else fail();
          })
          .catch(fail);
      };
      ws.onerror = fail;
      ws.onclose = () => {
        fail();
        this.closed();
      };
    });
  }
  command(command: HostCommand): Promise<boolean> {
    const result = this.tail.then(() => {
      if (this.poisoned || !this.admitted || this.socket?.readyState !== WebSocket.OPEN)
        throw new Error('RELAY_CONTROL_UNAVAILABLE');
      return new Promise<boolean>((resolve, reject) => {
        this.pending = {
          op: command.t,
          resolve,
          reject,
          timer: setTimeout(() => this.poison(), 10000),
        };
        try {
          this.socket?.send(relayV2.encodeHostCommand(command));
        } catch {
          this.poison();
        }
      });
    });
    this.tail = result.catch(() => {});
    return result;
  }
  poison(): void {
    if (this.poisoned) return;
    this.poisoned = true;
    this.admitted = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error('RELAY_ACK_UNCERTAIN'));
      this.pending = undefined;
    }
    this.socket?.close(relayV2.FAILURE_CLOSE.code, relayV2.FAILURE_CLOSE.reason);
  }
  stop(): void {
    this.poison();
  }
}
