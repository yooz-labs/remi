/** Real producer lifetime plus actual shipping source/copied/compiled Claude-shaped consumers. */
import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  type ProtocolMessage,
  type UUID,
  createAuthResponse,
  createHello,
  createIdentity,
  createSessionListRequest,
  fromBase64,
  serialize,
  sign,
  unlockIdentity,
} from '@remi/shared';
import { WebSocketAdapter } from '../../src/adapters/websocket-adapter.ts';
import { MessageAPI } from '../../src/api/message-api.ts';
import { Authenticator } from '../../src/auth/authenticator.ts';
import { IdentityStore } from '../../src/auth/identity-store.ts';
import { createConnectionHandlers } from '../../src/cli/handlers/connection-events.ts';
import { setPrimarySessionId } from '../../src/cli/session-state.ts';
import { PTYSession } from '../../src/pty/pty-session.ts';
import { SessionBindingStore } from '../../src/session/session-binding-store.ts';
import { SessionRegistry } from '../../src/session/session-registry.ts';
import { SessionStore } from '../../src/session/session-store.ts';
import { TranscriptIndex } from '../../src/session/transcript-index.ts';
import {
  type BrowserLinkLaunch,
  BrowserLinkSessionHost,
} from '../../src/tunnel/browser-link-session-host.ts';
import { until } from '../helpers/browser-link-service-fixture.ts';
import { directTlsFixture } from '../helpers/direct-tls-fixture.ts';
import { copyBuild } from '../helpers/stamped-build.ts';

function core(longRoot = false) {
  const files = directTlsFixture();
  const id = crypto.randomUUID() as UUID;
  const binding = crypto.randomUUID();
  const registry = new SessionRegistry(
    {},
    {
      onSessionClosed: (sessionId, reason) => host.retireSession(sessionId, reason !== 'pty_exit'),
    },
  );
  const store = new SessionStore(join(files.home, 'sessions.json'));
  const mirror = join(files.home, 'transcript-index.json');
  const bindings = new SessionBindingStore(store, new TranscriptIndex(mirror), {
    beforeWrite: (id) => host.beforeBindingWrite(id),
    afterCommit: (id, expected, verified) => host.afterBindingCommit(id, expected, verified),
  });
  const host = new BrowserLinkSessionHost({
    sessions: registry,
    bindings,
    service: () => undefined,
    temporaryRoot: longRoot
      ? fs.mkdtempSync(join(files.directory, 'x'.repeat(80)))
      : files.directory,
  });
  bindings.preAssign({
    remiSessionId: id,
    claudeSessionId: binding,
    projectPath: files.work,
    port: 1,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    exitedAt: null,
    exitCode: null,
  });
  let launch: BrowserLinkLaunch | undefined;
  let pty: PTYSession | undefined;
  return {
    files,
    id,
    binding,
    host,
    registry,
    bindings,
    mirror,
    async prepare() {
      launch = await host.prepare(id, binding);
      return launch;
    },
    async start(command = '/bin/cat') {
      if (!launch) throw Error('prepare first');
      const capturedLaunch = launch;
      pty = new PTYSession(
        { command, cwd: files.work, env: files.env },
        {
          onExit: () => {
            capturedLaunch.consumerEnded();
            registry.handlePTYExit(id);
          },
        },
      );
      launch.attach(pty);
      registry.registerSession(id, files.work, pty, new MessageAPI({ sessionId: id }), true);
      launch.starting();
      await pty.start();
      launch.started();
      return pty;
    },
    async close() {
      await host.closeAll();
      await registry.shutdown();
      files.cleanup();
    },
  };
}
test('actual pending producer cancellation joins allocation and proves no consumer was spawned', async () => {
  const f = core();
  try {
    const pending = f.host.prepare(f.id, f.binding);
    const closing = f.host.closeAll();
    await expect(pending).rejects.toThrow('Browser link session unavailable');
    await closing;
    expect(await f.host.waitForStartup()).toBe(false);
    expect(fs.readdirSync(f.files.directory).filter((x) => x.startsWith('remi-bl-'))).toEqual([]);
  } finally {
    await f.close();
  }
});
test('unstarted disposal refuses later start and removes launcher only with never-spawned proof', async () => {
  const f = core();
  try {
    const launch = await f.prepare();
    const path = launch.browserPath;
    expect(fs.existsSync(path)).toBe(true);
    launch.dispose();
    expect(() => launch.starting()).toThrow();
    await f.host.closeAll();
    expect(fs.existsSync(path)).toBe(false);
  } finally {
    await f.close();
  }
});
test('real PTY binding writes rotate same-ID and A-B-A markers, failed publication never restores readiness', async () => {
  const f = core();
  try {
    const launch = await f.prepare();
    await f.start();
    const first = f.host.contextFor(f.id);
    if (!first) throw Error('Missing actual ready context');
    f.bindings.update(f.id, f.binding);
    const second = f.host.contextFor(f.id);
    if (!second) throw Error('Missing actual rotated context');
    expect(second.runtime).not.toBe(first.runtime);
    const b = crypto.randomUUID();
    f.bindings.update(f.id, b);
    expect(f.host.contextFor(f.id)?.binding.harnessSessionId).toBe(b);
    f.bindings.update(f.id, f.binding);
    expect(f.host.contextFor(f.id)?.runtime).not.toBe(second.runtime);
    const profile = join(dirname(launch.browserPath), 'profile.json');
    fs.rmSync(profile);
    fs.mkdirSync(profile);
    expect(() => f.bindings.update(f.id, f.binding)).toThrow('Browser link session unavailable');
    expect(f.host.contextFor(f.id)).toBeNull();
    expect(f.bindings.getIdentity(f.id)?.harnessSessionId).toBe(f.binding);
    fs.rmSync(profile, { recursive: true });
  } finally {
    await f.close();
  }
});
for (const removed of [false, true])
  test(`actual ${removed ? 'removed registry forced' : 'ordinary captured'} consumer exit precedes launcher removal`, async () => {
    const f = core();
    try {
      const launch = await f.prepare();
      const pty = await f.start();
      const path = launch.browserPath;
      expect(f.host.contextFor(f.id)).not.toBeNull();
      if (removed) f.registry.closeSession(f.id, 'forced');
      else {
        f.host.retireSession(f.id);
        expect(fs.existsSync(path)).toBe(true);
        await pty.close();
      }
      await f.host.closeAll();
      expect(pty.sessionState).toBe('exited');
      expect(fs.existsSync(path)).toBe(false);
    } finally {
      await f.close();
    }
  });
