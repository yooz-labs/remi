// Standalone compiled roles; no production transfer caller.
export {};
if (!process.argv.includes('--owned-spike')) process.exit(2);
if (process.argv.includes('--reservation-storage')) await import('./probe');
else {
  const reservation = await import('./reservation-probe');
  const index = process.argv.indexOf('--reservation-child');
  if (index >= 0)
    await reservation.reservationChild(
      process.argv[index + 1],
      process.argv[index + 2],
      process.argv[index + 3],
    );
  else {
    const receipt = await reservation.reservationProbe();
    const integration = await (await import('./reserved-copy-probe')).reservedCopyProbe();
    console.log(
      JSON.stringify({
        ...receipt,
        checks: [...receipt.checks, ...integration.checks],
        copyMeasurements: integration.measurements,
        parentMemoryAtReceipt: process.memoryUsage(),
        scope:
          'trusted metadata reserved private-copy composition; no recovery, transfer authority or production adoption',
        accountingFailureLimit:
          'cleanupConfirmed proves deletion only; metadata commit and durable acknowledgment may be uncertain',
      }),
    );
  }
}
