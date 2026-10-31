import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { resolve } from 'node:path';
import { runTerminalBudgetMigrationProof } from '../helpers/terminal-budget-migration-proof.ts';
import {
  runCrashedTerminalLockProof,
  runTerminalReservationProof,
} from '../helpers/terminal-reservations-proof.ts';

test('actual terminal reservations: files, quotas, process ownership and corruption', async () => {
  const groups = await runTerminalReservationProof([
    process.execPath,
    '--no-env-file',
    resolve(import.meta.dir, '../../../../scripts/terminal-reservations-proof.ts'),
  ]);
  expect(groups.length).toBe(29);
}, 30000);

test('actual killed terminal lock owner stays blocked until explicit repair', async () => {
  expect(
    await runCrashedTerminalLockProof([
      process.execPath,
      '--no-env-file',
      resolve(import.meta.dir, '../../../../scripts/terminal-reservations-proof.ts'),
    ]),
  ).toBe('real crashed owner requires explicit lock repair');
}, 40000);

test('the actual legacy reservation fixture preserves its published source', () => {
  const fixture = resolve(import.meta.dir, '../fixtures/terminal-reservations-v1.ts');
  const receipt = JSON.parse(fs.readFileSync(fixture.replace(/\.ts$/u, '.json'), 'utf8'));
  const archived = fs
    .readFileSync(fixture, 'utf8')
    .split('\n')
    .slice(1)
    .join('\n')
    .replaceAll("'../../src/storage/", "'../storage/");
  expect(createHash('sha256').update(archived).digest('hex')).toBe(receipt.sha256);
});

test('actual old and current terminal budget writers preserve mixed-policy ownership', async () => {
  const groups = await runTerminalBudgetMigrationProof([
    process.execPath,
    '--no-env-file',
    resolve(import.meta.dir, '../../../../scripts/terminal-reservations-proof.ts'),
  ]);
  expect(groups.length).toBe(5);
}, 30000);
