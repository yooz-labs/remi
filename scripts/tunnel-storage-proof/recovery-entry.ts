export {};
if (!process.argv.includes('--owned-spike')) process.exit(2);
const recoveryIndex = process.argv.indexOf('--recovery-child');
if (recoveryIndex >= 0) {
  const args = process.argv.slice(recoveryIndex + 1);
  if (args.length !== 3) process.exit(2);
  await (await import('./recovery-probe')).recoveryChild(
    args[0] ?? '',
    args[1] ?? '',
    args[2] ?? '',
  );
} else if (
  process.argv.includes('--reservation-storage') ||
  process.argv.includes('--reservation-child')
) {
  await import('./reserved-copy-entry');
} else {
  const receipt = await (await import('./reservation-probe')).reservationProbe();
  const composition = await (await import('./reserved-copy-probe')).reservedCopyProbe();
  const recovery = await (await import('./recovery-probe')).recoveryProbe();
  console.log(
    JSON.stringify({
      ...receipt,
      checks: [...receipt.checks, ...composition.checks, ...recovery.checks],
      copyMeasurements: composition.measurements,
      recovery,
      parentMemoryAtReceipt: process.memoryUsage(),
      scope: recovery.scope,
    }),
  );
}
