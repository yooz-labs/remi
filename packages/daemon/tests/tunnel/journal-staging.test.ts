import { expect, test } from 'bun:test';
import { journalStagingProbe } from '../../../../scripts/tunnel-storage-proof/journal-staging-cases';

test('journal staging constructs actual closed readers and retains filesystem accounting', async () => {
  const receipt = await journalStagingProbe();
  expect(receipt.checks).toHaveLength(35);
  expect(new Set(receipt.checks).size).toBe(receipt.checks.length);
  expect(receipt.children).toHaveLength(14);
  for (const child of receipt.children) {
    expect(child.awaitedExit).toBe(true);
    expect(child.missingAfterExit).toBe(true);
    expect(child.signal).toBe('SIGKILL');
  }
});
