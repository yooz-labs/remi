// #1443 actual standalone journal/ledger reconciliation and bounded history controls.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  withInterprocessFileLock,
  withInterprocessFileLockNonblocking,
} from '../../packages/daemon/src/storage/interprocess-file-lock';
import { writeRestrictedJson } from '../../packages/daemon/src/storage/restricted-json';
import type { JournalLease } from './journal-schema';
import { SETTLEMENT_STAGES, beginJournal, settleJournal } from './journal-settlement';
import { journalStagingChild, journalStagingProbe } from './journal-staging-cases';
import { RecoveryIntent } from './recovery';
import { recoveryNative } from './recovery-native';
import { CLEANUP_BLOCKING_DEBT, ReservationError, Reservations } from './reservations';
import { type ChildReceipt, settlementProcess } from './settlement-child-process';
import { capture, owner, refused, settlementFixture } from './settlement-fixture';
import { preallocationFixture } from './settlement-preallocation-fixture';

function checkpoint(stage: string) {
  fs.writeSync(1, `${JSON.stringify({ checkpoint: stage, pid: process.pid })}\n`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000);
  throw new Error('settlement owned checkpoint expired');
}
export async function settlementChild(home: string, mode: string) {
  if (mode.startsWith('staging-')) return journalStagingChild(home, mode);
  const native = await recoveryNative();
  const roots = capture(home, native.ops);
  try {
    if (mode === 'writer-partial-fault') {
      const store = new Reservations(path.join(home, 'ledger'));
      const writer = beginJournal(store, owner(), 1, roots.scratch, roots.metadata, native.ops);
      fs.writeFileSync(path.join(home, 'lease.json'), JSON.stringify(writer.lease), {
        mode: 0o600,
      });
      let failedFd = -1;
      refused(
        () =>
          writer.write(Buffer.alloc(128 * 1024, 42), (fd) => {
            failedFd = fd;
            fs.closeSync(fd);
          }),
        'actual next-chunk EBADF refuses partial write',
      );
      const artifact = path.join(home, 'scratch', `${writer.lease.id}.artifact`);
      const partial = fs.statSync(artifact);
      assert(partial.size > 0 && partial.size < 128 * 1024, 'actual owned partial bytes persisted');
      assert(
        (store.inspect()[0]?.charge ?? 0) >= CLEANUP_BLOCKING_DEBT,
        'lost exact writer FD retains blocking debt',
      );
      const replacement = fs.openSync(path.join(home, 'replacement-fd'), 'wx', 0o600);
      try {
        assert.equal(replacement, failedFd, 'actual partial-failure writer FD reused');
        refused(() => writer.write('retry'), 'uncertain partial writer cannot retry');
        refused(() => writer.close(), 'uncertain partial writer cannot close reused FD');
        fs.writeSync(replacement, 'partial failure replacement survived');
      } finally {
        fs.closeSync(replacement);
      }
      checkpoint(mode);
      return;
    }
    if (mode === 'writer-close-fault') {
      const store = new Reservations(path.join(home, 'ledger'));
      const writer = beginJournal(store, owner(), 1, roots.scratch, roots.metadata, native.ops);
      writer.write('actual close-fault bytes');
      fs.writeFileSync(path.join(home, 'lease.json'), JSON.stringify(writer.lease), {
        mode: 0o600,
      });
      let failedFd = -1;
      refused(
        () =>
          writer.close((fd) => {
            failedFd = fd;
            fs.closeSync(fd);
          }),
        'real owned writer close EBADF',
      );
      const replacement = fs.openSync(path.join(home, 'replacement-fd'), 'wx', 0o600);
      try {
        assert.equal(replacement, failedFd, 'actual failed writer FD number reused independently');
        refused(() => writer.close(), 'latched writer second close refuses');
        refused(() => writer.write('forbidden'), 'latched writer write refuses');
        fs.writeSync(replacement, 'replacement descriptor survived');
        assert(fs.fstatSync(replacement).isFile(), 'second close did not close replacement FD');
      } finally {
        fs.closeSync(replacement);
      }
      checkpoint(mode);
      return;
    }
    const lease = JSON.parse(
      fs.readFileSync(path.join(home, 'lease.json'), 'utf8'),
    ) as JournalLease;
    if (mode === 'flock-owner') {
      const intent = RecoveryIntent.open(roots.scratch, roots.metadata, lease.id, native.ops);
      try {
        checkpoint(mode);
      } finally {
        intent.close();
      }
    } else if (mode === 'ledger-owner') {
      withInterprocessFileLockNonblocking(path.join(home, 'ledger', 'reservations.json'), () =>
        checkpoint(mode),
      );
    } else if (mode === 'parallel-settle' || mode === 'parallel-reserve') {
      // The candidate never queues: this fixture explicitly retries observed busy refusals.
      const deadline = performance.now() + 3000;
      let busy = 0;
      while (true) {
        try {
          const store = new Reservations(path.join(home, 'ledger'));
          const outcome =
            mode === 'parallel-settle'
              ? settleJournal(store, lease, roots.scratch, roots.metadata, native.ops)
              : store.reserve(owner(), 1);
          console.log(JSON.stringify({ outcome, busy }));
          break;
        } catch (error) {
          assert(
            error instanceof ReservationError &&
              error.code === 'busy' &&
              performance.now() < deadline,
            'parallel settlement explicit bounded busy retry',
          );
          busy++;
          await Bun.sleep(5);
        }
      }
    } else {
      const store = new Reservations(path.join(home, 'ledger'));
      assert(SETTLEMENT_STAGES.includes(mode as (typeof SETTLEMENT_STAGES)[number]));
      settleJournal(store, lease, roots.scratch, roots.metadata, native.ops, (stage) => {
        if (stage === mode) checkpoint(stage);
      });
      assert.fail('settlement child checkpoint not reached');
    }
  } finally {
    roots.close();
    native.close();
  }
}

