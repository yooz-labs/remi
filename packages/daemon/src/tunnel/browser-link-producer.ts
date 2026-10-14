/** Dormant session-owned local producer. No device authority, harness activation or URL fetch. */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { type Server, type Socket, createServer } from 'node:net';
import { isAbsolute, join } from 'node:path';
import { normalizeBrowserLinkURL } from '../../../shared/src/browser-links.ts';
import { exact, imageWireValue, uuid } from '../../../shared/src/image-wire.ts';
import { shellQuote } from '../session/shell-quote.ts';
import { writeRestrictedJson } from '../storage/restricted-json.ts';
import { browserLinkCommand, isBrowserProducerToken } from './browser-link-command.ts';

const FAILURE = 'Browser link producer unavailable';
const DEADLINE_MS = 1000;
const FRAME_BYTES = 65536;
const MAX_ACTIVE = 4;

export interface BrowserLinkProducerContext {
  readonly sessionId: string;
  readonly binding: { readonly harness: 'claude'; readonly harnessSessionId: string };
  readonly runtime: object;
}

interface Generation {
  readonly context: BrowserLinkProducerContext;
  readonly token: string;
}

function capture(context: BrowserLinkProducerContext): BrowserLinkProducerContext {
  if (
    !context ||
    !uuid(context.sessionId) ||
    context.binding?.harness !== 'claude' ||
    !uuid(context.binding.harnessSessionId) ||
    !context.runtime ||
    typeof context.runtime !== 'object'
  )
    throw new Error(FAILURE);
  return Object.freeze({
    sessionId: context.sessionId,
    binding: Object.freeze({ ...context.binding }),
    runtime: context.runtime,
  });
}

