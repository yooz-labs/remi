/** Actual archived/current readers, private metadata and kernel process ownership. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TERMINAL_RESERVATION_LIMITS,
  TerminalReservationError,
  TerminalReservations,
} from '../../src/terminal/reservations.ts';
import {
  TerminalReservationError as LegacyReservationError,
  TerminalReservations as LegacyReservations,
} from '../fixtures/terminal-reservations-v1.ts';

const file = (home: string) => join(home, 'terminal-view', 'reservations.json');
async function until(check: () => boolean) {
  const end = performance.now() + 10000;
  while (!check()) {
    assert(performance.now() < end, 'actual legacy owner barrier deadline');
    await Bun.sleep(5);
  }
}
const unavailable = (call: () => unknown) =>
  assert.throws(call, (e) => e instanceof TerminalReservationError && e.code === 'unavailable');
const legacyUnavailable = (call: () => unknown) =>
  assert.throws(call, (e) => e instanceof LegacyReservationError && e.code === 'unavailable');

export async function runLegacyTerminalReservationChild(args: readonly string[]) {
  const [home, prefix] = args;
  assert(home && prefix);
  const old = LegacyReservations.open(home);
  const model = old.reserveModel(randomUUID());
  old.reserveView(model, randomBytes(32).toString('hex'), randomUUID());
  fs.writeFileSync(`${prefix}.ready`, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  await until(() => fs.existsSync(`${prefix}.go`));
  // Deliberately exit without release: only proved process death permits the migration.
}

export async function runTerminalBudgetMigrationProof(command: readonly string[]) {
  const groups: string[] = [];
  const scenario = async (name: string, run: (home: string) => void | Promise<void>) => {
    const home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'remi-budget-policy-')));
    let passed = false;
    try {
      await run(home);
      groups.push(name);
      passed = true;
    } finally {
      if (passed) fs.rmSync(home, { recursive: true, force: true });
      else console.error('Owned budget policy evidence retained', home);
    }
  };
  await scenario('approved four MiB models preserve the 32 MiB home cap', (home) => {
    assert.equal(TERMINAL_RESERVATION_LIMITS.modelBytes, 4194304);
    assert.equal(TERMINAL_RESERVATION_LIMITS.models, 8);
    assert.equal(TERMINAL_RESERVATION_LIMITS.homeBytes, 33554432);
    const current = TerminalReservations.open(home);
    for (let index = 0; index < 8; index++) current.reserveModel(randomUUID());
    assert.throws(
      () => current.reserveModel(randomUUID()),
      (e) => e instanceof TerminalReservationError && e.code === 'busy',
    );
    const stored = JSON.parse(fs.readFileSync(file(home), 'utf8'));
    assert.equal(stored.version, 2);
    assert.deepEqual(stored.policy, { models: 8, modelBytes: 4194304, homeBytes: 33554432 });
    assert.equal(stored.records.length * stored.policy.modelBytes, 33554432);
  });
  await scenario('a live actual legacy reservation blocks migration without rewriting', (home) => {
    const old = LegacyReservations.open(home);
    const model = old.reserveModel(randomUUID());
    const view = old.reserveView(model, randomBytes(32).toString('hex'), randomUUID());
    const before = fs.readFileSync(file(home));
    unavailable(() => TerminalReservations.open(home));
    assert.deepEqual(fs.readFileSync(file(home)), before);
    assert(old.owns(model) && old.owns(view));
    assert(old.release(view) && old.release(model));
  });
  await scenario(
    'an empty actual legacy ledger migrates and fences its original writer',
    (home) => {
      const old = LegacyReservations.open(home);
      const prior = JSON.parse(fs.readFileSync(file(home), 'utf8'));
      assert.equal(prior.version, 1);
      const current = TerminalReservations.open(home);
      const model = current.reserveModel(randomUUID());
      const before = fs.readFileSync(file(home));
      legacyUnavailable(() => old.reserveModel(randomUUID()));
      legacyUnavailable(() => LegacyReservations.open(home));
      assert.deepEqual(fs.readFileSync(file(home)), before);
      const stored = JSON.parse(before.toString('utf8'));
      assert.equal(stored.namespace, prior.namespace);
      assert(current.owns(model));
    },
  );
  await scenario('an actual exited legacy owner permits atomic policy migration', async (home) => {
    const prefix = join(home, 'legacy-owner');
    const child = Bun.spawn([...command, '--terminal-legacy-reservation-child', home, prefix], {
      cwd: home,
      env: { HOME: home, TMPDIR: tmpdir(), PATH: '/usr/bin:/bin' },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    try {
      await until(() => fs.existsSync(`${prefix}.ready`) || child.exitCode !== null);
      assert.equal(child.exitCode, null, child.exitCode !== null ? await stderr : '');
      assert.equal(JSON.parse(fs.readFileSync(`${prefix}.ready`, 'utf8')).pid, child.pid);
      const live = fs.readFileSync(file(home));
      unavailable(() => TerminalReservations.open(home));
      assert.deepEqual(fs.readFileSync(file(home)), live);
      fs.writeFileSync(`${prefix}.go`, 'exit', { mode: 0o600 });
      await until(() => child.exitCode !== null);
      assert.equal(await child.exited, 0, await stderr);
      assert.equal(await stdout, '');
      assert.equal(await stderr, '');
      assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
      const current = TerminalReservations.open(home);
      assert.equal(JSON.parse(fs.readFileSync(file(home), 'utf8')).records.length, 0);
      assert(current.reserveModel(randomUUID()));
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await child.exited;
      }
    }
  });
  await scenario('an unknown policy preserves a real current charge and cannot reset', (home) => {
    const current = TerminalReservations.open(home);
    const model = current.reserveModel(randomUUID());
    const stored = JSON.parse(fs.readFileSync(file(home), 'utf8'));
    stored.policy.modelBytes = 1048576;
    fs.writeFileSync(file(home), JSON.stringify(stored));
    const before = fs.readFileSync(file(home));
    unavailable(() => current.owns(model));
    unavailable(() => current.release(model));
    unavailable(() => TerminalReservations.open(home));
    legacyUnavailable(() => LegacyReservations.open(home));
    assert.deepEqual(fs.readFileSync(file(home)), before);
  });
  return groups;
}