export async function settlementProbe() {
  const native = await recoveryNative();
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remi-settlement-')));
  fs.chmodSync(temporary, 0o700);
  const checks: string[] = [];
  const children: ChildReceipt[] = [];
  const measurements: unknown[] = [];
  const faults: unknown[] = [];
  const fixture = () => settlementFixture(temporary, native.ops);
  function ledger(f: ReturnType<typeof fixture>) {
    const file = path.join(f.home, 'ledger', 'reservations.json');
    return { file, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  }
  function pendingRetirement(f: ReturnType<typeof fixture>) {
    f.clean();
    refused(
      () =>
        f.settle(undefined, {
          ...native.ops,
          unlink(_fd, name) {
            return native.ops.unlink(-1, name);
          },
        }),
      'exact retirement-before-refund refusal',
    );
    f.charged();
    assert.equal(f.store.inspect()[0]?.journal?.retirement?.length, 3);
  }
  function ageOwnedLock(f: ReturnType<typeof fixture>, pid: number) {
    const file = path.join(f.home, 'ledger', 'reservations.json.lock');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(value.pid, pid, 'stale fixture lock belongs to actual owned child');
    assert.equal(value.host, os.hostname(), 'actual owned child host');
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    // Deliberate fixture timestamp aging, not a 30-second wall-clock measurement.
    value.acquiredAt = Date.now() - 31000;
    fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
    const old = new Date(Date.now() - 31000);
    fs.utimesSync(file, old, old);
    measurements.push({
      agedOwnedLockPid: pid,
      acquiredAt: value.acquiredAt,
      mtimeMs: fs.statSync(file).mtimeMs,
      qualification: 'explicit fixture timestamp aging after ESRCH',
    });
  }
  try {
    {
      const f = fixture();
      try {
        f.begin();
        const initial = f.store.inspect()[0];
        assert.equal(initial?.charge, 16384, 'declared cost plus three 4KiB markers');
        assert.equal(
          initial?.journal?.ownership?.length,
          2,
          'ownership bound before writable return',
        );
        measurements.push({ initial });
        fs.writeFileSync(f.file('artifact'), Buffer.alloc(20000, 42));
        const actual = Number(fs.statSync(f.file('artifact'), { bigint: true }).blocks * 512n);
        assert.equal(
          f.settle((stage) => {
            if (stage === 'retirement-committed') {
              const pending = ledger(f).value.records[0];
              assert(
                pending.charge >= actual + 12288,
                'actual artifact blocks charged before retirement',
              );
              measurements.push({
                retirementCharge: pending.charge,
                markerMeasurements: pending.journal.retirement,
              });
            }
          }),
          'settled',
          'actual settlement outcome',
        );
        const receipt = f.store.inspect()[0];
        assert.equal(receipt?.charge, 0, 'exact settled quota refund');
        assert.deepEqual(Object.keys(receipt?.journal ?? {}).sort(), [
          'home',
          'metadata',
          'nonce',
          'scratch',
        ]);
        measurements.push({ actualArtifactAllocated: actual, receipt });
        f.empty();
        assert.equal(f.settle(), 'already_settled', 'recent exact receipt retry');
        // Historical acknowledgment never acquires transfer authority or adopts a new artifact.
        fs.writeFileSync(f.file('artifact'), 'unrelated reincarnation', { mode: 0o600 });
        assert.equal(f.settle(), 'already_settled');
        assert.equal(fs.readFileSync(f.file('artifact'), 'utf8'), 'unrelated reincarnation');
      } finally {
        f.close();
      }
      checks.push(
        'journal actual allocation markers retirement exact refund and recent historical retry',
      );
    }
    {
      const f = fixture();
      try {
        f.begin();
        refused(
          () => f.store.releaseAfterCleanup(f.lease.id),
          'raw release refuses journal lifecycle',
        );
        refused(
          () => f.store.retain(f.lease.id, 'cleanup'),
          'raw retain refuses journal lifecycle',
        );
        refused(
          () =>
            settleJournal(
              f.store,
              { ...f.lease, nonce: randomBytes(16).toString('hex') },
              f.scratch,
              f.metadata,
              native.ops,
            ),
          'exact nonce incarnation refusal',
        );
        refused(
          () =>
            settleJournal(
              f.store,
              { ...f.lease, id: randomBytes(16).toString('hex') },
              f.scratch,
              f.metadata,
              native.ops,
            ),
          'unknown journal ID refusal',
        );
        f.charged();
        const { file, value } = ledger(f);
        value.records[0].journal.nonce = randomBytes(16).toString('hex');
        writeRestrictedJson(file, value);
        refused(() => f.settle(), 'actual same ID different nonce refuses old lease');
        f.charged();
      } finally {
        f.close();
      }
      checks.push(
        'raw release retain mixed nonce ID and injected reincarnation refuse without refund',
      );
    }
    {
      const f = fixture();
      try {
        const writer = beginJournal(f.store, owner(), 1, f.scratch, f.metadata, native.ops);
        try {
          writer.write('actual managed writer bytes');
          refused(
            () => settleJournal(f.store, writer.lease, f.scratch, f.metadata, native.ops),
            'managed live writer blocks settlement',
            'busy',
          );
        } finally {
          writer.close();
        }
        refused(() => writer.write('closed writer'), 'closed managed writer refuses writes');
        assert.equal(
          settleJournal(f.store, writer.lease, f.scratch, f.metadata, native.ops),
          'settled',
        );
        f.empty();
      } finally {
        f.close();
      }
      checks.push('managed writable handle holds intent flock until actual writer close');
    }
    {
      const f = fixture();
      try {
        f.begin();
        const { file, value } = ledger(f);
        value.records[0].journal.ownership = undefined;
        writeRestrictedJson(file, value);
        const effect = path.join(f.home, 'missing-binding-effect');
        refused(
          () =>
            f.store.reconcileJournal(
              f.lease,
              () => {
                fs.writeFileSync(effect, 'unexpected filesystem effect', { mode: 0o600 });
                fs.readFileSync(path.join(f.home, 'metadata')); // Actual EISDIR, never simulated success.
                return [];
              },
              () => assert.fail('missing binding cannot retire'),
            ),
          'missing ledger ownership refuses',
        );
        assert(!fs.existsSync(effect), 'exact missing ownership binding prevents effects');
        refused(() => f.settle(), 'missing ownership refuses reconciliation');
        f.charged();
      } finally {
        f.close();
      }
      checks.push(
        'missing durable ownership binding refuses before filesystem reconciliation effects',
      );
    }
    for (const root of ['scratch', 'metadata']) {
      const f = fixture();
      try {
        f.begin();
        const name = path.join(f.home, root);
        fs.renameSync(name, `${name}-old`);
        fs.mkdirSync(name, { mode: 0o700 });
        fs.writeFileSync(path.join(name, 'unrelated'), 'replacement preserved', { mode: 0o600 });
        refused(() => f.settle(), `current ${root} replacement refusal`);
        const recaptured = capture(f.home, native.ops);
        try {
          refused(
            () =>
              settleJournal(f.store, f.lease, recaptured.scratch, recaptured.metadata, native.ops),
            `recaptured ${root} identity refusal`,
          );
        } finally {
          recaptured.close();
        }
        f.charged();
        assert.equal(
          fs.readFileSync(path.join(name, 'unrelated'), 'utf8'),
          'replacement preserved',
        );
      } finally {
        f.close();
      }
      checks.push(
        `current and recaptured ${root} replacement preserves charge and unrelated bytes`,
      );
    }
    {
      const f = fixture();
      try {
        f.begin();
        const original = path.join(f.home, 'ledger');
        const copied = path.join(f.home, 'copied');
        fs.mkdirSync(copied, { mode: 0o700 });
        fs.copyFileSync(
          path.join(original, 'reservations.json'),
          path.join(copied, 'reservations.json'),
        );
        refused(() => new Reservations(copied), 'exact copied home binding refusal');
        fs.renameSync(original, `${original}-old`);
        fs.mkdirSync(original, { mode: 0o700 });
        fs.copyFileSync(
          path.join(copied, 'reservations.json'),
          path.join(original, 'reservations.json'),
        );
        refused(() => f.settle(), 'current home replacement refusal');
        refused(() => new Reservations(original), 'recaptured home replacement refusal');
        assert.equal(
          JSON.parse(fs.readFileSync(path.join(original, 'reservations.json'), 'utf8')).records[0]
            .charge,
          16384,
        );
      } finally {
        f.close();
      }
      checks.push('current recaptured and copied ledger home identities refuse without refund');
    }
    for (const fault of [
      'missing',
      'corrupt',
      'oversize',
      'optional',
      'settled-charge',
      'unknown-state',
    ]) {
      const f = fixture();
      try {
        f.begin();
        const { file, value } = ledger(f);
        if (fault === 'missing') fs.unlinkSync(file);
        else if (fault === 'corrupt') fs.writeFileSync(file, '{');
        else if (fault === 'oversize') fs.writeFileSync(file, Buffer.alloc(256 * 1024 + 1, 32));
        else {
          if (fault === 'optional') value.records[0].journal.retirement = [];
          if (fault === 'settled-charge') value.records[0].state = 'settled';
          if (fault === 'unknown-state') value.records[0].state = 'retired';
          writeRestrictedJson(file, value);
        }
        refused(() => f.settle(), `actual ${fault} journal ledger refusal`);
        assert(fs.existsSync(f.file('artifact')), 'ledger refusal cannot delete artifact');
        assert.equal(fs.existsSync(file), fault !== 'missing', 'no missing ledger initialization');
      } finally {
        f.close();
      }
    }
    checks.push(
      'missing corrupt oversized malformed optional and unknown ledger states fail closed',
    );
    for (const kind of ['intent', 'owned', 'cleaned']) {
      for (const fault of [
        'missing',
        'schema',
        'oversize',
        'hardlink',
        'symlink',
        'FIFO',
        'mode',
        'replacement',
        'corrupt',
      ]) {
        const f = fixture();
        try {
          f.begin();
          f.clean();
          if (kind === 'cleaned' && fault === 'replacement') pendingRetirement(f);
          const file = f.file(kind);
          if (fault === 'missing') fs.unlinkSync(file);
          if (fault === 'schema') {
            const value = JSON.parse(fs.readFileSync(file, 'utf8'));
            value.extra = 1;
            fs.writeFileSync(file, JSON.stringify(value));
          }
          if (fault === 'corrupt') fs.writeFileSync(file, 'invalid actual marker');
          if (fault === 'oversize') fs.writeFileSync(file, Buffer.alloc(4097, 32));
          if (fault === 'hardlink') fs.linkSync(file, path.join(f.home, 'unrelated-link'));
          if (fault === 'mode') fs.chmodSync(file, 0o640);
          if (fault === 'symlink' || fault === 'FIFO' || fault === 'replacement') {
            fs.renameSync(file, `${file}-original`);
            if (fault === 'symlink') fs.symlinkSync(`${file}-original`, file);
            if (fault === 'FIFO') assert.equal(native.fifo(file), 0);
            if (fault === 'replacement') fs.copyFileSync(`${file}-original`, file);
          }
          // A missing cleaned marker may be legitimately created by actual cleanup before retirement.
          if (kind === 'cleaned' && fault === 'missing') assert.equal(f.settle(), 'settled');
          else {
            refused(() => f.settle(), `exact settlement ${kind} ${fault} refusal`);
            f.charged();
          }
        } finally {
          f.close();
        }
      }
      checks.push(
        `journal ${kind} missing corrupt oversize schema type link mode and replacement controls`,
      );
    }
    {
      const f = fixture();
      try {
        f.begin();
        let actual = 0;
        refused(
          () =>
            f.settle(undefined, {
              ...native.ops,
              unlink(_fd, name) {
                const result = native.ops.unlink(-1, name);
                actual++;
                faults.push({ operation: 'unlinkat', result });
                return result;
              },
            }),
          'actual artifact unlink fault retains budget',
        );
        assert.equal(actual, 1);
        f.charged();
        pendingRetirement(f);
        assert.equal(f.store.inspect()[0]?.state, 'cleanup');
        assert.equal(f.settle(), 'settled');
        f.empty();
      } finally {
        f.close();
      }
      checks.push('actual native artifact and retirement unlink faults retain charge and retry');
    }
    {
      const f = fixture();
      try {
        f.begin();
        pendingRetirement(f);
        fs.renameSync(f.file('intent'), `${f.file('intent')}-old`);
        fs.copyFileSync(`${f.file('intent')}-old`, f.file('intent'));
        refused(() => f.settle(), 'all persisted witnesses verified before any retirement');
        f.charged();
        assert(fs.existsSync(f.file('owned')) && fs.existsSync(f.file('cleaned')));
      } finally {
        f.close();
      }
      checks.push(
        'persisted retirement verifies every marker before effects and rejects replacement',
      );
    }
    {
      const f = fixture();
      const allocation = await preallocationFixture(temporary);
      try {
        f.begin();
        const before = fs.readFileSync(f.file('owned'));
        const stat = fs.statSync(f.file('owned'), { bigint: true });
        const fd = fs.openSync(f.file('owned'), fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
        try {
          assert.equal(allocation.preallocate(fd), 0, 'actual owned-marker preallocation syscall');
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        const after = fs.statSync(f.file('owned'), { bigint: true });
        assert.equal(after.ino, stat.ino);
        assert.deepEqual(fs.readFileSync(f.file('owned')), before);
        const allocated = Number(after.blocks * 512n);
        assert(allocated > 4096, 'owned marker actual blocks exceed allowance');
        pendingRetirement(f);
        assert(
          (f.store.inspect()[0]?.charge ?? 0) >= allocated + 8192,
          'actual larger marker allocation increases accounting',
        );
        measurements.push({
          actualOwnedMarkerAllocated: allocated,
          retainedCharge: f.store.inspect()[0]?.charge,
        });
        assert.equal(f.settle(), 'settled');
        f.empty();
      } finally {
        allocation.close();
        f.close();
      }
      checks.push(
        'actual owned-marker preallocation preserves identity and raises retained accounting',
      );
    }
    for (const stage of [
      'retired-owned',
      'retired-cleaned',
      'retired-intent',
      'metadata-fsynced',
    ]) {
      const f = fixture();
      try {
        f.begin();
        refused(
          () =>
            f.settle((current) => {
              if (current === stage)
                fs.writeFileSync(f.file('owned'), 'replacement kept', { mode: 0o600 });
            }),
          'final exact marker absence prevents recreation refund',
        );
        f.charged();
        assert.equal(fs.readFileSync(f.file('owned'), 'utf8'), 'replacement kept');
      } finally {
        f.close();
      }
    }
    checks.push('marker recreation after unlink or fsync refuses refund and preserves replacement');
    {
      const f = fixture();
      try {
        const writer = beginJournal(f.store, owner(), 1, f.scratch, f.metadata, native.ops);
        try {
          for (let index = 0; index < 9; index++) f.store.reserve(owner(), 10 * 1024 * 1024);
          f.store.reserve(owner(), 10 * 1024 * 1024 - 32768);
          const admitted = f.store.reserve(owner(), 1);
          f.store.releaseAfterCleanup(admitted);
          writer.write(Buffer.alloc(32769, 42));
          const liveSecondStore = new Reservations(path.join(f.home, 'ledger'));
          const record = liveSecondStore.inspect().find((record) => record.id === writer.lease.id);
          refused(
            () => settleJournal(f.store, writer.lease, f.scratch, f.metadata, native.ops),
            'same growing writer keeps settlement busy before close',
            'busy',
          );
          assert.equal(
            liveSecondStore.inspect().find((item) => item.id === writer.lease.id)?.charge,
            record?.charge,
            'growing writer busy settlement preserves existing debt',
          );
          assert(
            (record?.charge ?? 0) >= 49152,
            'exact ongoing write accounting blocks intervening admission',
          );
          refused(
            () => liveSecondStore.reserve(owner(), 1),
            'exact ongoing write accounting blocks intervening admission',
            'busy',
          );
          measurements.push({
            liveWriteCharge: record?.charge,
            projectedBytes: 32769,
            writerStillOpen: true,
          });
        } finally {
          writer.close();
        }
        assert.equal(
          settleJournal(f.store, writer.lease, f.scratch, f.metadata, native.ops),
          'settled',
        );
        f.empty();
      } finally {
        f.close();
      }
      const empty = fixture();
      const allocation = await preallocationFixture(temporary);
      try {
        const writer = beginJournal(
          empty.store,
          owner(),
          1,
          empty.scratch,
          empty.metadata,
          native.ops,
        );
        try {
          const artifact = path.join(empty.home, 'scratch', `${writer.lease.id}.artifact`);
          withInterprocessFileLockNonblocking(
            path.join(empty.home, 'ledger', 'reservations.json'),
            () => {
              refused(
                () => writer.write('blocked'),
                'writer busy before effects is retryable',
                'busy',
              );
            },
          );
          assert.equal(fs.statSync(artifact).size, 0, 'busy writer produced zero effects');
          const fd = fs.openSync(artifact, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
          try {
            assert.equal(allocation.preallocate(fd), 0);
            fs.fsyncSync(fd);
          } finally {
            fs.closeSync(fd);
          }
          const allocated = Number(fs.statSync(artifact, { bigint: true }).blocks * 512n);
          writer.write('');
          const second = new Reservations(path.join(empty.home, 'ledger'));
          assert(
            (second.inspect()[0]?.charge ?? 0) >= allocated + 12288,
            'empty write accounts actual owned preallocation',
          );
          writer.write('actual retry succeeds');
          assert.equal(fs.readFileSync(artifact, 'utf8'), 'actual retry succeeds');
          measurements.push({
            emptyWriteAllocated: allocated,
            liveCharge: second.inspect()[0]?.charge,
          });
        } finally {
          writer.close();
        }
        assert.equal(
          settleJournal(empty.store, writer.lease, empty.scratch, empty.metadata, native.ops),
          'settled',
        );
        empty.empty();
      } finally {
        allocation.close();
        empty.close();
      }
      checks.push(
        'ongoing managed writes empty preallocation and busy retry retain charge before admission',
      );
    }
    {
      const f = fixture();
      try {
        await settlementProcess(
          [f.home, 'writer-partial-fault'],
          children,
          'writer-partial-fault',
          async () => {
            f.adoptLease();
            const second = new Reservations(path.join(f.home, 'ledger'));
            assert((second.inspect()[0]?.charge ?? 0) >= CLEANUP_BLOCKING_DEBT);
            refused(
              () => second.reserve(owner(), 1),
              'partial write debt blocks new admission',
              'busy',
            );
            refused(
              () => f.settle(),
              'partial writer failure holds intent until actual death',
              'busy',
            );
            assert.equal(
              fs.readFileSync(path.join(f.home, 'replacement-fd'), 'utf8'),
              'partial failure replacement survived',
            );
            measurements.push({
              actualPartialBytes: fs.statSync(f.file('artifact')).size,
              blockingDebt: second.inspect()[0]?.charge,
            });
          },
        );
        assert.equal(f.settle(), 'settled', 'actual partial writer death permits reconciliation');
        f.empty();
      } finally {
        f.close();
      }
      checks.push(
        'actual partial write EBADF and failed owned measurement retain blocking debt until death',
      );
    }
    for (const stage of SETTLEMENT_STAGES) {
      const f = fixture();
      try {
        f.begin();
        const output = await settlementProcess([f.home, stage], children, stage, async (pid) => {
          refused(() => f.settle(), 'live actual ledger owner stays busy', 'busy');
          const value = JSON.parse(
            fs.readFileSync(path.join(f.home, 'ledger', 'reservations.json.lock'), 'utf8'),
          );
          assert.equal(value.pid, pid);
        });
        assert.equal(JSON.parse(output).checkpoint, stage);
        const pid = children.at(-1)?.pid;
        assert(pid);
        refused(() => f.settle(), 'fresh killed ledger owner still busy', 'busy');
        ageOwnedLock(f, pid);
        refused(
          () => f.settle(),
          'nonblocking reconciliation also refuses aged stale owner',
          'busy',
        );
        const ledgerFile = path.join(f.home, 'ledger', 'reservations.json');
        withInterprocessFileLock(ledgerFile, () => {
          const maintenance = JSON.parse(fs.readFileSync(`${ledgerFile}.lock`, 'utf8'));
          assert.equal(
            maintenance.pid,
            process.pid,
            'actual maintenance writer acquired reclaimed lock',
          );
          assert.equal(maintenance.host, os.hostname());
          measurements.push({
            maintenance: 'explicit shipping waiting-owner stale reclaim',
            pid: maintenance.pid,
            ownerId: maintenance.ownerId,
            acquiredAt: maintenance.acquiredAt,
          });
        });
        const expected = stage === 'settled-committed' ? 'already_settled' : 'settled';
        assert.equal(f.settle(), expected, 'actual crash restart settlement');
        assert.equal(f.settle(), 'already_settled', 'restart no double refund');
        f.empty();
      } finally {
        f.close();
      }
      checks.push(`actual SIGKILL ${stage} restart with witnessed retirement and exact receipt`);
    }
    {
      const f = fixture();
      try {
        f.begin();
        await settlementProcess([f.home, 'flock-owner'], children, 'flock-owner', async () => {
          refused(() => f.settle(), 'actual live intent owner is busy', 'busy');
          f.charged();
        });
        assert.equal(f.settle(), 'settled', 'actual flock immediately releases on death');
        f.empty();
      } finally {
        f.close();
      }
      checks.push('actual nonblocking intent contention and immediate dead owner flock release');
    }
    {
      const f = fixture();
      try {
        f.begin();
        const results = await Promise.allSettled(
          ['parallel-settle', 'parallel-settle', 'parallel-reserve'].map((mode) =>
            settlementProcess([f.home, mode], children),
          ),
        );
        for (const result of results) if (result.status === 'rejected') throw result.reason;
        const outcomes = results.map((result) =>
          JSON.parse(result.status === 'fulfilled' ? result.value : 'null'),
        );
        assert.deepEqual(
          outcomes
            .slice(0, 2)
            .map((item) => item.outcome)
            .sort(),
          ['already_settled', 'settled'],
        );
        const records = f.store.inspect();
        assert.equal(records.length, 2);
        assert.equal(
          records.reduce((sum, item) => sum + item.charge, 0),
          4096,
        );
        f.empty();
        measurements.push({ parallel: outcomes });
      } finally {
        f.close();
      }
      checks.push('actual parallel settlement retry and new admission conserve exact quota');
    }
    {
      const f = fixture();
      try {
        await settlementProcess(
          [f.home, 'writer-close-fault'],
          children,
          'writer-close-fault',
          async () => {
            f.adoptLease();
            refused(() => f.settle(), 'failed owned writer keeps settlement busy', 'busy');
            f.charged();
            assert.equal(
              fs.readFileSync(path.join(f.home, 'replacement-fd'), 'utf8'),
              'replacement descriptor survived',
            );
          },
        );
        assert.equal(f.settle(), 'settled', 'actual failed writer death releases intent flock');
        f.empty();
      } finally {
        f.close();
      }
      checks.push(
        'actual writer close EBADF latches failure preserves reused FD and blocks until death',
      );
    }
    {
      const f = fixture();
      try {
        const pending = f.store.reserve(owner(), 1);
        const leases: JournalLease[] = [];
        const cycleOwner = owner();
        for (let cycle = 0; cycle < 130; cycle++) {
          leases.push(f.begin(1, cycleOwner));
          assert.equal(f.settle(), 'settled');
          f.empty();
          const records = f.store.inspect();
          assert(records.length <= 128, 'exact terminal history bound');
          assert(
            records.filter((record) => record.device === cycleOwner.device).length <= 32,
            'exact per-device terminal history bound',
          );
          assert(
            records.some((record) => record.id === pending),
            'exact pending record never evicted',
          );
          assert.equal(
            records.reduce((sum, item) => sum + item.charge, 0),
            4096,
          );
        }
        const recent = leases.at(-1);
        const evicted = leases[0];
        assert(recent && evicted);
        assert.equal(
          settleJournal(f.store, recent, f.scratch, f.metadata, native.ops),
          'already_settled',
        );
        refused(
          () => settleJournal(f.store, evicted, f.scratch, f.metadata, native.ops),
          'evicted receipt is unknown',
        );
        // #1487 applies the accepted 32-slot device bound to completed receipts.
        // One owner cannot fill the separate 128-slot home bound; exercise both.
        assert.equal(f.store.inspect().length, 33);
        assert.equal(
          f.store.inspect().filter((record) => record.device === cycleOwner.device).length,
          32,
        );
        const distinctLeases: JournalLease[] = [];
        for (let cycle = 0; cycle < 130; cycle++) {
          distinctLeases.push(f.begin(1, owner()));
          assert.equal(f.settle(), 'settled');
          f.empty();
          const records = f.store.inspect();
          assert(records.length <= 128, 'distinct owners retain the home history bound');
          assert(
            records.some((record) => record.id === pending),
            'pending row survives home pressure',
          );
          assert.equal(
            records.reduce((sum, item) => sum + item.charge, 0),
            4096,
          );
        }
        const latestDistinct = distinctLeases.at(-1);
        const oldestDistinct = distinctLeases[0];
        assert(latestDistinct && oldestDistinct);
        assert.equal(
          settleJournal(f.store, latestDistinct, f.scratch, f.metadata, native.ops),
          'already_settled',
        );
        refused(
          () => settleJournal(f.store, oldestDistinct, f.scratch, f.metadata, native.ops),
          'home-evicted receipt is unknown',
        );
        assert.equal(f.store.inspect().length, 128);
        measurements.push({
          completedCycles: 260,
          sameOwnerCycles: 130,
          distinctOwnerCycles: 130,
          deviceBoundedRows: 32,
          boundedRows: 128,
          pendingCharge: 4096,
          ledgerBytes: fs.statSync(path.join(f.home, 'ledger', 'reservations.json')).size,
          ownedScratchNames: fs.readdirSync(path.join(f.home, 'scratch')),
          ownedMetadataNames: fs.readdirSync(path.join(f.home, 'metadata')),
        });
      } finally {
        f.close();
      }
      checks.push(
        '260 actual complete cycles bound device and home rows preserve pending and refuse evicted retries',
      );
    }
  } finally {
    fs.rmSync(temporary, { recursive: true });
    native.close();
  }
  const staging = await journalStagingProbe();
  return {
    checks: [...checks, ...staging.checks],
    children: [...children, ...staging.children],
    measurements,
    faults,
    journalStagingJpegInputSha256: staging.jpegInputSha256,
    lockQualification:
      'Explicit fixture acquiredAt/mtime aging only after actual owned PID/host and ESRCH, then actual shipping waiting-owner maintenance reclaims stale lock; ordinary settlement remains nonblocking; no wall-clock stale interval measurement',
    scope:
      'Standalone quota reconciliation and marker retirement only; no production adoption transfer authority held-answer or R7 rerun',
  };
}
