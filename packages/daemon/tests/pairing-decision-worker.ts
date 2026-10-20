/** Child of the pairing decision race (#1275): approves, rejects or cancels one code when told to go. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { IdentityStore } from '../src/auth/identity-store.ts';

const [dir, action] = process.argv.slice(2);
if (!dir || !action) throw new Error('store directory and action required');
const { nonce, fingerprint } = JSON.parse(fs.readFileSync(path.join(dir, 'race.json'), 'utf8')) as {
  nonce: string;
  fingerprint: string;
};
const store = new IdentityStore(dir);
fs.writeFileSync(path.join(dir, `ready-${action}`), 'ready');
while (!fs.existsSync(path.join(dir, 'go'))) await Bun.sleep(1);
let outcome: string;
try {
  if (action === 'approve') {
    await store.approvePairing(nonce, fingerprint);
    outcome = 'done';
  } else {
    const changed = action === 'reject' ? store.rejectPairing(nonce) : store.cancelPairing(nonce);
    outcome = changed ? 'done' : 'refused';
  }
} catch {
  outcome = 'refused';
}
process.stdout.write(outcome);
