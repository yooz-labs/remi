// Compiled roles isolate real child processes; no production transfer caller.
export {};
if (!process.argv.includes('--owned-spike')) process.exit(2);
if (process.argv.includes('--reservation-storage')) {
  await import('./probe');
} else {
  const probe = await import('./reservation-probe');
  const index = process.argv.indexOf('--reservation-child');
  if (index >= 0)
    await probe.reservationChild(
      process.argv[index + 1],
      process.argv[index + 2],
      process.argv[index + 3],
    );
  else console.log(JSON.stringify(await probe.reservationProbe()));
}
