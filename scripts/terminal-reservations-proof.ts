import {
  runTerminalReservationChild,
  runTerminalReservationProof,
} from '../packages/daemon/tests/helpers/terminal-reservations-proof.ts';

const args = process.argv.slice(2);
if (args[0] === '--terminal-reservation-child') await runTerminalReservationChild(args.slice(1));
else {
  const command =
    args[0] === '--compiled'
      ? [process.execPath]
      : [process.execPath, '--no-env-file', import.meta.path];
  const groups = await runTerminalReservationProof(command);
  console.info(
    JSON.stringify({
      status: 'passed',
      version: Bun.version,
      runtime: Bun.revision,
      platform: process.platform,
      arch: process.arch,
      groups,
    }),
  );
}
