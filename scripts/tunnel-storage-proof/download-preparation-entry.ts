export {};
if (!process.argv.includes('--owned-spike')) process.exit(2);
if (process.argv.includes('--reservation-storage') || process.argv.includes('--reservation-child'))
  await import('./reserved-copy-entry');
else if (process.argv.includes('--managed-download-only'))
  console.log(
    JSON.stringify(await (await import('./download-preparation-probe')).downloadPreparationProbe()),
  );
else {
  const receipt = await (await import('./reservation-probe')).reservationProbe();
  const composition = await (await import('./reserved-copy-probe')).reservedCopyProbe();
  const download = await (await import('./download-preparation-probe')).downloadPreparationProbe();
  console.log(
    JSON.stringify({
      ...receipt,
      checks: [...receipt.checks, ...composition.checks, ...download.checks],
      copyMeasurements: composition.measurements,
      downloadMeasurements: download.measurements,
      scope: download.scope,
    }),
  );
}
