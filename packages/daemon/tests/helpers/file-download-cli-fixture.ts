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
import { relayMachineFixture, until } from './browser-link-service-fixture';
import { threadStartedFrame, threadStatusFrame } from './codex-threads';
import { directTlsFixture } from './direct-tls-fixture';
import { installFakeAgents } from './fake-agent-clis';
import { FakeAppServer } from './fake-app-server';

export async function fileDownloadCliFixture(
  options: {
    harness?: 'claude' | 'codex';
    known?: boolean;
    tls?: boolean;
    relay?: 'flag' | 'config' | 'off';
    mode?: 'daemon' | 'wrapper';
    command?: readonly string[];
    projectName?: string;
    threadNamespace?: string;
    port?: number;
    observe?: (owned: {
      readonly files: ReturnType<typeof directTlsFixture>;
      readonly proc: Bun.Subprocess;
    }) => void;
  } = {},
) {
  const files = directTlsFixture();
  if (options.threadNamespace !== undefined && !/^[0-9a-f]{8}$/u.test(options.threadNamespace)) {
    files.cleanup();
    throw new Error('Owned Codex thread namespace invalid');
  }
  if (options.projectName !== undefined) {
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(options.projectName)) {
      files.cleanup();
      throw new Error('Owned download project basename invalid');
    }
    try {
      const work = join(files.directory, options.projectName);
      fs.renameSync(files.work, work);
      files.work = work;
    } catch (error) {
      files.cleanup();
      throw error;
    }
  }
  const sockets = new Set<WebSocket>();
  let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
  let server: FakeAppServer | undefined;
  let release: string | undefined;
  let consumerPidFile: string | undefined;
  let consumerPid: number | undefined;
  let forcedKill = false;
  const output = { text: '' };
  const drains: Promise<void>[] = [];
  let closed:
    | {
        stdin: Buffer;
        consumerPid: number | null;
        consumerState: 'reaped' | 'not-started';
        consumerReaped: boolean;
        daemonReaped: boolean;
        stdinMeasured: boolean;
      }
    | undefined;
  let closeTask: Promise<NonNullable<typeof closed>> | undefined;
  let neverStarted = false;
  let startupExitedBeforeReady = false;
  let completedArgv: string | undefined;
  const rawInput = join(files.directory, 'consumer-input');
  const readyFile = join(files.directory, 'consumer-ready');
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) output.text += decoder.decode(chunk, { stream: true });
    output.text += decoder.decode();
  };
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
    if (consumerPid === undefined) return !proc || neverStarted; // Missing evidence is never a reaped consumer.
    try {
      process.kill(consumerPid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
  }
  function close(): Promise<NonNullable<typeof closed>> {
    closeTask ??= performClose();
    return closeTask;
  }
  async function performClose(): Promise<NonNullable<typeof closed>> {
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
    await attempt(() => Promise.all(drains));
    // Source-traced daemon bind refusal is classified only after its actual output is complete.
    neverStarted =
      startupExitedBeforeReady &&
      options.mode !== 'wrapper' &&
      options.port !== undefined &&
      proc?.exitCode === 1 &&
      !forcedKill &&
      output.text.includes('TLS_START_FAILED: cannot start the configured secure listener.') &&
      consumerPidFile !== undefined &&
      !fs.existsSync(consumerPidFile) &&
      !fs.existsSync(readyFile) &&
      completedArgv !== undefined &&
      !fs.existsSync(completedArgv);
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
    const daemonReaped = !proc || proc.exitCode !== null;
    // Snapshot actual raw bytes only after the owning daemon and recorded consumer ended.
    let stdin: Buffer = Buffer.alloc(0);
    let stdinMeasured = false;
    if (ended && consumerPid !== undefined) {
      await attempt(() => {
        if (!fs.lstatSync(rawInput).isFile())
          throw new Error('Raw input witness is not a regular file');
        stdin = fs.readFileSync(rawInput);
        stdinMeasured = true;
      });
      if (!stdinMeasured)
        errors.push(new Error('Raw input witness missing or unreadable; fixture retained'));
    }
    if (daemonReaped && ended && (consumerPid === undefined || stdinMeasured))
      await attempt(() => files.cleanup());
    else
      errors.push(
        new Error('Owned download CLI/consumer death was not confirmed; fixture retained'),
      );
    if (errors.length) throw new AggregateError(errors, 'Owned download CLI cleanup failed');
    closed = {
      stdin,
      consumerPid: consumerPid ?? null,
      consumerState: consumerPid === undefined ? 'not-started' : 'reaped',
      consumerReaped: consumerPid !== undefined && ended,
      daemonReaped,
      stdinMeasured,
    };
    return closed;
  }
  try {
    const harness = options.harness ?? 'claude';
    fs.mkdirSync(join(files.userHome, harness === 'claude' ? '.claude' : '.codex'), {
      mode: 0o700,
    });
    let configuration =
      options.tls === false ? files.config.replace(files.tlsTable, '') : files.config;
    if (options.relay === 'config' || options.relay === 'off')
      configuration = configuration.replace('relay=false', 'relay=true');
    fs.writeFileSync(files.configPath, configuration);
    const agents = installFakeAgents(files.directory, { [harness]: true });
    completedArgv = join(agents.codexDir, 'argv');
    const bin = agents.env['PATH']?.split(':')[0];
    if (!bin) throw new Error('Owned agent path absent');
    consumerPidFile = join(files.directory, 'consumer-pid');
    const consumer = join(files.directory, 'raw-consumer.ts');
    fs.writeFileSync(
      consumer,
      `import * as fs from 'node:fs';
const input=${JSON.stringify(rawInput)},pid=${JSON.stringify(consumerPidFile)},ready=${JSON.stringify(readyFile)};
if(!process.stdin.isTTY)throw Error('Owned consumer needs actual PTY');
fs.writeFileSync(input,'',{mode:0o600});
process.stdin.setRawMode(true);
process.stdin.on('data',(bytes)=>fs.appendFileSync(input,bytes));
process.stdin.resume();
fs.writeFileSync(pid+'.tmp',String(process.pid),{mode:0o600});fs.renameSync(pid+'.tmp',pid);
${
  harness === 'codex'
    ? `const d=${JSON.stringify(agents.codexDir)};
fs.writeFileSync(d+'/cwd',process.cwd(),{mode:0o600});fs.writeFileSync(d+'/pid',String(process.pid),{mode:0o600});
fs.writeFileSync(d+'/argv.tmp',process.argv.slice(2).join('\\n')+'\\n',{mode:0o600});fs.renameSync(d+'/argv.tmp',d+'/argv');`
    : ''
}
fs.writeFileSync(ready,'ready',{mode:0o600});
await new Promise<void>((resolve)=>{
 const stop=()=>{process.stdin.destroy();resolve();};
 process.on('SIGTERM',stop);process.on('SIGHUP',stop);process.stdin.on('end',resolve);
});
`,
      { mode: 0o600 },
    );
    fs.writeFileSync(
      join(bin, harness),
      `#!/bin/sh\nexec '${process.execPath}' '${consumer}' "$@"\n`,
      { mode: 0o700 },
    );
    if (harness === 'codex') server = FakeAppServer.start();
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
        ...(options.relay === 'flag'
          ? ['--relay']
          : options.relay === 'config'
            ? []
            : ['--no-relay']),
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
    drains.push(drain(proc.stdout), drain(proc.stderr));
    void Promise.all(drains).catch(() => {});
    options.observe?.({ files, proc });
    await until(
      () => {
        if (proc?.exitCode !== null) {
          startupExitedBeforeReady = true;
          throw new Error(`Owned download CLI startup failed (${proc?.exitCode})`);
        }
        return harness === 'claude'
          ? fs.existsSync(readyFile)
          : fs.existsSync(readyFile) &&
              fs.existsSync(join(agents.codexDir, 'argv')) &&
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
      const id = `${options.threadNamespace ?? '01950000'}-0000-7000-8000-${(thread++).toString(16).padStart(12, '0')}`;
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

/** Actual shipping source CLI child on the same owned encrypted relay transport. */
export async function relayFileDownloadCliFixture(
  options: NonNullable<Parameters<typeof fileDownloadCliFixture>[0]> = {},
) {
  const f = await fileDownloadCliFixture({
    ...options,
    tls: false,
    relay: options.relay ?? 'flag',
  });
  let delegated = false;
  try {
    const monitoring = await f.peer();
    const sessionId = monitoring.hello().sessionId;
    if (!sessionId) throw Error('Owned CLI session absent');
    const identity = await unlockIdentity(f.identity);
    delegated = true;
    return await relayMachineFixture({
      ...f,
      identity,
      storedIdentity: f.identity,
      sessionId,
      pid: f.proc.pid,
    });
  } catch (error) {
    if (!delegated) {
      try {
        await f.close();
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'Owned relay CLI startup cleanup failed');
      }
    }
    throw error;
  }
}
