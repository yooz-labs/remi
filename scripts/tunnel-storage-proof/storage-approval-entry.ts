// Compiled roles for the storage and held-answer proof. No production upload caller exists.
import assert from 'node:assert/strict';

if (process.argv.includes('--storage-approval-client')) {
  const { runStorageApprovalClientMode } = await import('./storage-approval-client');
  await runStorageApprovalClientMode();
} else if (process.argv.includes('--reservation-storage')) {
  await import('./probe');
} else if (process.argv.includes('--reservation-child')) {
  const index = process.argv.indexOf('--reservation-child');
  const { reservationChild } = await import('./reservation-probe');
  await reservationChild(process.argv[index + 1], process.argv[index + 2], process.argv[index + 3]);
} else if (process.argv.includes('--storage-load-worker')) {
  const index = process.argv.indexOf('--storage-load-worker');
  const raw = process.argv[index + 1];
  if (!raw) throw new Error('storage load worker configuration missing');
  const { runStorageLoadWorker } = await import('./storage-approval-child');
  await runStorageLoadWorker(JSON.parse(raw));
} else {
  assert(
    process.argv.includes('--owned-spike') && process.argv.includes('--storage-approval'),
    'use --owned-spike --storage-approval for the storage approval proof',
  );
  const [{ reservationProbe }, { reservedCopyProbe }, { storageApprovalProof }] = await Promise.all(
    [
      import('./reservation-probe'),
      import('./reserved-copy-probe'),
      import('./storage-approval-probe'),
    ],
  );
  const approval = await storageApprovalProof();
  const reservation = await reservationProbe();
  const reservedCopy = await reservedCopyProbe();
  const checks = [...reservation.checks, ...reservedCopy.checks, ...approval.checks];
  assert.equal(checks.length, 47, '43 existing storage groups plus four held-answer groups');
  console.log(
    JSON.stringify({
      bun: Bun.version,
      platform: process.platform,
      arch: process.arch,
      checks,
      reservationInputSha256: reservation.reservationInputSha256,
      nativeHelperSourceSha256: approval.worker.nativeHelper.sourceSha256,
      nativeHelperOpsSourceSha256: approval.worker.nativeHelper.opsSourceSha256,
      parentMemoryAtReceipt: process.memoryUsage(),
      approvalScenarios: approval.scenarios,
      storageWorker: approval.worker,
      ptyWitnesses: approval.pty,
      ptyMutationControl: approval.ptyMutationControl,
      fixtureRootRemoved: approval.fixtureRootRemoved,
      scope:
        '43 unchanged storage controls plus actual held-answer load controls; copied proof only, with no production upload or helper adoption',
      limits:
        'Linux one CPU, 512 MiB, 64 PIDs and 32 MiB tmpfs are runner fixtures, not production enforcement; no descriptor recovery or transfer authority',
    }),
  );
}
