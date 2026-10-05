/** Child of first-connect process tests; all paths are owned temporary directories. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { IdentityStore } from '../src/auth/identity-store.ts';
const [dir, mode] = process.argv.slice(2);
if (!dir || !mode) throw new Error('store directory and operation required');
const store = new IdentityStore(dir);
const keys = JSON.parse(fs.readFileSync(path.join(dir, 'worker-public.json'), 'utf8')) as string[];
fs.writeFileSync(path.join(dir, `ready-${mode}`), 'ready');
while (!fs.existsSync(path.join(dir, 'go'))) await Bun.sleep(5);
if (mode === 'approve')
  for (const fp of keys.slice(10)) await store.authorizePendingKey(fp, 'approved');
if (mode === 'revoke') for (const fp of keys.slice(0, 10)) store.removeAuthorizedKey(fp);
if (mode === 'touch')
  for (let i = 0; i < 200; i++) for (const fp of keys) store.touchAuthorizedKey(fp);
