/** Owned local opener helper; never imports CLI, home, identity or installed configuration. */
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { normalizeBrowserLinkURL } from '@remi/shared/browser-links';
import { exact, imageWireValue } from '@remi/shared/image-wire';
import { fromB64u } from '@remi/shared/relay/bytes';

const DEADLINE_MS = 1000;
const FRAME_BYTES = 65536;

/** Fixed self-exec argv, resolved from trusted source/compiled entry ownership. */
export function browserLinkCommand(): readonly string[] {
  return [
    ...(import.meta.path.startsWith('/$bunfs/')
      ? [process.execPath]
      : [process.execPath, '--no-env-file', resolve(import.meta.dir, '../entry.ts')]),
    '--internal-browser-link',
  ];
}

/** Canonical 32-byte per-runtime producer token; unrelated to daemon capability storage. */
export function isBrowserProducerToken(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 43) return false;
  try {
    return fromB64u(value).length === 32;
  } catch {
    return false;
  }
}

/** Internal exit status only. The outer BROWSER launcher maps every failure to fixed text/zero. */
export async function runBrowserLinkCommand(args: readonly string[]): Promise<number> {
  const until = performance.now() + DEADLINE_MS;
  try {
    if (args.length !== 2) return 1;
    const profilePath = args[0];
    const url = normalizeBrowserLinkURL(args[1]);
    if (!profilePath || !isAbsolute(profilePath) || !url) return 1;
    const directory = dirname(profilePath);
    const cwd = join(directory, 'cwd');
    if (profilePath !== join(directory, 'profile.json') || process.cwd() !== cwd) return 1;
    for (const path of [directory, cwd]) {
      const stat = lstatSync(path);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o777) !== 0o700
      )
        return 1;
    }
    if (readdirSync(cwd).length !== 0) return 1;
    const stat = lstatSync(profilePath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > FRAME_BYTES
    )
      return 1;
    const profile = imageWireValue(readFileSync(profilePath));
    if (
      !exact(profile, {
        version: (value) => value === 1,
        socketPath: (value) =>
          typeof value === 'string' &&
          isAbsolute(value) &&
          value === join(directory, 'socket') &&
          Buffer.byteLength(value) < 104,
        token: isBrowserProducerToken,
      })
    )
      return 1;
    const remaining = until - performance.now();
    if (remaining <= 0) return 1;
    const frame = Buffer.from(`${JSON.stringify({ token: profile['token'], url: args[1] })}\n`);
    if (frame.length > FRAME_BYTES) return 1;
    return await new Promise<number>((resolveResult) => {
      let done = false;
      let response = Buffer.alloc(0);
      const socket = connect({ path: profile['socketPath'] as string });
      const timer = setTimeout(() => finish(1), remaining);
      const finish = (code: number) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.destroy();
        resolveResult(code);
      };
      socket.once('connect', () => socket.write(frame));
      socket.on('data', (chunk: Buffer) => {
        if (response.length + chunk.length > 3) return finish(1);
        response = Buffer.concat([response, chunk]);
      });
      socket.once('error', () => finish(1));
      socket.once('close', () =>
        finish(response.equals(Buffer.from('OK\n')) && performance.now() <= until ? 0 : 1),
      );
    });
  } catch {
    return 1;
  }
}
