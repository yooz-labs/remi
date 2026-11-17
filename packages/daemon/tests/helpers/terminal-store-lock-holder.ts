/** A real held store-file lock for owned source/compiled terminal qualification. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { withInterprocessFileLockNonblocking } from '../../src/storage/interprocess-file-lock.ts';
export function runTerminalStoreLockHolder(args: readonly string[]) {
  const [file, prefix] = args;
  assert(file && prefix);
  withInterprocessFileLockNonblocking(file, () => {
    fs.writeFileSync(`${prefix}.ready`, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
    const end = performance.now() + 10000;
    while (!fs.existsSync(`${prefix}.go`)) {
      assert(performance.now() < end, 'owned actual store lock release deadline');
      Bun.sleepSync(1);
    }
  });
}
if (import.meta.main) runTerminalStoreLockHolder(process.argv.slice(2));
