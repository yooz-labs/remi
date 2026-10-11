export {};
if (!process.argv.includes('--owned-spike')) process.exit(2);
const child = process.argv.indexOf('--settlement-child');
if (child >= 0) {
  if (process.argv.length !== child + 3) process.exit(2);
  await (await import('./settlement-probe')).settlementChild(
    process.argv[child + 1] ?? '',
    process.argv[child + 2] ?? '',
  );
} else if (
  process.argv.includes('--recovery-child') ||
  process.argv.includes('--reservation-storage') ||
  process.argv.includes('--reservation-child')
) {
  await import('./recovery-entry');
} else {
  const receipt = await (await import('./reservation-probe')).reservationProbe();
  const composition = await (await import('./reserved-copy-probe')).reservedCopyProbe();
  const recovery = await (await import('./recovery-probe')).recoveryProbe();
  const settlement = await (await import('./settlement-probe')).settlementProbe();
  console.log(
    JSON.stringify({
      ...receipt,
      checks: [...receipt.checks, ...composition.checks, ...recovery.checks, ...settlement.checks],
      copyMeasurements: composition.measurements,
      recovery,
      settlement,
      parentMemoryAtReceipt: process.memoryUsage(),
      scope: settlement.scope,
    }),
  );
}
