import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { runTerminalReservationProof } from '../helpers/terminal-reservations-proof.ts';

test('actual terminal reservations: files, quotas, process ownership and corruption', async () => {
  const groups = await runTerminalReservationProof([
    process.execPath,
    '--no-env-file',
    resolve(import.meta.dir, '../../../../scripts/terminal-reservations-proof.ts'),
  ]);
  expect(groups.length).toBe(29);
}, 30000);
