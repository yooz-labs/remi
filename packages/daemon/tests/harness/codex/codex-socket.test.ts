import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { type Server, createServer } from 'node:net';
import { basename, dirname, join } from 'node:path';
import { AppServerClient } from '../../../src/harness/codex/app-server-client.ts';
import {
  UntrustedSocketError,
  resolveCodexSocketPath,
} from '../../../src/harness/codex/codex-socket.ts';
import { FakeAppServer, socketDir } from '../../helpers/fake-app-server.ts';

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** Listen on a unix socket at `file` (its directory must exist), so `lstat` says "socket". */
async function listen(file: string): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(file, resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return server;
}

interface Layout {
  codexHome: string;
  /** `<codexHome>/app-server-control`, where the link or socket sits. */
  controlDir: string;
  /** A directory beside it, where a link's target can sit. */
  targetDir: string;
  link: string;
}

function makeLayout(modes: { control?: number; target?: number } = {}): Layout {
  const base = socketDir('remi-sock-', 'home/app-server-control/app-server-control.sock');
  cleanups.push(() => {
    chmodSync(join(base, 'home', 'app-server-control'), 0o700);
    chmodSync(join(base, 'target'), 0o700);
    rmSync(base, { recursive: true, force: true });
  });
  const codexHome = join(base, 'home');
  const controlDir = join(codexHome, 'app-server-control');
  const targetDir = join(base, 'target');
  mkdirSync(controlDir, { recursive: true });
  mkdirSync(targetDir);
  chmodSync(controlDir, modes.control ?? 0o700);
  chmodSync(targetDir, modes.target ?? 0o700);
  return { codexHome, controlDir, targetDir, link: join(controlDir, 'app-server-control.sock') };
}

const env = (l: Layout) => ({ CODEX_HOME: l.codexHome });

describe('resolveCodexSocketPath', () => {
  test('follows the layout Codex uses, a link to a short socket path, and the result connects', async () => {
    const server = FakeAppServer.start();
    cleanups.push(() => server.stop());
    const resolved = resolveCodexSocketPath({ CODEX_HOME: server.codexHome });
    expect(resolved).toBe(
      join(realpathSync(dirname(server.socketPath)), basename(server.socketPath)),
    );

    let ready!: () => void;
    const isReady = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const client = new AppServerClient(
      { socketPath: () => resolved, clientInfo: { name: 'remi', title: null, version: 'test' } },
      (event) => {
        if (event.type === 'ready') ready();
      },
    );
    cleanups.push(() => client.stop());
    client.start();
    await Promise.race([
      isReady,
      Bun.sleep(5000).then(() => {
        throw new Error('the resolved socket path did not connect');
      }),
    ]);
  });

  test('a socket directly in the control directory resolves to itself', async () => {
    const l = makeLayout();
    await listen(l.link);
    expect(resolveCodexSocketPath(env(l))).toBe(join(realpathSync(l.controlDir), basename(l.link)));
  });

  test('a link with a relative target and one with an absolute target both resolve to the socket', async () => {
    const l = makeLayout();
    await listen(join(l.targetDir, 's.sock'));
    const expected = join(realpathSync(l.targetDir), 's.sock');

    symlinkSync('../../target/s.sock', l.link);
    expect(resolveCodexSocketPath(env(l))).toBe(expected);
    rmSync(l.link);
    symlinkSync(join(l.targetDir, 's.sock'), l.link);
    expect(resolveCodexSocketPath(env(l))).toBe(expected);
  });

  test('without CODEX_HOME it looks under the home directory, in .codex', async () => {
    const l = makeLayout();
    await listen(l.link);
    // `<base>/home` plays the home directory, so it needs a `.codex` that is the layout's `home`.
    const home = dirname(l.codexHome);
    symlinkSync(l.codexHome, join(home, '.codex'));
    expect(resolveCodexSocketPath({}, { homedir: home })).toBe(
      join(realpathSync(l.controlDir), basename(l.link)),
    );
    expect(resolveCodexSocketPath({ CODEX_HOME: '' }, { homedir: home })).toBe(
      join(realpathSync(l.controlDir), basename(l.link)),
    );
  });

  test('a control directory open to group or others is refused, whichever bit is set', async () => {
    for (const mode of [0o755, 0o770, 0o707, 0o750, 0o705]) {
      const l = makeLayout({ control: mode });
      await listen(l.link);
      let error: unknown;
      try {
        resolveCodexSocketPath(env(l));
      } catch (e) {
        error = e;
      }
      expect(error, mode.toString(8)).toBeInstanceOf(UntrustedSocketError);
      expect((error as Error).message).toContain('open to group or others');
    }
  });

  test('the socket directory behind a link is held to the same rule', async () => {
    const l = makeLayout({ target: 0o755 });
    await listen(join(l.targetDir, 's.sock'));
    symlinkSync(join(l.targetDir, 's.sock'), l.link);
    expect(() => resolveCodexSocketPath(env(l))).toThrow(UntrustedSocketError);
  });

  test('a directory owned by another user is refused', async () => {
    const l = makeLayout();
    await listen(l.link);
    const uid = process.getuid?.() ?? 0;
    expect(() => resolveCodexSocketPath(env(l), { uid: uid + 1 })).toThrow(
      'not owned by this user',
    );
    expect(resolveCodexSocketPath(env(l), { uid })).toContain('app-server-control.sock');
  });

  test('a missing directory, a missing socket and a dangling link are "not there yet", not distrust', async () => {
    const missing = join(socketDir('remi-sock-', 'x'), 'no-such-home');
    cleanups.push(() => rmSync(dirname(missing), { recursive: true, force: true }));
    const l = makeLayout();
    const dangling = makeLayout();
    symlinkSync(join(dangling.targetDir, 'gone.sock'), dangling.link);
    for (const [name, home] of [
      ['no home', missing],
      ['no socket', l.codexHome],
      ['dangling link', dangling.codexHome],
    ] as const) {
      let error: unknown;
      try {
        resolveCodexSocketPath({ CODEX_HOME: home });
      } catch (e) {
        error = e;
      }
      expect(error, name).toBeInstanceOf(Error);
      expect(error, name).not.toBeInstanceOf(UntrustedSocketError);
      expect((error as Error).message, name).toContain('does not exist');
    }
  });

  test('anything that is not a socket is refused: a file, a link to a file, a chain of links', async () => {
    const file = makeLayout();
    writeFileSync(file.link, '');
    expect(() => resolveCodexSocketPath(env(file))).toThrow('not a socket');

    const toFile = makeLayout();
    writeFileSync(join(toFile.targetDir, 'plain'), '');
    symlinkSync(join(toFile.targetDir, 'plain'), toFile.link);
    expect(() => resolveCodexSocketPath(env(toFile))).toThrow('not a socket');

    const chain = makeLayout();
    await listen(join(chain.targetDir, 's.sock'));
    symlinkSync(join(chain.targetDir, 's.sock'), join(chain.targetDir, 'hop'));
    symlinkSync(join(chain.targetDir, 'hop'), chain.link);
    expect(() => resolveCodexSocketPath(env(chain))).toThrow('not a socket');
  });

  test('a control path that is a file, not a directory, is refused', () => {
    const l = makeLayout();
    rmSync(l.controlDir, { recursive: true });
    writeFileSync(l.controlDir, '');
    expect(() => resolveCodexSocketPath(env(l))).toThrow('not a directory');
  });
});
