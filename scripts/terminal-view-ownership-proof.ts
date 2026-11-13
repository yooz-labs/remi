import assert from 'node:assert/strict';
import { runTerminalNetworkPeer } from '../packages/daemon/tests/helpers/terminal-native-pair.ts';
import { runOwnedTerminalOutputChild } from '../packages/daemon/tests/helpers/terminal-output-child.ts';
import {
  holdTerminalViewLock,
  runRemoteTerminalViews,
  runTerminalOwnershipOwner,
  runTerminalOwnershipProof,
} from '../packages/daemon/tests/helpers/terminal-view-ownership-proof.ts';
const args = process.argv.slice(2);
const command = Bun.main.startsWith('/$bunfs/')
  ? [process.execPath]
  : [process.execPath, '--no-env-file', import.meta.path];
if (args[0] === '--terminal-peer') {
  assert(args[1] && args[2], 'owned network peer arguments present');
  await runTerminalNetworkPeer(args[1], args[2], args.includes('--stable-peer'));
} else if (args[0] === '--owned-output-child') {
  assert(args[1], 'owned output prefix present');
  await runOwnedTerminalOutputChild(args[1], args[2] ?? '');
} else if (args[0] === '--terminal-lock') {
  assert(args[1] && args[2], 'owned lock arguments present');
  holdTerminalViewLock(args[1], args[2]);
} else if (args[0] === '--remote-views') {
  assert(args[1] && args[2] && args[3], 'owned remote view arguments present');
  await runRemoteTerminalViews(args[1], args[2], args[3], command);
} else if (args[0] === '--terminal-owner') {
  assert(args[1] && args[2], 'owned scenario and home present');
  console.info(JSON.stringify(await runTerminalOwnershipOwner(args[1], args[2], command)));
} else
  console.info(
    JSON.stringify({
      status: 'passed',
      version: Bun.version,
      revision: Bun.revision,
      platform: process.platform,
      architecture: process.arch,
      groups: await runTerminalOwnershipProof(command),
    }),
  );
