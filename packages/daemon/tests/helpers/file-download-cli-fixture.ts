/** Actual shipping CLI/PTY/stores and owned TLS; accountless harness-shaped consumers only. */
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import {
  type FileDownloadMessage,
  type HelloAckMessage,
  type ProtocolMessage,
  createAuthResponse,
  createHello,
  createIdentity,
  decodeFileDownloadFrame,
  fromBase64,
  serialize,
  sign,
  unlockIdentity,
} from '@remi/shared';
import { IdentityStore } from '../../src/auth/identity-store';
import { until } from './browser-link-service-fixture';
import { threadStartedFrame, threadStatusFrame } from './codex-threads';
import { directTlsFixture } from './direct-tls-fixture';
import { collect, installFakeAgents } from './fake-agent-clis';
import { FakeAppServer } from './fake-app-server';

export async function fileDownloadCliFixture(
  options: {
    harness?: 'claude' | 'codex';
    known?: boolean;
    tls?: boolean;
    mode?: 'daemon' | 'wrapper';
    command?: readonly string[];
    port?: number;
    observe?: (owned: {
      readonly files: ReturnType<typeof directTlsFixture>;
      readonly proc: Bun.Subprocess;
    }) => void;
  } = {},
) {
  const files = directTlsFixture();
  const sockets = new Set<WebSocket>();
  let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
  let server: FakeAppServer | undefined;
  let release: string | undefined;
  let consumerPidFile: string | undefined;
  let consumerPid: number | undefined;
  let forcedKill = false;
  const output = { text: '' };
  async function waitForExit(owned: Bun.Subprocess, milliseconds: number): Promise<boolean> {
    if (owned.exitCode !== null) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        owned.exited.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), milliseconds);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  function consumerEnded(): boolean {
    if (consumerPid === undefined && consumerPidFile && fs.existsSync(consumerPidFile)) {
      const raw = fs.readFileSync(consumerPidFile, 'utf8');
      if (!/^[1-9][0-9]*\s*$/u.test(raw)) return false;
      consumerPid = Number(raw);
    }
    if (consumerPid === undefined) return !forcedKill; // Forced termination cannot prove an unseen consumer ended.
    try {
      process.kill(consumerPid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
  }
  async function close() {
    const errors: unknown[] = [];
    const attempt = async (effect: () => unknown) => {
      try {
        await effect();
      } catch (error) {
        errors.push(error);
      }
    };
    for (const socket of sockets) await attempt(() => socket.close());
    if (release) await attempt(() => fs.writeFileSync(release as string, 'owned'));
    if (proc && proc.exitCode === null) {
      const owned = proc;
      await attempt(() => owned.kill('SIGTERM'));
      if (!(await waitForExit(owned, 5000))) {
        forcedKill = true;
        await attempt(() => owned.kill('SIGKILL'));
        if (!(await waitForExit(owned, 3000)))
          errors.push(new Error('Owned download CLI did not reap'));
      }
    }
    await attempt(() => server?.stop());
    // The actual owning daemon/consumer has ended before generated keys and state are removed.
    let ended = false;
    await attempt(async () => {
      const until = performance.now() + 2000;
      ended = consumerEnded();
      while (!ended && performance.now() < until) {
        await Bun.sleep(5);
        ended = consumerEnded();
      }
    });
    if ((!proc || proc.exitCode !== null) && ended) await attempt(() => files.cleanup());
    else errors.push(new Error('Owned download CLI/consumer death was not confirmed'));
    if (errors.length) throw new AggregateError(errors, 'Owned download CLI cleanup failed');
  }
  try {
    const harness = options.harness ?? 'claude';
    fs.mkdirSync(join(files.userHome, harness === 'claude' ? '.claude' : '.codex'), {
      mode: 0o700,
    });
    if (options.tls === false)
      fs.writeFileSync(files.configPath, files.config.replace(files.tlsTable, ''));
    const agents = installFakeAgents(files.directory, { [harness]: true });
    if (harness === 'claude') {
      // Resolve the helper's actual installed executable, not an installed user command.
      const bin = agents.env['PATH']?.split(':')[0];
      if (!bin) throw new Error('Owned agent path absent');
      consumerPidFile = join(files.directory, 'consumer-pid');
      fs.writeFileSync(
        join(bin, 'claude'),
        `#!/bin/sh\nprintf '%s' "$$" > '${consumerPidFile}'\nprintf 'ready' > '${join(files.directory, 'consumer-ready')}'\nwhile IFS= read -r line; do case "$line" in /exit*) exit 0;; *) printf '%s\\n' "$line" >> '${join(files.directory, 'consumer-input')}';; esac; done\n`,
        { mode: 0o700 },
      );
    } else {
      server = FakeAppServer.start();
      release = join(agents.codexDir, 'release');
      consumerPidFile = join(agents.codexDir, 'pid');
    }
    const trust = new IdentityStore(files.home);
    await trust.generate();
    const identity = await createIdentity();
    await trust.addAuthorizedKey(identity.publicKey, 'owned download CLI client');
    const reservation = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response('owned'),
    });
    const port = options.port ?? (reservation.port as number);
    reservation.stop(true);
    const command = options.command ?? [
      process.execPath,
      '--no-env-file',
      resolve(import.meta.dir, '../../src/entry.ts'),
    ];
    const args =
      options.mode === 'wrapper'
        ? [...command, ...(harness === 'codex' ? ['codex'] : [])]
        : [...command, '--daemon', '--harness', harness];
    proc = Bun.spawn(
      [
        ...args,
        '--port',
        String(port),
        '--dir',
        files.work,
        '--no-mdns',
        '--no-relay',
        '--no-telegram',
      ],
      {
        cwd: files.work,
        env: { ...files.env, ...agents.env, ...(server && { CODEX_HOME: server.codexHome }) },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    collect(proc.stdout, output);
    collect(proc.stderr, output);
    options.observe?.({ files, proc });
    await until(
      () => {
        if (proc?.exitCode !== null)
          throw new Error(`Owned download CLI startup failed (${proc?.exitCode})`);
        return harness === 'claude'
          ? fs.existsSync(join(files.directory, 'consumer-ready'))
          : fs.existsSync(join(agents.codexDir, 'argv')) &&
              !!server
                ?.clientIds()
                .some((id) =>
                  server?.framesFrom(id).some((frame) => frame['method'] === 'initialized'),
                );
      },
      'shipping download consumer',
      20000,
    );
    let thread = 1;
    let currentThread: string | undefined;
    async function learnCodexIdentity() {
      if (!server) throw new Error('Owned Codex server absent');
      if (currentThread)
        server.emit(threadStatusFrame(currentThread, { type: 'idle' }), { broadcast: true });
      const id = `01950000-0000-7000-8000-${(thread++).toString(16).padStart(12, '0')}`;
      server.emit(
        threadStartedFrame('tui', {
          id,
          cwd: fs.realpathSync(files.work),
          createdAtSec: Math.floor(Date.now() / 1000),
        }),
        { broadcast: true },
      );
      server.createRollout(id);
      await until(
        () => output.text.includes(`attached to thread ${id.slice(-8)}`),
        'owned Codex identity',
        10000,
      );
      currentThread = id;
      return id;
    }
    if (harness === 'codex' && options.known !== false) await learnCodexIdentity();
    const url = `${options.tls === false ? 'ws' : 'wss'}://127.0.0.1:${port}/ws`;
    async function peer() {
      const unlocked = await unlockIdentity(identity);
      const ws = new WebSocket(url, {
        ...(options.tls !== false && { tls: { ca: files.ca } }),
      } as never);
      sockets.add(ws);
      const received: ProtocolMessage[] = [];
      const frames: FileDownloadMessage[] = [];
      let failed = false;
      ws.onerror = () => {
        failed = true;
      };
      ws.onmessage = async (event) => {
        const raw = String(event.data);
        const message = JSON.parse(raw) as ProtocolMessage;
        received.push(message);
        const frame = decodeFileDownloadFrame(raw);
        if (frame) frames.push(frame);
        if (message.type === 'auth_challenge') {
          if (message.serverPublicKey !== trust.load()?.publicKey) {
            failed = true;
            ws.close();
            return;
          }
          ws.send(
            serialize(
              createAuthResponse(
                unlocked.publicKeyRaw,
                await sign(unlocked.privateKey, fromBase64(message.challenge)),
                unlocked.fingerprint,
              ),
            ),
          );
        } else if (message.type === 'auth_result' && message.success)
          ws.send(serialize(createHello(crypto.randomUUID(), 'owned download CLI')));
      };
      await until(
        () => failed || received.some((message) => message.type === 'hello_ack'),
        'signed shipping hello',
        15000,
      );
      if (failed) throw new Error('Owned signed download peer failed');
      const hello = () => {
        const message = received
          .slice()
          .reverse()
          .find((message): message is HelloAckMessage => message.type === 'hello_ack');
        if (!message) throw new Error('Owned current hello absent');
        return message;
      };
      return { ws, received, frames, hello };
    }
    return {
      files,
      proc,
      port,
      url,
      trust,
      identity,
      peer,
      learnCodexIdentity,
      output,
      write(relative: string, bytes: string | Uint8Array) {
        fs.writeFileSync(join(files.work, relative), bytes, { mode: 0o600 });
      },
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Owned download CLI startup failed');
    }
    throw error;
  }
}