test('post-spawn startup invalidation joins the actual exit before retiring producer files', async () => {
  const f = core();
  try {
    const launch = await f.prepare();
    const pty = await f.start();
    f.host.beforeBindingWrite(f.id);
    expect(() => launch.started()).toThrow();
    await launch.failed();
    expect(pty.sessionState).toBe('exited');
    expect(fs.existsSync(launch.browserPath)).toBe(false);
  } finally {
    await f.close();
  }
});

test('actual overlong Unix path startup failure cleans the owned allocation without a PTY', async () => {
  const f = core(true);
  try {
    await expect(f.prepare()).rejects.toThrow('Browser link session unavailable');
    expect(f.host.contextFor(f.id)).toBeNull();
    expect(f.registry.getSession(f.id)).toBeUndefined();
  } finally {
    await f.close();
  }
});
test('actual absolute executable spawn failure proves no consumer and joins launcher cleanup', async () => {
  const f = core();
  try {
    const launch = await f.prepare();
    await expect(f.start(join(f.files.directory, 'absent-executable'))).rejects.toThrow();
    await launch.failed();
    expect(fs.existsSync(launch.browserPath)).toBe(false);
  } finally {
    await f.close();
  }
});
test('real mirror write failure clears readiness before a committed binding and never restores it', async () => {
  const f = core();
  try {
    await f.prepare();
    await f.start();
    fs.rmSync(f.mirror);
    fs.mkdirSync(f.mirror);
    const b = crypto.randomUUID();
    expect(() => f.bindings.update(f.id, b)).toThrow();
    expect(f.host.contextFor(f.id)).toBeNull();
    expect(f.bindings.getIdentity(f.id)?.harnessSessionId).toBe(b);
    fs.rmSync(f.mirror, { recursive: true });
  } finally {
    await f.close();
  }
});
test('actual permanent producer retirement clears readiness once while a live consumer retains its launcher', async () => {
  const f = core();
  try {
    const launch = await f.prepare();
    const pty = await f.start();
    const records = Reflect.get(f.host, 'records') as Map<
      string,
      { producer: import('../../src/tunnel/browser-link-producer.ts').BrowserLinkProducerRuntime }
    >;
    const producer = records.get(f.id)?.producer;
    if (!producer) throw Error('Missing actual producer');
    producer.retire();
    producer.retire();
    expect(f.host.contextFor(f.id)).toBeNull();
    expect(pty.isRunning).toBe(true);
    expect(fs.existsSync(launch.browserPath)).toBe(true);
    expect(() => launch.started()).toThrow();
    await f.host.closeAll();
    expect(pty.sessionState).toBe('exited');
    expect(fs.existsSync(launch.browserPath)).toBe(false);
  } finally {
    await f.close();
  }
});

