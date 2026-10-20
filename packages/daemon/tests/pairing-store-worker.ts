/** Child of the pairing race test (#1275): claims one code with one key when told to go. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { IdentityStore } from '../src/auth/identity-store.ts';

const [dir, index] = process.argv.slice(2);
if (!dir || index === undefined) throw new Error('store directory and key index required');
const { nonce, keys } = JSON.parse(fs.readFileSync(path.join(dir, 'race.json'), 'utf8')) as {
  nonce: string;
  keys: string[];
};
const store = new IdentityStore(dir);
fs.writeFileSync(path.join(dir, `ready-${index}`), 'ready');
while (!fs.existsSync(path.join(dir, 'go'))) await Bun.sleep(1);
process.stdout.write(
  await store.claimPairing(nonce, keys[Number(index)] as string, `key ${index}`),
);
