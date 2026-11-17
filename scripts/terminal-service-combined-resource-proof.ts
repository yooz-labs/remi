/** Two real daemon owners, shared home and eight signed TLS views; no held-No claim. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IdentityStore } from '../packages/daemon/src/auth/identity-store.ts';
import { TERMINAL_RESERVATION_LIMITS } from '../packages/daemon/src/terminal/reservations.ts';
import {
  ownedTerminalResourceFiles,
  publishResourceReceipt,
} from '../packages/daemon/tests/helpers/terminal-service-resource-support.ts';
const args = process.argv.slice(2);
const required = (flag: string) => {
  const value = args[args.indexOf(flag) + 1];
  assert(args.includes(flag) && value);
  return value;
};
const files = ownedTerminalResourceFiles(required('--terminal-tls-root'));
const ownerBinary = required('--terminal-owner-binary');
const prefix = join(files.directory, 'coordination');
const trust = new IdentityStore(join(files.home, 'auth'));
await trust.generate();
const children: {
  child: ReturnType<typeof Bun.spawn>;
  stdout: Promise<string>;
  stderr: Promise<string>;
}[] = [];
const phase = (index: number, name: string) => `${prefix}.${index}.${name}`;
const read = (path: string) => JSON.parse(fs.readFileSync(path, 'utf8'));
const signal = (index: number, name: string) =>
  publishResourceReceipt(phase(index, name), { go: true });
const until = async (check: () => boolean, name: string) => {
  const end = performance.now() + 60000;
  while (!check()) {
    for (const owner of children) {
      if (owner.child.exitCode !== null && owner.child.exitCode !== 0)
        throw new Error(`Owned resource actor exited: ${await owner.stderr}`);
    }
    assert(performance.now() < end, `owned combined orchestration deadline: ${name}`);
    await Bun.sleep(5);
  }
};
const wait = (index: number, name: string) => until(() => fs.existsSync(phase(index, name)), name);
const ledger = () =>
  read(join(files.home, 'terminal-view/reservations.json')) as {
    policy: { models: number; modelBytes: number; homeBytes: number };
    records: { kind: string; pid: number; session: string }[];
  };
const spawn = (index: number) => {
  const child = Bun.spawn(
    [
      ownerBinary,
      '--terminal-tls-root',
      required('--terminal-tls-root'),
      '--terminal-shared-home',
      files.home,
      '--terminal-service-coordination',
      prefix,
      '--terminal-service-owner',
      String(index),
      '--terminal-resource-evidence',
      phase(index, 'evidence'),
      ...(args.includes('--utf16-escaped') ? ['--utf16-escaped'] : []),
    ],
    {
      detached: true,
      cwd: files.directory,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        HOME: files.userHome,
        REMI_HOME: files.home,
        TMPDIR: tmpdir(),
        PATH: process.env['PATH'] ?? '/usr/bin:/bin',
        LANG: 'en_US.UTF-8',
      },
    },
  );
  children.push({
    child,
    stdout: new Response(child.stdout).text(),
    stderr: new Response(child.stderr).text(),
  });
  return child;
};
const ownerGroup = (pid: number) => {
  if (process.platform === 'linux') {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/u);
    return { parent: Number(fields[1]), group: Number(fields[2]) };
  }
  const probe = Bun.spawnSync(['/bin/ps', '-p', String(pid), '-o', 'ppid=', '-o', 'pgid=']);
  assert.equal(probe.exitCode, 0);
  const [parent, group] = probe.stdout.toString().trim().split(/\s+/u).map(Number);
  return { parent, group };
};
let passed = false;
try {
  spawn(0);
  await wait(0, 'network');
  assert.deepEqual(ownerGroup(children[0]?.child.pid ?? 0), {
    parent: process.pid,
    group: children[0]?.child.pid,
  });
  spawn(1);
  await wait(1, 'network');
  assert.deepEqual(ownerGroup(children[1]?.child.pid ?? 0), {
    parent: process.pid,
    group: children[1]?.child.pid,
  });
  const sessions = [read(phase(0, 'network')), read(phase(1, 'network'))];
  assert.deepEqual(
    sessions.map((row) => row.pid),
    children.map((row) => row.child.pid),
  );
  for (const index of [0, 1]) signal(index, 'baseline-go');
  for (const index of [0, 1]) {
    await wait(index, 'baseline');
    assert(read(phase(index, 'baseline')).modelAbsent);
  }
  signal(0, 'admit-go');
  await wait(0, 'opened');
  signal(1, 'admit-go');
  await wait(1, 'opened');
  const assertHome = () => {
    const state = ledger();
    assert.deepEqual(state.policy, { models: 8, modelBytes: 4194304, homeBytes: 33554432 });
    assert.equal(state.records.filter((row) => row.kind === 'model').length, 2);
    assert.equal(state.records.filter((row) => row.kind === 'view').length, 8);
    assert.deepEqual(
      [...new Set(state.records.map((row) => row.pid))].sort(),
      children.map((row) => row.child.pid).sort(),
    );
    assert.deepEqual(
      [...new Set(state.records.map((row) => row.session))].sort(),
      sessions.map((row) => row.sessionId).sort(),
    );
  };
  assertHome();
  signal(0, 'measure-go');
  await wait(0, 'measured');
  signal(1, 'measure-go');
  await wait(1, 'measured');
  const evidence = [read(phase(0, 'measured')), read(phase(1, 'measured'))];
  assertHome();
  for (const index of [0, 1]) signal(index, 'audit-go');
  for (const index of [0, 1]) {
    await wait(index, 'held');
    assert.deepEqual(read(phase(index, 'held')), {
      views: 4,
      intents: 4,
      frames: 1,
      stopped: true,
    });
  }
  assertHome();
  const combinedPeakDelta = evidence.reduce((sum, item) => sum + item.conservativePeakDelta, 0);
  assert(
    evidence.every(
      (item) =>
        item.budget === TERMINAL_RESERVATION_LIMITS.modelBytes &&
        item.conservativePeakDelta <= item.budget,
    ),
  );
  assert(
    combinedPeakDelta <= 2 * TERMINAL_RESERVATION_LIMITS.modelBytes,
    'two actual model conservative peak sum remains within eight MiB',
  );
  for (const index of [0, 1]) {
    signal(index, 'finish-go');
    const owner = children[index];
    assert(owner);
    await until(() => owner.child.exitCode !== null, 'owned resource actor reaped');
    assert.equal(await owner.child.exited, 0, await owner.stderr);
    assert.equal(await owner.stderr, '');
    const result = JSON.parse((await owner.stdout).trim().split('\n').at(-1) ?? '');
    assert.equal(result.status, 'passed-one-model-resource-only');
    assert.equal(result.actualChildInputBytes, 0);
    assert.throws(() => process.kill(owner.child.pid, 0), { code: 'ESRCH' });
  }
  assert.equal(ledger().records.length, 0, 'all shared-home physical charges released');
  passed = true;
  console.log(
    JSON.stringify({
      status: 'passed-combined-resource-only',
      version: Bun.version,
      revision: Bun.revision,
      actualOwners: 2,
      actualViews: 8,
      combinedPeakDelta,
      budget: 2 * TERMINAL_RESERVATION_LIMITS.modelBytes,
      evidence,
      actualChildInputBytes: 0,
      scope:
        'two real owner processes and shared home; peak sum conservative, not OS ceiling or held-No/caller acceptance',
    }),
  );
} finally {
  if (!passed) {
    for (const index of [0, 1])
      for (const name of ['baseline-go', 'admit-go', 'measure-go', 'audit-go', 'finish-go'])
        signal(index, name);
    const cleanupEnd = performance.now() + 15000;
    while (
      children.some((owner) => owner.child.exitCode === null) &&
      performance.now() < cleanupEnd
    )
      await Bun.sleep(5);
    for (const owner of children)
      if (owner.child.exitCode === null) {
        // Only this still-owned detached child group; resume any stopped packet peers first.
        const group = ownerGroup(owner.child.pid);
        assert.deepEqual(group, { parent: process.pid, group: owner.child.pid });
        process.kill(-owner.child.pid, 'SIGCONT');
        process.kill(-owner.child.pid, 'SIGTERM');
        await owner.child.exited;
        console.error('Owned combined actor required forced group cleanup', owner.child.pid);
      }
    console.error('Owned combined resource evidence retained', files.directory);
  } else files.cleanup();
}
