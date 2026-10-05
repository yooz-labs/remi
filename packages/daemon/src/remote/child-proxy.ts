/** A remote device chooses a session id; only a live local registry chooses its port. */
import { type ProtocolMessage, createHello, deserialize, serialize } from '@remi/shared';
import { capabilityWsOptions } from '../cli/capability-client.ts';
import type { SessionRegistryFile } from '../session/session-registry-file.ts';

export class ChildProxy {
  private readonly children = new Map<
    string,
    { ws: WebSocket; port: number; ready: Promise<void> }
  >();
  private closed = false;
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
            verified = true;
            clearTimeout(timer);
            resolve();
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
          if (!this.closed) this.failed(sessionId);
        };
      });
      child = { ws, port: live.wsPort, ready };
      this.children.set(sessionId, child);
    }
    await child.ready;
    const current = this.registry.listLive().find((entry) => entry.sessionId === sessionId);
    if (this.closed || current?.wsPort !== child.port || child.ws.readyState !== WebSocket.OPEN)
      throw new Error('CHILD_UNAVAILABLE');
    if (message.type !== 'hello') child.ws.send(serialize(message));
  }
  close(): void {
    this.closed = true;
    for (const child of this.children.values()) child.ws.close();
    this.children.clear();
  }
}