const entry = resolve(import.meta.dir, '../../src/entry.ts');
for (const layout of ['source', 'copied', 'compiled'] as const)
  test(`shipping ${layout} entry: ready BROWSER -> actual UDS -> signed TLS candidate and scoped descriptor`, async () => {
    const f = directTlsFixture();
    let build: ReturnType<typeof copyBuild> | undefined;
    let proc: Bun.Subprocess | undefined;
    let ws: WebSocket | undefined;
    let compiled: string | undefined;
    let browserPath: string | undefined;
    try {
      let argv = [process.execPath, '--no-env-file', entry];
      if (layout === 'copied') {
        build = copyBuild('0.7.17-c3.1');
        argv = [process.execPath, '--no-env-file', join(dirname(build.cliPath), 'entry.ts')];
        expect(
          fs.realpathSync(Bun.resolveSync('@remi/shared/browser-links', dirname(build.cliPath))),
        ).toBe(resolve(import.meta.dir, '../../../shared/src/browser-links.ts'));
      }
      if (layout === 'compiled') {
        compiled = join(f.directory, 'remi-compiled');
        const r = Bun.spawn(
          [process.execPath, '--no-env-file', 'build', '--compile', entry, '--outfile', compiled],
          { env: f.env, stdout: 'pipe', stderr: 'pipe' },
        );
        const code = await r.exited;
        const err = await new Response(r.stderr).text();
        expect(code, err).toBe(0);
        argv = [compiled];
      }
      const early = Bun.spawn([...argv, '--internal-browser-link', 'malformed'], {
        env: f.env,
        cwd: f.work,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(await early.exited).toBe(1);
      expect(await new Response(early.stdout).text()).toBe('');
      expect(await new Response(early.stderr).text()).toBe('');
      expect(fs.readdirSync(f.home).sort()).toEqual(['certs', 'config.toml']);
      const bin = join(f.directory, 'bin');
      fs.mkdirSync(bin);
      fs.writeFileSync(
        join(bin, 'claude'),
        `#!/bin/sh\nprintf '%s' "$BROWSER" > '${join(f.directory, 'browser-path')}'\nwhile [ ! -e '${join(f.directory, 'invoke')}' ]; do sleep 0.02; done\n"$BROWSER" 'https://example.test/browser-link?literal=%26hello'\nprintf done > '${join(f.directory, 'invoked')}'\nwhile [ ! -e '${join(f.directory, 'release')}' ]; do sleep 0.02; done\n`,
        { mode: 0o700 },
      );
      const trust = new IdentityStore(f.home);
      await trust.generate();
      const identity = await unlockIdentity(await createIdentity());
      await trust.addAuthorizedKey(identity.publicKeyRaw, 'owned C3');
      const portHolder = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: () => new Response('owned'),
      });
      const port = portHolder.port;
      if (port === undefined) throw Error('No held port');
      portHolder.stop(true);
      proc = Bun.spawn(
        [
          ...argv,
          '--daemon',
          '--port',
          String(port),
          '--dir',
          f.work,
          '--no-mdns',
          '--no-telegram',
        ],
        {
          cwd: f.work,
          env: { ...f.env, PATH: `${bin}:/opt/homebrew/bin:/usr/bin:/bin` },
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const logs: string[] = [];
      for (const stream of [proc.stdout, proc.stderr])
        if (typeof stream !== 'number' && stream)
          void (async () => {
            for await (const chunk of stream) logs.push(new TextDecoder().decode(chunk));
          })();
      await until(
        () => fs.existsSync(join(f.directory, 'browser-path')) || proc?.exitCode !== null,
        'shipping consumer',
        15000,
      );
      expect(proc.exitCode, logs.join('')).toBeNull();
      browserPath = fs.readFileSync(join(f.directory, 'browser-path'), 'utf8');
      expect(fs.existsSync(browserPath)).toBe(true);
      expect(browserPath).not.toContain('token');
      const received: ProtocolMessage[] = [];
      ws = new WebSocket(`wss://127.0.0.1:${port}/ws`, { tls: { ca: f.ca } } as never);
      ws.onmessage = async (e) => {
        const m = JSON.parse(String(e.data)) as ProtocolMessage;
        received.push(m);
        if (m.type === 'auth_challenge')
          ws?.send(
            serialize(
              createAuthResponse(
                identity.publicKeyRaw,
                await sign(identity.privateKey, fromBase64(m.challenge)),
                identity.fingerprint,
              ),
            ),
          );
        else if (m.type === 'auth_result' && m.success)
          ws?.send(serialize(createHello(crypto.randomUUID(), 'C3')));
      };
      await until(
        () => received.some((m) => m.type === 'hello_ack'),
        'shipping attached hello',
        15000,
      );
      const hello = received.find((m) => m.type === 'hello_ack');
      if (!hello?.sessionId || !hello.harnessSessionId)
        throw Error('Missing shipping attached hello');
      expect(hello.sessionId).toBeString();
      expect(hello.harness).toBe('claude');
      expect(hello.capabilities).toContain('browser_links');
      expect(hello.machine?.capabilities).toEqual(hello.capabilities);
      ws.send(
        JSON.stringify({
          type: 'browser_link_receiver_request',
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          sessionId: hello.sessionId,
          binding: { harness: 'claude', harnessSessionId: hello.harnessSessionId },
          seq: 1,
          action: 'select',
        }),
      );
      await until(
        () => received.some((m) => m.type === 'browser_link_receiver_result'),
        'selected receiver',
      );
      expect(received.find((m) => m.type === 'browser_link_receiver_result')?.outcome).toBe(
        'selected',
      );
      fs.writeFileSync(join(f.directory, 'invoke'), 'owned');
      await until(
        () => received.some((m) => m.type === 'browser_link_candidate'),
        'actual BROWSER candidate',
      );
      expect(received.find((m) => m.type === 'browser_link_candidate')?.url).toBe(
        'https://example.test/browser-link?literal=%26hello',
      );
      ws.send(serialize(createSessionListRequest()));
      await until(() => received.some((m) => m.type === 'session_list_response'), 'base-only list');
      const list = received.find((m) => m.type === 'session_list_response');
      expect(JSON.stringify(list)).not.toContain('browser_links');
      expect(logs.join('')).not.toContain('https://example.test/browser-link');
      fs.writeFileSync(join(f.directory, 'release'), 'owned');
      await until(() => proc?.exitCode !== null, 'ordinary shipping consumer cleanup', 15000);
      expect(await proc.exited, logs.join('')).toBe(0);
      expect(fs.existsSync(browserPath)).toBe(false);
    } finally {
      ws?.close();
      if (proc && proc.exitCode === null) {
        proc.kill('SIGTERM');
        await proc.exited;
      }
      build?.remove();
      f.cleanup();
    }
  }, 30000);

for (const fault of ['mirror', 'producer'] as const)
  test(`shipping TLS ${fault} startup failure never launches a BROWSER consumer and marks the preassigned row exited`, async () => {
    const f = directTlsFixture();
    let proc: Bun.Subprocess | undefined;
    try {
      const bin = join(f.directory, 'bin');
      fs.mkdirSync(bin);
      const marker = join(f.directory, 'consumer-started');
      fs.writeFileSync(
        join(bin, 'claude'),
        `#!/bin/sh\nprintf started > '${marker}'\nwhile :; do sleep 1; done\n`,
        { mode: 0o700 },
      );
      if (fault === 'mirror') fs.mkdirSync(join(f.home, 'transcript-index.json'));
      const tempRoot =
        fault === 'producer' ? fs.mkdtempSync(join(f.directory, 'x'.repeat(80))) : f.directory;
      const holder = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: () => new Response('held'),
      });
      const port = holder.port;
      if (port === undefined) throw Error('No owned held port');
      holder.stop(true);
      const running = Bun.spawn(
        [
          process.execPath,
          '--no-env-file',
          entry,
          '--daemon',
          '--port',
          String(port),
          '--dir',
          f.work,
          '--no-mdns',
          '--no-telegram',
        ],
        {
          cwd: f.work,
          env: { ...f.env, TMPDIR: tempRoot, PATH: `${bin}:/opt/homebrew/bin:/usr/bin:/bin` },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      proc = running;
      const [code, out, err] = await Promise.all([
        running.exited,
        new Response(running.stdout).text(),
        new Response(running.stderr).text(),
      ]);
      expect(code, out + err).toBe(1);
      expect(fs.existsSync(marker)).toBe(false);
      expect(out + err).not.toContain('-----BEGIN');
      const rows = new SessionStore(join(f.home, 'sessions.json')).list();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.exitedAt).toBeString();
      expect(fs.readdirSync(tempRoot).filter((name) => name.startsWith('remi-bl-'))).toEqual([]);
    } finally {
      if (proc && proc.exitCode === null) {
        proc.kill('SIGTERM');
        await proc.exited;
      }
      f.cleanup();
    }
  }, 20000);
test('shipping TLS-off mirror write failure keeps the legacy fail-soft launch behavior', async () => {
  const f = directTlsFixture();
  let proc: Bun.Subprocess | undefined;
  try {
    fs.writeFileSync(f.configPath, f.config.replace(f.tlsTable, ''));
    fs.mkdirSync(join(f.home, 'transcript-index.json'));
    const bin = join(f.directory, 'bin');
    fs.mkdirSync(bin);
    const marker = join(f.directory, 'consumer-started');
    fs.writeFileSync(
      join(bin, 'claude'),
      `#!/bin/sh\nprintf '%s' "$BROWSER" > '${marker}'\nwhile :; do sleep 1; done\n`,
      { mode: 0o700 },
    );
    const holder = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('held') });
    const port = holder.port;
    if (port === undefined) throw Error('No owned held port');
    holder.stop(true);
    proc = Bun.spawn(
      [
        process.execPath,
        '--no-env-file',
        entry,
        '--daemon',
        '--port',
        String(port),
        '--dir',
        f.work,
        '--no-mdns',
        '--no-telegram',
      ],
      {
        cwd: f.work,
        env: {
          ...f.env,
          PATH: `${bin}:/opt/homebrew/bin:/usr/bin:/bin`,
          BROWSER: '/owned-legacy-browser-not-invoked',
        },
        stdout: 'ignore',
        stderr: 'ignore',
      },
    );
    await until(
      () => fs.existsSync(marker) || proc?.exitCode !== null,
      'legacy mirror fail-soft consumer',
      10000,
    );
    expect(proc.exitCode).toBeNull();
    expect(fs.readFileSync(marker, 'utf8')).toBe('/owned-legacy-browser-not-invoked');
  } finally {
    if (proc && proc.exitCode === null) {
      proc.kill('SIGTERM');
      await proc.exited;
    }
    f.cleanup();
  }
}, 15000);

