/** Owned IPC/process controls only; no installed Claude, Linux execution or shipping availability. */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { type Server, type Socket, connect as connectUnix, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { normalizeBrowserLinkURL } from '../../../shared/src/browser-links.ts';
import { PTYSession } from '../../src/pty/pty-session.ts';
import { writeRestrictedJson } from '../../src/storage/restricted-json.ts';
import { browserLinkCommand } from '../../src/tunnel/browser-link-command.ts';
import {
  type BrowserLinkProducerContext,
  BrowserLinkProducerRuntime,
} from '../../src/tunnel/browser-link-producer.ts';

const ENTRY = resolve(import.meta.dir, '../../src/entry.ts');
const MODULE = resolve(import.meta.dir, '../../src/tunnel/browser-link-producer.ts');
const FAILURE = 'Browser link unavailable\n';
const URL_TEXT = "https://example.invalid/a\"b?value=a b&literal=$(never);quote='x'#fragment";
const context = (): BrowserLinkProducerContext => ({
  sessionId: randomUUID(),
  binding: { harness: 'claude', harnessSessionId: randomUUID() },
  runtime: {},
});
const envFor = (home: string) => ({
  PATH: process.env['PATH'] ?? '/usr/bin:/bin',
  HOME: home,
  REMI_HOME: 'relative-refusal-control',
  TMPDIR: tmpdir(),
  NO_COLOR: '1',
});

async function bounded<T>(work: Promise<T>, ms = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Owned browser producer deadline')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

let home: string;

async function child(argv: string[], cwd: string) {
  const process = Bun.spawn(argv, {
    cwd,
    env: envFor(home),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  try {
    const [exit, stdout, stderr] = await bounded(
      Promise.all([
        process.exited,
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
      ]),
      30_000,
    );
    return { exit, stdout, stderr };
  } finally {
    if (process.exitCode === null) {
      process.kill('SIGKILL');
      await process.exited;
    }
  }
}

describe('dormant browser producer: real Unix framing, owned launcher and actual entry', () => {
  let hostSource: string;
  let compiledHost: string;
  let compiledEntry: string;
  const runtimes: BrowserLinkProducerRuntime[] = [];
  const paths: string[] = [];
  const requests: Socket[] = [];
  const children: ReturnType<typeof Bun.spawn>[] = [];

  beforeAll(async () => {
    home = fs.mkdtempSync(join(tmpdir(), 'remi-bp-test-'));
    fs.chmodSync(home, 0o700);
    hostSource = join(home, 'host.ts');
    const binaryDirectory = join(home, 'long-self-exec-path-'.repeat(7), 'with spaces');
    fs.mkdirSync(binaryDirectory, { recursive: true, mode: 0o700 });
    compiledHost = join(binaryDirectory, 'compiled-host');
    compiledEntry = join(home, 'compiled-entry');
    fs.writeFileSync(
      hostSource,
      `
      if (process.argv[2] === '--internal-browser-link') {
        await import(${JSON.stringify(ENTRY)});
      } else {
        const fs = await import('node:fs');
        const {BrowserLinkProducerRuntime} = await import(${JSON.stringify(MODULE)});
        const owner = process.argv[2];
        const context = {sessionId:${JSON.stringify(randomUUID())},binding:{harness:'claude',harnessSessionId:${JSON.stringify(randomUUID())}},runtime:{}};
        const runtime = new BrowserLinkProducerRuntime({context,temporaryRoot:${JSON.stringify(tmpdir())},offer(c,url){
          fs.appendFileSync(owner+'/offers.jsonl',JSON.stringify({url,sameRuntime:c.runtime===context.runtime})+'\\n',{mode:0o600}); return true;
        }});
        await runtime.start();
        fs.writeFileSync(owner+'/ready.json',JSON.stringify({browserPath:runtime.browserPath}),{mode:0o600});
        await Bun.stdin.text();
        await runtime.close();
      }
    `,
      { mode: 0o600 },
    );
    for (const [source, output] of [
      [hostSource, compiledHost],
      [ENTRY, compiledEntry],
    ]) {
      const result = await child(
        [
          process.execPath,
          '--no-env-file',
          'build',
          '--compile',
          source as string,
          '--outfile',
          output as string,
        ],
        home,
      );
      expect(result.exit).toBe(0);
    }
  }, 60_000);

  afterEach(async () => {
    for (const pending of requests.splice(0)) pending.destroy();
    for (const process of children) if (process.exitCode === null) process.kill('SIGKILL');
    await Promise.all(children.splice(0).map((process) => process.exited));
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
    for (const path of paths.splice(0)) fs.rmSync(path, { recursive: true, force: true });
  });
  afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

  async function start(
    offer: (context: BrowserLinkProducerContext, url: string) => boolean = () => true,
  ) {
    const runtime = new BrowserLinkProducerRuntime({
      context: context(),
      offer,
      temporaryRoot: tmpdir(),
    });
    runtimes.push(runtime);
    await runtime.start();
    return runtime;
  }
  function profile(runtime: BrowserLinkProducerRuntime) {
    return JSON.parse(
      fs.readFileSync(join(dirname(runtime.browserPath), 'profile.json'), 'utf8'),
    ) as { version: 1; socketPath: string; token: string };
  }
  function post(
    runtime: BrowserLinkProducerRuntime,
    raw: string | Uint8Array,
    token = profile(runtime).token,
    options: { held?: boolean; rawFrame?: boolean } = {},
  ) {
    const bytes = Buffer.from(raw);
    const frame = options.rawFrame
      ? bytes
      : Buffer.concat([
          Buffer.from(`{"token":${JSON.stringify(token)},`),
          bytes.subarray(1),
          Buffer.from('\n'),
        ]);
    const outgoing = connectUnix(profile(runtime).socketPath);
    requests.push(outgoing);
    let response = Buffer.alloc(0);
    const result = new Promise<string>((resolveResult) => {
      outgoing.on('data', (chunk: Buffer) => {
        response = Buffer.concat([response, chunk]);
      });
      outgoing.on('error', () => resolveResult(''));
      outgoing.once('close', () => resolveResult(response.toString('utf8')));
    });
    if (!options.held) outgoing.once('connect', () => outgoing.write(frame));
    return { outgoing, result, frame };
  }
  async function status(
    runtime: BrowserLinkProducerRuntime,
    raw: string | Uint8Array,
    token?: string,
  ) {
    return bounded(post(runtime, raw, token).result);
  }
  async function hold(runtime: BrowserLinkProducerRuntime, raw: string, token?: string) {
    // Observe actual owned accept/data events without replacing a callback or adding a test hook.
    const accepted = once(Reflect.get(runtime, 'server') as Server, 'connection');
    const pending = post(runtime, raw, token, { held: true });
    const [socket] = (await bounded(accepted)) as [Socket];
    const received = once(socket, 'data');
    pending.outgoing.write(pending.frame.subarray(0, 1));
    await bounded(received);
    return { ...pending, socket, remaining: pending.frame.subarray(1) };
  }
  async function outer(runtime: BrowserLinkProducerRuntime, args = [URL_TEXT]) {
    return child([runtime.browserPath, ...args], home);
  }

  test('restricted publication, canonical URL/context, exact profile and joined idempotent cleanup', async () => {
    const seen: Array<{ context: BrowserLinkProducerContext; url: string }> = [];
    const runtime = await start((context, url) => {
      seen.push({ context, url });
      return true;
    });
    const base = dirname(runtime.browserPath);
    const data = profile(runtime);
    expect(Object.keys(data).sort()).toEqual(['socketPath', 'token', 'version']);
    expect(data.token.length).toBe(43);
    expect(Buffer.from(data.token, 'base64url').length).toBe(32);
    expect(Buffer.byteLength(data.socketPath)).toBeLessThan(104);
    expect(/\s/u.test(runtime.browserPath)).toBe(false);
    for (const [path, mode] of [
      [base, 0o700],
      [runtime.browserPath, 0o700],
      [join(base, 'profile.json'), 0o600],
      [data.socketPath, 0o600],
    ] as const)
      expect(fs.statSync(path).mode & 0o777).toBe(mode);
    expect(fs.readdirSync(join(base, 'cwd'))).toEqual([]);
    expect(await status(runtime, JSON.stringify({ url: URL_TEXT }))).toBe('OK\n');
    expect(seen.length).toBe(1);
    expect(seen[0]?.url === normalizeBrowserLinkURL(URL_TEXT)).toBe(true);
    expect(Object.isFrozen(seen[0]?.context)).toBe(true);
    expect(Object.isFrozen(seen[0]?.context.binding)).toBe(true);
    expect(fs.readFileSync(runtime.browserPath, 'utf8').includes(data.token)).toBe(false);
    await runtime.close();
    await runtime.close();
    expect(fs.existsSync(base)).toBe(false);
  });

  test('missing/wrong/cross-runtime tokens and non-exact frames reject before offer', async () => {
    let effects = 0;
    const runtime = await start(() => {
      effects++;
      return true;
    });
    const other = await start();
    const raw = JSON.stringify({ url: URL_TEXT });
    for (const token of ['', randomBytes(32).toString('base64url'), profile(other).token])
      expect(await status(runtime, raw, token)).toBe('NO\n');
    for (const frame of [
      `${JSON.stringify({ url: URL_TEXT })}\n`,
      `${JSON.stringify({ token: profile(runtime).token, url: URL_TEXT, extra: true })}\n`,
      `${JSON.stringify({ token: profile(runtime).token, url: URL_TEXT })}\n{}\n`,
      `${JSON.stringify({ token: profile(runtime).token, url: URL_TEXT })}\ntrailing`,
    ])
      expect(await bounded(post(runtime, frame, undefined, { rawFrame: true }).result)).toBe(
        'NO\n',
      );
    expect(effects).toBe(0);
  });

  test('strict original UTF-8/JSON, size and accepted URL bounds discriminate malformed input', async () => {
    let effects = 0;
    const runtime = await start(() => {
      effects++;
      return true;
    });
    const valid = JSON.stringify({ url: 'https://example.invalid/' });
    for (const raw of [
      '{"url":"https://example.invalid/","u\\u0072l":"https://example.invalid/"}',
      JSON.stringify({ url: 'https://example.invalid/', extra: true }),
      JSON.stringify({ url: 1 }),
      '{"url":"https://example.invalid/\\ud800"}',
      Uint8Array.of(0xc0, 0xaf),
      JSON.stringify({ url: 'javascript:alert(1)' }),
      JSON.stringify({ url: 'https://user:pass@example.invalid/' }),
      JSON.stringify({ url: `https://example.invalid/${'a'.repeat(4096)}` }),
      valid + ' '.repeat(65537 - Buffer.byteLength(valid)),
    ])
      expect(await status(runtime, raw)).toBe('NO\n');
    expect(effects).toBe(0);
    expect(await status(runtime, valid)).toBe('OK\n');
    expect(effects).toBe(1);
    const object = JSON.stringify({
      token: profile(runtime).token,
      url: 'https://example.invalid/',
    });
    const exactFrame = `${object}${' '.repeat(65535 - Buffer.byteLength(object))}\n`;
    expect(Buffer.byteLength(exactFrame)).toBe(65536);
    expect(await bounded(post(runtime, exactFrame, undefined, { rawFrame: true }).result)).toBe(
      'OK\n',
    );
    const overFrame = `${exactFrame.slice(0, -1)} \n`;
    expect(Buffer.byteLength(overFrame)).toBe(65537);
    expect(await bounded(post(runtime, overFrame, undefined, { rawFrame: true }).result)).toBe(
      'NO\n',
    );
    expect(effects).toBe(2);
  });

  test('actual accept/partial-frame barrier pins old-body rotation and retire before the synchronous offer effect', async () => {
    let effects = 0;
    const runtime = await start(() => {
      effects++;
      return true;
    });
    const old = profile(runtime);
    const raw = JSON.stringify({ url: URL_TEXT });
    const held = await hold(runtime, raw, old.token);
    runtime.rotate(context());
    held.outgoing.write(held.remaining);
    expect(await bounded(held.result)).toBe('NO\n');
    expect(effects).toBe(0);
    expect(profile(runtime).token === old.token).toBe(false);
    expect(await status(runtime, raw, old.token)).toBe('NO\n');
    expect(await status(runtime, raw)).toBe('OK\n');
    const retiring = await hold(runtime, raw);
    runtime.retire();
    retiring.outgoing.write(retiring.remaining);
    expect(await bounded(retiring.result)).toBe('NO\n');
    expect(effects).toBe(1);
    const result = await outer(runtime);
    expect(result.exit).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(FAILURE);
    expect(fs.existsSync(runtime.browserPath)).toBe(true);
    expect(() => runtime.rotate(context())).toThrow('Browser link producer unavailable');
  });

  test('four real held frames consume slots with no backlog and sockets expire on their total deadline', async () => {
    let effects = 0;
    const runtime = await start(() => {
      effects++;
      return true;
    });
    const raw = JSON.stringify({ url: URL_TEXT });
    const held = [];
    for (let i = 0; i < 4; i++) {
      const pending = await hold(runtime, raw);
      held.push(pending);
    }
    const closed = held.map((item) => once(item.socket, 'close'));
    const started = performance.now();
    // Bun may omit a reset close event: the real helper still refuses by its own total deadline.
    const overload = await outer(runtime);
    expect(overload.exit).toBe(0);
    expect(overload.stdout).toBe('');
    expect(overload.stderr).toBe(FAILURE);
    expect(effects).toBe(0);
    await bounded(Promise.all(closed), 1600);
    expect(performance.now() - started).toBeLessThan(1800);
    expect((Reflect.get(runtime, 'sockets') as Map<Socket, unknown>).size).toBe(0);
    expect(effects).toBe(0);
    expect(await status(runtime, raw)).toBe('OK\n');
  });

  test('a headerless actual Unix socket also expires at the accepted-socket deadline', async () => {
    const runtime = await start();
    const socket = connectUnix(profile(runtime).socketPath);
    try {
      await bounded(once(socket, 'connect'));
      await bounded(once(socket, 'close'), 1600);
    } finally {
      socket.destroy();
    }
  });

  test('owned temporary-root symlink preserves actual helper cwd and lifecycle guards refuse reuse', async () => {
    const link = join(home, 'short-root');
    fs.symlinkSync(tmpdir(), link);
    let effects = 0;
    const runtime = new BrowserLinkProducerRuntime({
      context: context(),
      offer: () => {
        effects++;
        return true;
      },
      temporaryRoot: link,
    });
    runtimes.push(runtime);
    expect(() => runtime.browserPath).toThrow('Browser link producer unavailable');
    await runtime.start();
    expect(runtime.browserPath.startsWith(fs.realpathSync(tmpdir()))).toBe(true);
    await expect(runtime.start()).rejects.toThrow('Browser link producer unavailable');
    expect((await outer(runtime)).stderr).toBe('');
    expect(effects).toBe(1);
    await runtime.close();
    await expect(runtime.start()).rejects.toThrow('Browser link producer unavailable');
    expect(() => runtime.rotate(context())).toThrow('Browser link producer unavailable');
  });

  test('BROWSER root grammar refuses unsafe canonical roots before allocation and safe alias uses only owned launcher', async () => {
    let effects = 0;
    for (const [index, syntax] of [':part', '%s', ' whitespace'].entries()) {
      const root = join(home, `unsafe-root-${index}${syntax}`);
      fs.mkdirSync(root, { mode: 0o700 });
      const alias = join(home, `safe-alias-${index}`);
      fs.symlinkSync(root, alias);
      for (const temporaryRoot of [root, alias]) {
        expect(
          () =>
            new BrowserLinkProducerRuntime({
              context: context(),
              offer: () => {
                effects++;
                return true;
              },
              temporaryRoot,
            }),
        ).toThrow('Browser link producer unavailable');
        expect(fs.readdirSync(root)).toEqual([]);
      }
    }
    expect(effects).toBe(0);
    const root = join(home, 'safe-root');
    fs.mkdirSync(root, { mode: 0o700 });
    const alias = join(home, 'safe-alias');
    fs.symlinkSync(root, alias);
    const runtime = new BrowserLinkProducerRuntime({
      context: context(),
      offer: () => {
        effects++;
        return true;
      },
      temporaryRoot: alias,
    });
    runtimes.push(runtime);
    await runtime.start();
    expect((await consumer(runtime.browserPath)).includes('Browser link unavailable')).toBe(false);
    expect(effects).toBe(1);
    await runtime.close();
    expect(fs.readdirSync(root)).toEqual([]);
  });

  test('startup publishes only after listening and owned publication failure rolls back resources', async () => {
    const runtime = new BrowserLinkProducerRuntime({
      context: context(),
      offer: () => true,
      temporaryRoot: tmpdir(),
    });
    runtimes.push(runtime);
    const starting = runtime.start();
    const directory = dirname(runtime.browserPath);
    expect(fs.existsSync(join(directory, 'profile.json'))).toBe(false);
    fs.mkdirSync(join(directory, 'profile.json'));
    await expect(starting).rejects.toThrow('Browser link producer unavailable');
    await runtime.close();
    expect(fs.existsSync(directory)).toBe(false);
  });

  test('callback refusal/error and profile faults yield only fixed outer errors and zero, never fallback', async () => {
    let mode = 0;
    const runtime = await start(() => {
      if (mode === 1) throw new Error('PRIVATE_CALLBACK_DIAGNOSTIC');
      return false;
    });
    for (mode of [0, 1]) {
      const result = await outer(runtime);
      expect(result.exit).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe(FAILURE);
    }
    const file = join(dirname(runtime.browserPath), 'profile.json');
    const saved = fs.readFileSync(file);
    fs.writeFileSync(file, 'private malformed profile');
    const result = await outer(runtime);
    expect(result.exit).toBe(0);
    expect(result.stderr).toBe(FAILURE);
    fs.writeFileSync(file, saved);
    for (const args of [[], [URL_TEXT, 'extra']]) {
      const bad = await outer(runtime, args);
      expect(bad.exit).toBe(0);
      expect(bad.stderr).toBe(FAILURE);
    }
  });

  test('private profile shape/mode and nonempty/missing owned cwd fail with only the fixed outer error', async () => {
    let effects = 0;
    const runtime = await start(() => {
      effects++;
      return true;
    });
    const directory = dirname(runtime.browserPath);
    const file = join(directory, 'profile.json');
    const original = profile(runtime);
    const refuse = async () => {
      const result = await outer(runtime);
      expect(result.exit).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe(FAILURE);
    };
    for (const changed of [
      { ...original, extra: true },
      { ...original, version: 2 },
      { ...original, token: `${original.token}=` },
      { ...original, socketPath: join(directory, 'other') },
    ]) {
      writeRestrictedJson(file, changed);
      await refuse();
    }
    writeRestrictedJson(file, original);
    fs.chmodSync(file, 0o644);
    await refuse();
    fs.chmodSync(file, 0o600);
    const cwd = join(directory, 'cwd');
    fs.writeFileSync(join(cwd, 'unexpected'), 'owned control');
    await refuse();
    fs.rmSync(cwd, { recursive: true });
    await refuse();
    expect(effects).toBe(0);
    fs.mkdirSync(cwd, { mode: 0o700 });
    const accepted = await outer(runtime);
    expect(accepted.stderr).toBe('');
    expect(effects).toBe(1);
  });

  test('slow drip cannot reset the accepted-socket total deadline or create an offer', async () => {
    let effects = 0;
    const runtime = await start(() => {
      effects++;
      return true;
    });
    const accepted = once(Reflect.get(runtime, 'server') as Server, 'connection');
    const socket = connectUnix(profile(runtime).socketPath);
    socket.on('error', () => {});
    requests.push(socket);
    const [owned] = (await bounded(accepted)) as [Socket];
    const closed = once(owned, 'close');
    const started = performance.now();
    const drip = setInterval(() => socket.write(' '), 150);
    try {
      await bounded(closed, 1600);
      expect(performance.now() - started).toBeLessThan(1600);
      expect(effects).toBe(0);
    } finally {
      clearInterval(drip);
      socket.destroy();
    }
  });

  test('invalid context and overlong socket root fail closed, and close joins startup without publishing', async () => {
    expect(
      () =>
        new BrowserLinkProducerRuntime({
          context: { ...context(), sessionId: 'invalid' },
          offer: () => true,
          temporaryRoot: tmpdir(),
        }),
    ).toThrow('Browser link producer unavailable');
    const longRoot = join(home, 'x'.repeat(110));
    fs.mkdirSync(longRoot, { mode: 0o700 });
    const long = new BrowserLinkProducerRuntime({
      context: context(),
      offer: () => true,
      temporaryRoot: longRoot,
    });
    runtimes.push(long);
    await expect(long.start()).rejects.toThrow('Browser link producer unavailable');
    expect(fs.readdirSync(longRoot)).toEqual([]);
    const closing = new BrowserLinkProducerRuntime({
      context: context(),
      offer: () => true,
      temporaryRoot: tmpdir(),
    });
    runtimes.push(closing);
    const starting = closing.start();
    const directory = dirname(closing.browserPath);
    const settled = starting.then(
      () => true,
      () => false,
    );
    await closing.close();
    expect(await settled).toBe(false);
    expect(fs.existsSync(directory)).toBe(false);
  });

  test('failed atomic profile rotation invalidates the old token before publication and orderly close removes resources', async () => {
    let effects = 0;
    const runtime = await start(() => {
      effects++;
      return true;
    });
    const old = profile(runtime);
    const file = join(dirname(runtime.browserPath), 'profile.json');
    fs.unlinkSync(file);
    fs.mkdirSync(file);
    expect(() => runtime.rotate(context())).toThrow('Browser link producer unavailable');
    fs.rmSync(file, { recursive: true });
    writeRestrictedJson(file, old);
    expect(await status(runtime, JSON.stringify({ url: URL_TEXT }), old.token)).toBe('NO\n');
    expect(effects).toBe(0);
    const path = dirname(runtime.browserPath);
    await runtime.close();
    expect(fs.existsSync(path)).toBe(false);
  });

  test('helper total deadline is bounded against an actual nonresponding owned Unix server', async () => {
    const directory = fs.mkdtempSync(join(tmpdir(), 'remi-bl-'));
    paths.push(directory);
    fs.chmodSync(directory, 0o700);
    const cwd = join(directory, 'cwd');
    fs.mkdirSync(cwd, { mode: 0o700 });
    const socketPath = join(directory, 'socket');
    const token = randomBytes(32).toString('base64url');
    writeRestrictedJson(join(directory, 'profile.json'), { version: 1, socketPath, token });
    const sockets = new Set<Socket>();
    let effects = 0;
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      effects++;
      socket.resume();
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const started = performance.now();
      const result = await child(
        [...browserLinkCommand(), join(directory, 'profile.json'), URL_TEXT],
        cwd,
      );
      expect(result.exit).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
      expect(effects).toBe(1);
      expect(performance.now() - started).toBeLessThan(1800);
      server.removeAllListeners('connection');
      let response = Buffer.from('OK\nextra');
      server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.once('data', () => socket.end(response));
      });
      for (response of [
        Buffer.from('OK\nextra'),
        Buffer.from([0xcf, 0xcb, 10]),
        Buffer.from('OK'),
        Buffer.from('NO\n'),
      ]) {
        const refused = await child(
          [...browserLinkCommand(), join(directory, 'profile.json'), URL_TEXT],
          cwd,
        );
        expect(refused.exit).toBe(1);
        expect(refused.stdout).toBe('');
        expect(refused.stderr).toBe('');
      }
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  async function host(mode: 'source' | 'compiled') {
    const owner = fs.mkdtempSync(join(home, 'host-'));
    paths.push(owner);
    const childProcess = Bun.spawn(
      mode === 'source'
        ? [process.execPath, '--no-env-file', hostSource, owner]
        : [compiledHost, owner],
      { cwd: home, env: envFor(home), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    );
    children.push(childProcess);
    const ready = join(owner, 'ready.json');
    const until = performance.now() + 5000;
    while (!fs.existsSync(ready)) {
      if (performance.now() > until || childProcess.exitCode !== null)
        throw new Error('Owned host did not start');
      await Bun.sleep(5);
    }
    const value = JSON.parse(fs.readFileSync(ready, 'utf8')) as { browserPath: string };
    paths.push(dirname(value.browserPath));
    return { process: childProcess, owner, browserPath: value.browserPath };
  }
  async function consumer(browserPath: string) {
    const python = Bun.which('python3');
    if (!python) throw new Error('Python consumer profile unavailable');
    const script = join(home, 'consumer.py');
    fs.writeFileSync(
      script,
      `import os,sys,webbrowser\nobserved=[]\ndef audit(event,args):\n if event=='subprocess.Popen':\n  if os.fspath(args[0])!=os.environ['BROWSER']: raise RuntimeError('HOST_LAUNCH_REFUSED')\n  observed.append('owned-launcher')\nsys.addaudithook(audit)\nassert webbrowser.open(sys.argv[1]) is True\nassert observed==['owned-launcher']\nprint('CONSUMER_HANDLED')\n`,
      { mode: 0o600 },
    );
    let output = '';
    const completed = Promise.withResolvers<number | null>();
    const pty = new PTYSession(
      {
        command: python,
        args: [script, URL_TEXT],
        cwd: home,
        env: { ...envFor(home), BROWSER: browserPath },
      },
      {
        onData: (data) => {
          output += data;
        },
        onExit: (code) => completed.resolve(code),
        onError: (error) => completed.reject(error),
      },
    );
    try {
      await pty.start();
      expect(await bounded(completed.promise)).toBe(0);
      expect(output.includes('CONSUMER_HANDLED')).toBe(true);
      expect(output.includes('HOST_LAUNCH_REFUSED')).toBe(false);
      return output;
    } finally {
      await pty.close();
    }
  }

  for (const mode of ['source', 'compiled'] as const)
    test(`${mode} actual runtime/entry with real PTY BROWSER consumer, failure and closed-host handling`, async () => {
      const running = await host(mode);
      expect((await consumer(running.browserPath)).includes('Browser link unavailable')).toBe(
        false,
      );
      const offers = () =>
        fs
          .readFileSync(join(running.owner, 'offers.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
      expect(offers().length).toBe(1);
      expect(offers()[0].url === normalizeBrowserLinkURL(URL_TEXT)).toBe(true);
      expect(offers()[0].sameRuntime).toBe(true);
      if (mode === 'compiled') {
        const directory = dirname(running.browserPath);
        const direct = await child(
          [compiledEntry, '--internal-browser-link', join(directory, 'profile.json'), URL_TEXT],
          join(directory, 'cwd'),
        );
        expect(direct.exit).toBe(0);
        expect(direct.stdout).toBe('');
        expect(direct.stderr).toBe('');
        expect(offers().length).toBe(2);
        fs.renameSync(compiledHost, `${compiledHost}.held`);
        try {
          const output = await consumer(running.browserPath);
          expect(output.includes('Browser link unavailable')).toBe(true);
          expect(offers().length).toBe(2);
        } finally {
          fs.renameSync(`${compiledHost}.held`, compiledHost);
        }
      }
      running.process.stdin.end();
      expect(await bounded(running.process.exited)).toBe(0);
      expect(fs.existsSync(dirname(running.browserPath))).toBe(false);
      const abandoned = await host(mode);
      abandoned.process.kill('SIGKILL');
      await abandoned.process.exited;
      expect(fs.existsSync(abandoned.browserPath)).toBe(true);
      const output = await consumer(abandoned.browserPath);
      expect(output.includes('Browser link unavailable')).toBe(true);
    }, 20_000);

  test('selected malformed helper operands never import CLI/home/config in source or compiled entry', async () => {
    const cwd = fs.mkdtempSync(join(home, 'malformed-'));
    paths.push(cwd);
    for (const prefix of [[process.execPath, '--no-env-file', ENTRY], [compiledEntry]])
      for (const operands of [[], ['one'], ['one', 'two', 'three']]) {
        const result = await child([...prefix, '--internal-browser-link', ...operands], cwd);
        expect(result.exit).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe('');
      }
    expect(fs.existsSync(join(cwd, '.remi'))).toBe(false);
  });
});