/** A close removes launcher resources only after its consumer has ended; retire leaves it usable. */
export class BrowserLinkProducerRuntime {
  private context: BrowserLinkProducerContext;
  private readonly offer: (context: BrowserLinkProducerContext, url: string) => boolean;
  private readonly temporaryRoot: string;
  private directory: string | null = null;
  private server: Server | null = null;
  private generation: Generation | null = null;
  private retired = false;
  private closed = false;
  private starting = false;
  private started = false;
  private startTask: Promise<void> | null = null;
  private closeTask: Promise<void> | null = null;
  private readonly sockets = new Map<
    Socket,
    { until: number; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(options: {
    readonly context: BrowserLinkProducerContext;
    readonly offer: (context: BrowserLinkProducerContext, url: string) => boolean;
    readonly temporaryRoot?: string;
  }) {
    this.context = capture(options.context);
    this.offer = options.offer;
    const temporaryRoot = options.temporaryRoot ?? '/tmp';
    if (!isAbsolute(temporaryRoot) || /\s/u.test(temporaryRoot)) throw new Error(FAILURE);
    try {
      // macOS /tmp is a symlink; the helper checks its actual owned cwd.
      this.temporaryRoot = realpathSync(temporaryRoot);
      // BROWSER consumers parse ':' as a list and '%s' as URL operand syntax.
      if (/[\s:]|%s/u.test(this.temporaryRoot)) throw new Error(FAILURE);
    } catch {
      throw new Error(FAILURE);
    }
  }

  get browserPath(): string {
    if (!this.directory) throw new Error(FAILURE);
    return join(this.directory, 'browser');
  }

  start(): Promise<void> {
    if (this.starting || this.started || this.closed || this.retired)
      return Promise.reject(new Error(FAILURE));
    this.starting = true;
    this.startTask = this.open();
    return this.startTask;
  }

  private async open(): Promise<void> {
    try {
      this.directory = mkdtempSync(join(this.temporaryRoot, 'remi-bl-'));
      chmodSync(this.directory, 0o700);
      const socketPath = join(this.directory, 'socket');
      if (Buffer.byteLength(socketPath) >= 104) throw new Error(FAILURE);
      const cwd = join(this.directory, 'cwd');
      mkdirSync(cwd, { mode: 0o700 });
      const command = [...browserLinkCommand(), join(this.directory, 'profile.json')]
        .map(shellQuote)
        .join(' ');
      // All command words are fixed owned paths. URL operands are never reparsed as shell source.
      writeFileSync(
        this.browserPath,
        `#!/bin/sh\nif cd ${shellQuote(cwd)} 2>/dev/null; then\n  ${command} "$@" >/dev/null 2>&1\n  result=$?\nelse\n  result=1\nfi\nif [ "$result" -ne 0 ]; then\n  printf '%s\\n' 'Browser link unavailable' >&2\nfi\nexit 0\n`,
        { flag: 'wx', mode: 0o700 },
      );
      // Accept owns the deadline before any bytes arrive; no HTTP/header-stage acceptance gap.
      const server = createServer((socket) => this.accept(socket));
      this.server = server;
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      server.on('error', () => this.retire());
      chmodSync(socketPath, 0o600);
      if (this.closed || this.retired) throw new Error(FAILURE);
      this.publish(this.context);
      this.started = true;
    } catch {
      this.retire();
      await this.removeResources();
      throw new Error(FAILURE);
    } finally {
      this.starting = false;
    }
  }

  private publish(context: BrowserLinkProducerContext): void {
    this.generation = null;
    try {
      const captured = capture(context);
      if (!this.directory) throw new Error(FAILURE);
      const next = { context: captured, token: randomBytes(32).toString('base64url') };
      writeRestrictedJson(join(this.directory, 'profile.json'), {
        version: 1,
        socketPath: join(this.directory, 'socket'),
        token: next.token,
      });
      this.context = captured;
      this.generation = next;
    } catch {
      throw new Error(FAILURE);
    }
  }

  rotate(context: BrowserLinkProducerContext): void {
    if (!this.started || this.retired || this.closed) throw new Error(FAILURE);
    this.publish(context);
  }

  /** Synchronous invalidation; keep the launcher/profile until the consumer has actually ended. */
  retire(): void {
    this.retired = true;
    this.generation = null;
  }

  private accept(socket: Socket): void {
    if (this.closed || this.sockets.size >= MAX_ACTIVE) {
      socket.destroy();
      return;
    }
    const generation = this.generation;
    const until = performance.now() + DEADLINE_MS;
    const timer = setTimeout(() => socket.destroy(), DEADLINE_MS);
    this.sockets.set(socket, { until, timer });
    socket.once('close', () => {
      clearTimeout(timer);
      this.sockets.delete(socket);
    });
    socket.on('error', () => socket.destroy());
    const parts: Buffer[] = [];
    let size = 0;
    let done = false;
    const reply = (accepted: boolean) => {
      if (done) return;
      done = true;
      socket.end(accepted ? 'OK\n' : 'NO\n');
    };
    socket.on('data', (chunk: Buffer) => {
      if (done) return socket.destroy();
      size += chunk.length;
      if (size > FRAME_BYTES) return reply(false);
      parts.push(chunk);
      if (chunk.indexOf(10) === -1) return;
      const frame = Buffer.concat(parts, size);
      const newline = frame.indexOf(10);
      if (newline !== size - 1) return reply(false);
      try {
        const value = imageWireValue(frame.subarray(0, -1));
        if (!exact(value, { token: isBrowserProducerToken, url: (url) => typeof url === 'string' }))
          return reply(false);
        const url = normalizeBrowserLinkURL(value['url']);
        if (
          !generation ||
          !timingSafeEqual(Buffer.from(value['token'] as string), Buffer.from(generation.token)) ||
          !url ||
          this.generation !== generation ||
          this.retired ||
          this.closed ||
          performance.now() >= until
        )
          return reply(false);
        // Consume before the synchronous effect. Later bytes cannot trigger another offer.
        done = true;
        let accepted = false;
        try {
          accepted = this.offer(generation.context, url) === true;
        } catch {}
        socket.end(accepted ? 'OK\n' : 'NO\n');
      } catch {
        reply(false);
      }
    });
    socket.once('end', () => reply(false));
  }

  private async removeResources(): Promise<void> {
    const server = this.server;
    for (const [socket, state] of this.sockets) {
      clearTimeout(state.timer);
      socket.destroy();
    }
    this.sockets.clear();
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING')
            reject(new Error(FAILURE));
          else resolve();
        }),
      );
      if (this.server === server) this.server = null;
    }
    if (this.directory) {
      rmSync(this.directory, { recursive: true, force: true });
      this.directory = null;
    }
  }

  /** Call only after the BROWSER consumer has ended. Orderly cleanup joins all owned resources. */
  close(): Promise<void> {
    this.closed = true;
    this.retire();
    if (!this.closeTask) {
      this.closeTask = (async () => {
        await this.startTask?.catch(() => {});
        try {
          await this.removeResources();
        } catch {
          this.closeTask = null;
          throw new Error(FAILURE);
        }
      })();
    }
    return this.closeTask;
  }
}
