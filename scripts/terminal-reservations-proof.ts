import {
  runLegacyTerminalReservationChild,
  runTerminalBudgetMigrationProof,
} from '../packages/daemon/tests/helpers/terminal-budget-migration-proof.ts';
import {
  runCrashedTerminalLockProof,
  runTerminalReservationChild,
  runTerminalReservationProof,
} from '../packages/daemon/tests/helpers/terminal-reservations-proof.ts';

const args = process.argv.slice(2);
if (args[0] === '--terminal-legacy-reservation-child')
  await runLegacyTerminalReservationChild(args.slice(1));
else if (args[0] === '--terminal-reservation-child')
  await runTerminalReservationChild(args.slice(1));
else {
  const command =
    args[0] === '--compiled'
      ? [process.execPath]
      : [process.execPath, '--no-env-file', import.meta.path];
  const groups = await runTerminalReservationProof(command);
  const migrationGroups = await runTerminalBudgetMigrationProof(command);
  groups.push(await runCrashedTerminalLockProof(command));
  console.info(
    JSON.stringify({
      status: 'passed',
      version: Bun.version,
      runtime: Bun.revision,
      platform: process.platform,
      arch: process.arch,
      groups,
      migrationGroups,
    }),
  );
}
