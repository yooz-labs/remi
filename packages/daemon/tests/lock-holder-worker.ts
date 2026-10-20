/** Holds the identity store's interprocess lock for a while (#1281 review): what a busy writer does. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { withInterprocessFileLock } from '../src/storage/interprocess-file-lock.ts';

const [dir, ms] = process.argv.slice(2);
if (!dir || !ms) throw new Error('store directory and hold time required');
withInterprocessFileLock(path.join(dir, 'authorized_keys.json'), () => {
  fs.writeFileSync(path.join(dir, 'lock-held'), '');
  Bun.sleepSync(Number(ms));
});
