import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { runTerminalOwnershipProof } from '../helpers/terminal-view-ownership-proof.ts';
test('actual capture views and native pending projections retain exact owned accounting', async () => {
  const groups = await runTerminalOwnershipProof([
    process.execPath,
    '--no-env-file',
    resolve(import.meta.dir, '../../../../scripts/terminal-view-ownership-proof.ts'),
  ]);
  expect(groups).toHaveLength(17);
}, 45000);
