import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DirectoryRoot } from './admission';
import type { JournalLease } from './journal-schema';
import { type SettlementStage, beginJournal, settleJournal } from './journal-settlement';
import { RecoveryError, RecoveryIntent, type RecoveryOps } from './recovery';
import { ReservationError, Reservations } from './reservations';

export const owner = () => ({
  device: randomBytes(32).toString('hex'),
  session: randomUUID(),
  hub: randomBytes(16).toString('hex'),
});
export function refused(action: () => unknown, label: string, code = 'unavailable'): void {
  const started = performance.now();
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  if (code === 'busy')
    assert(performance.now() - started < 1000, 'actual settlement busy refusal is nonblocking');
  assert(
    (caught instanceof RecoveryError || caught instanceof ReservationError) && caught.code === code,
    label,
  );
}
export function capture(home: string, ops: RecoveryOps) {
  const scratch = DirectoryRoot.capture(path.join(home, 'scratch'), ops.openAt.bind(ops));
  const metadata = DirectoryRoot.capture(path.join(home, 'metadata'), ops.openAt.bind(ops));
  assert(scratch && metadata, 'settlement captured roots');
  return {
    scratch,
    metadata,
    close() {
      scratch.close();
      metadata.close();
    },
  };
}
export function settlementFixture(base: string, ops: RecoveryOps) {
  const home = fs.mkdtempSync(path.join(base, 'f-'));
  fs.chmodSync(home, 0o700);
  for (const item of ['scratch', 'metadata', 'project', 'sibling'])
    fs.mkdirSync(path.join(home, item), { mode: 0o700 });
  for (const item of ['project', 'sibling'])
    fs.writeFileSync(path.join(home, item, 'marker'), `untouched-${item}`, { mode: 0o600 });
  const store = Reservations.create(path.join(home, 'ledger'));
  const roots = capture(home, ops);
  let lease: JournalLease;
  function begin(bytes = 1, selectedOwner = owner()) {
    const result = beginJournal(store, selectedOwner, bytes, roots.scratch, roots.metadata, ops);
    lease = result.lease;
    result.write('actual journal settlement bytes');
    result.close();
    fs.writeFileSync(path.join(home, 'lease.json'), JSON.stringify(lease), { mode: 0o600 });
    return lease;
  }
  return {
    home,
    store,
    ...roots,
    begin,
    adoptLease() {
      lease = JSON.parse(fs.readFileSync(path.join(home, 'lease.json'), 'utf8'));
    },
    get lease() {
      return lease;
    },
    file(kind: string) {
      return path.join(home, kind === 'artifact' ? 'scratch' : 'metadata', `${lease.id}.${kind}`);
    },
    clean() {
      const intent = RecoveryIntent.open(roots.scratch, roots.metadata, lease.id, ops);
      try {
        assert.equal(intent.cleanup(), 'cleaned');
      } finally {
        intent.close();
      }
    },
    settle(checkpoint?: (stage: SettlementStage) => void, selected = ops) {
      return settleJournal(store, lease, roots.scratch, roots.metadata, selected, checkpoint);
    },
    charged() {
      const record = store.inspect().find((record) => record.id === lease.id);
      assert(
        record && record.charge >= 16384 && record.state !== 'settled',
        'refusal preserves journal charge',
      );
    },
    empty() {
      assert.deepEqual(
        fs.readdirSync(path.join(home, 'metadata')),
        [],
        'no orphan journal markers',
      );
      assert.deepEqual(fs.readdirSync(path.join(home, 'scratch')), [], 'no orphan artifact');
    },
    close() {
      for (const item of ['project', 'sibling'])
        assert.equal(fs.readFileSync(path.join(home, item, 'marker'), 'utf8'), `untouched-${item}`);
      roots.close();
      fs.rmSync(home, { recursive: true });
    },
  };
}
