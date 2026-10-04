/**
 * Where Codex's shared app-server listens, and whether remi may trust it
 * (epic #1175, phase 3 #1177). The path is
 * `${CODEX_HOME ?? ~/.codex}/app-server-control/app-server-control.sock`, so a
 * profile that relocates `CODEX_HOME` (#1157) is not precluded.
 *
 * Codex makes that path a symlink to a short socket path elsewhere (a unix
 * socket path is 104 bytes on macOS). It cannot be resolved with `realpath`:
 * on Bun it throws `EOPNOTSUPP` for a socket and for a symlink to one (checked
 * on 1.3.11 and 1.4.2). So the DIRECTORIES are resolved with `realpath`, which
 * works on them, and the link is read with `readlink`, one hop, never followed
 * further: a chain of links is not a socket and is refused.
 *
 * The socket has no authentication of its own: whoever can connect can answer
 * an approval. Both the link's directory and the socket's directory must
 * therefore be owned by the user running remi and carry no group or other
 * permission bit, or no connection is made (`UntrustedSocketError`). On
 * Codex's own layout both are 0700 (the spike stat-checked them).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export class UntrustedSocketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UntrustedSocketError';
  }
}

const CONTROL_DIR = 'app-server-control';
const SOCKET_NAME = 'app-server-control.sock';

/**
 * `dir` resolved through symlinks, if it is a directory only this user can use. `label` says
 * which one it is in a refusal: the `link` directory holds the symlink, the `socket` directory
 * holds the real socket it points to.
 */
function trustedDirectory(dir: string, uid: number, label: 'link' | 'socket'): string {
  let real: string;
  let stat: fs.Stats;
  try {
    real = fs.realpathSync(dir);
    stat = fs.statSync(real);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('the Codex control socket does not exist (yet)');
    }
    throw error;
  }
  if (!stat.isDirectory()) {
    throw new UntrustedSocketError(`the Codex ${label} path ${real} is not a directory`);
  }
  if (stat.uid !== uid) {
    throw new UntrustedSocketError(
      `the Codex ${label} directory ${real} is not owned by this user (owned by uid ${stat.uid}, expected ${uid}); remi will not connect through it`,
    );
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new UntrustedSocketError(
      `the Codex ${label} directory ${real} is open to group or others (mode ${(stat.mode & 0o777).toString(8)}); remi will not connect through it until you run chmod 700 on it`,
    );
  }
  return real;
}

/**
 * The unix socket of the shared Codex app-server, for a connect, or a throw: an
 * `UntrustedSocketError` when it must not be used, another error (never a
 * secret in its message) when it is not there. `opts.uid` and `opts.homedir`
 * exist for tests; the defaults are this process's user and home.
 */
export function resolveCodexSocketPath(
  env: Readonly<Record<string, string | undefined>>,
  opts: { uid?: number; homedir?: string } = {},
): string {
  const uid = opts.uid ?? process.getuid?.();
  if (uid === undefined) throw new UntrustedSocketError('cannot tell which user runs remi');
  const codexHome = env['CODEX_HOME']
    ? path.resolve(env['CODEX_HOME'])
    : path.join(opts.homedir ?? os.homedir(), '.codex');

  const linkDir = trustedDirectory(path.join(codexHome, CONTROL_DIR), uid, 'link');
  let socket = path.join(linkDir, SOCKET_NAME);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(socket);
    if (stat.isSymbolicLink()) {
      const target = path.resolve(linkDir, fs.readlinkSync(socket));
      socket = path.join(
        trustedDirectory(path.dirname(target), uid, 'socket'),
        path.basename(target),
      );
      stat = fs.lstatSync(socket);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('the Codex control socket does not exist (yet)');
    }
    throw error;
  }
  if (!stat.isSocket()) throw new UntrustedSocketError('the Codex control path is not a socket');
  return socket;
}
