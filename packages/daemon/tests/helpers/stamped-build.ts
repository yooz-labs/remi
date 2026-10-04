/**
 * A real copy of the daemon's source that reports another version (#1204 round 2, P1).
 *
 * `cli.ts` reads its version from the `package.json` three directories above it, so the only way
 * to run a build that reports `0.7.16-p1204.1` (what `bump-version.sh set` stamps on a PR build,
 * and what AGENTS.md recommends for test builds) is to run it from a tree whose `package.json`
 * says so. The copy is the same code, so nothing is stubbed: the hub and every child it starts run
 * `cli.ts` from this tree and report this version. A symlink would not do (the runtime resolves it
 * to the real path and reads the real version); `@remi/shared` and the other dependencies resolve
 * through a link to the real `node_modules`, so the shared package is the repo's own.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const DAEMON = path.resolve(import.meta.dir, '..', '..');

export interface StampedBuild {
  /** The `cli.ts` of the copy: run it with `bun`. */
  readonly cliPath: string;
  /** Delete the copy. */
  remove(): void;
}

export function copyBuild(version: string): StampedBuild {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-build-'));
  const daemon = path.join(root, 'packages', 'daemon');
  fs.mkdirSync(daemon, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'remi', version }));
  fs.cpSync(path.join(DAEMON, 'src'), path.join(daemon, 'src'), { recursive: true });
  fs.symlinkSync(path.join(DAEMON, 'node_modules'), path.join(daemon, 'node_modules'));
  return {
    cliPath: path.join(daemon, 'src', 'cli.ts'),
    remove: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