for (const action of ['ready', 'cancel', 'disconnect', 'regrant', 'late_cancel'] as const)
  test(`actual pending Host + signed TLS attachment barrier: ${action}`, async () => {
    const f = core();
    let adapter: WebSocketAdapter | undefined;
    let ws: WebSocket | undefined;
    try {
      const trust = new IdentityStore(join(f.files.home, 'barrier-auth'));
      await trust.generate();
      const identity = await unlockIdentity(await createIdentity());
      await trust.addAuthorizedKey(identity.publicKeyRaw, 'owned barrier');
      const holder = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: () => new Response('held'),
      });
      const port = holder.port;
      if (port === undefined) throw Error('No owned held port');
      holder.stop(true);
      const entered: string[] = [];
      const received: ProtocolMessage[] = [];
      let completed = 0;
      const handlers = createConnectionHandlers({
        sessionRegistry: f.registry,
        currentOwnedSession: () => ({
          sessionId: f.id,
          claudeSessionId: f.binding as UUID,
          transcriptPath: null,
          identity: { harness: 'claude', harnessSessionId: f.binding },
        }),
        harnessId: 'claude',
        hubMode: false,
        harnesses: () => ['claude'],
        beforeAttach: (id) => f.host.waitForConnection(id, actual, trust),
        trackConnection: () => {},
        untrackConnection: () => {},
        onConnectionAdded: () => {},
        onConnectionRemoved: () => {},
        cancelOrphanTimeout: () => {},
        send: (id, message) => actual.sendRaw(id, message),
        remiVersion: 'owned-C3',
      });
      const actual = new WebSocketAdapter(
        {
          host: '127.0.0.1',
          port,
          tls: f.files.tls,
          authenticator: new Authenticator({
            identity: await trust.unlock(),
            identityStore: trust,
          }),
        },
        {
          onConnect: async (id, metadata) => {
            entered.push(id);
            try {
              await handlers.onConnect(id, metadata);
            } finally {
              completed++;
            }
          },
          onDisconnect: handlers.onDisconnect,
        },
      );
      adapter = actual;
      await actual.start();
      setPrimarySessionId(f.id);
      if (action === 'late_cancel') f.host.cancelAll();
      const peer = new WebSocket(`wss://127.0.0.1:${port}/ws`, {
        tls: { ca: f.files.ca },
      } as never);
      ws = peer;
      peer.onmessage = async (e) => {
        const m = JSON.parse(String(e.data)) as ProtocolMessage;
        received.push(m);
        if (m.type === 'auth_challenge')
          peer.send(
            serialize(
              createAuthResponse(
                identity.publicKeyRaw,
                await sign(identity.privateKey, fromBase64(m.challenge)),
                identity.fingerprint,
              ),
            ),
          );
        else if (m.type === 'auth_result' && m.success)
          peer.send(serialize(createHello(crypto.randomUUID(), 'pending-barrier')));
      };
      await until(() => entered.length === 1, 'actual authenticated pending connection');
      if (action === 'late_cancel') {
        await until(
          () =>
            peer.readyState === WebSocket.CLOSED || received.some((m) => m.type === 'hello_ack'),
          'post-cancellation signed peer outcome',
        );
        expect(peer.readyState).toBe(WebSocket.CLOSED);
        expect(received.some((m) => m.type === 'hello_ack')).toBe(false);
        return;
      }
      expect(f.host.pending).toBe(true);
      expect(received.some((m) => m.type === 'hello_ack')).toBe(false);
      expect(completed).toBe(0);
      if (action === 'cancel') f.host.cancelAll();
      else {
        if (action === 'disconnect') {
          peer.close();
          await until(() => peer.readyState === WebSocket.CLOSED, 'pending peer closed');
        }
        if (action === 'regrant') {
          await trust.removeAuthorizedKey(identity.fingerprint);
          await trust.addAuthorizedKey(identity.publicKeyRaw, 'same key new grant');
        }
        await f.prepare();
        await f.start();
        f.host.finishStartup(true);
      }
      await until(() => completed === 1, 'actual pending attachment guard resolved');
      if (action === 'ready') {
        await until(
          () => received.some((m) => m.type === 'hello_ack'),
          'attached hello after ready',
        );
        expect(received.find((m) => m.type === 'hello_ack')?.sessionId).toBe(f.id);
        expect(f.registry.getSession(f.id)?.attachedConnections.size).toBe(1);
      } else {
        await until(
          () =>
            peer.readyState === WebSocket.CLOSED || received.some((m) => m.type === 'hello_ack'),
          'noncurrent pending peer outcome',
        );
        expect(peer.readyState).toBe(WebSocket.CLOSED);
        expect(received.some((m) => m.type === 'hello_ack')).toBe(false);
        expect(f.registry.getSession(f.id)?.attachedConnections.size ?? 0).toBe(0);
      }
    } finally {
      setPrimarySessionId(null);
      ws?.close();
      await adapter?.stop();
      await f.close();
    }
  }, 15000);
