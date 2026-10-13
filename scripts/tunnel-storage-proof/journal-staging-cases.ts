/// <reference path="./assets.d.ts" />
/// <reference path="../tunnel-decoder-proof/pngjs.d.ts" />
// Actual owned filesystem cases shared by Bun and the existing compiled settlement profile.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import jpeg from '../tunnel-decoder-proof/fixture.jpg' with { type: 'file' };
import png from '../tunnel-decoder-proof/fixture.png' with { type: 'file' };
import type { JournalRead } from './journal-settlement';
import { beginJournal, settleJournal } from './journal-settlement';
import { RecoveryIntent, type RecoveryOps } from './recovery';
import { recoveryNative } from './recovery-native';
import { CLEANUP_BLOCKING_DEBT, Reservations } from './reservations';
import { type ChildReceipt, settlementProcess } from './settlement-child-process';
import { capture, owner, refused, settlementFixture } from './settlement-fixture';

type Fixture = ReturnType<typeof settlementFixture>;
const sourceEntry = () =>
  Bun.main.startsWith('/$bunfs/')
    ? undefined
    : path.resolve(import.meta.dir, 'settlement-entry.ts');

function start(f: Fixture, ops: RecoveryOps, bytes: Buffer, selected = owner()) {
  const writer = beginJournal(f.store, selected, bytes.length, f.scratch, f.metadata, ops);
  writer.write(bytes);
  writer.close();
  fs.writeFileSync(path.join(f.home, 'lease.json'), JSON.stringify(writer.lease), { mode: 0o600 });
  f.adoptLease();
  return writer;
}

export async function journalStagingChild(home: string, mode: string) {
  const native = await recoveryNative();
  const roots = capture(home, native.ops);
  try {
    const store = new Reservations(path.join(home, 'ledger'));
    const bytes = Buffer.from(await Bun.file(jpeg).arrayBuffer());
    const opened = new Set<number>();
    const observed: RecoveryOps = {
      ...native.ops,
      openAt(fd, name, flags) {
        const actual = native.ops.openAt(fd, name, flags);
        if (actual >= 0 && name.endsWith('.artifact')) opened.add(actual);
        return actual; // Actual native opens only; observation never substitutes a result.
      },
    };
    const writer = beginJournal(
      store,
      owner(),
      bytes.length,
      roots.scratch,
      roots.metadata,
      observed,
    );
    writer.write(bytes);
    fs.writeFileSync(path.join(home, 'lease.json'), JSON.stringify(writer.lease), { mode: 0o600 });
    if (mode === 'staging-writer-close-fault') {
      refused(() => writer.close((fd) => fs.closeSync(fd)), 'actual failed close refuses');
      refused(() => writer.openRead(), 'failed writer never supplies closed read state');
    } else {
      assert.equal(mode, 'staging-reader-close-fault');
      writer.close();
      const reader = writer.openRead();
      assert.equal(reader.retainStaged(), 'staged');
      const original = fs.statSync(path.join(home, 'scratch', `${writer.lease.id}.artifact`));
      const live = [...opened].filter((fd) => {
        try {
          const stat = fs.fstatSync(fd);
          return stat.dev === original.dev && stat.ino === original.ino;
        } catch {
          return false;
        }
      });
      assert.equal(live.length, 1, 'exact actual retained read descriptor');
      const retained = live[0];
      assert(retained !== undefined);
      fs.closeSync(retained);
      const replacement = fs.openSync(path.join(home, 'unrelated-fd'), 'wx', 0o600);
      try {
        assert.equal(replacement, retained, 'real read FD number reused for unrelated inode');
        refused(() => reader.close(), 'reader cannot close unrelated recycled FD');
        refused(() => reader.close(), 'failed reader close never retries numeric FD');
        refused(() => reader.read(0, 1), 'failed reader cannot be used');
        fs.writeSync(replacement, bytes.subarray(0, 1));
        assert(fs.fstatSync(replacement).isFile(), 'unrelated FD survives both refused closes');
      } finally {
        fs.closeSync(replacement);
      }
    }
    fs.writeSync(1, `${JSON.stringify({ checkpoint: mode, pid: process.pid })}\n`);
    // Uncertain handles intentionally survive until the existing owned SIGKILL/death proof.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000);
    throw new Error('staging owned checkpoint expired');
  } finally {
    roots.close();
    native.close();
  }
}

export async function journalStagingProbe() {
  const native = await recoveryNative();
  const temporary = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'remi-journal-staging-')),
  );
  fs.chmodSync(temporary, 0o700);
  const checks: string[] = [];
  const children: ChildReceipt[] = [];
  const pngBytes = Buffer.from(await Bun.file(png).arrayBuffer());
  const jpegBytes = Buffer.from(await Bun.file(jpeg).arrayBuffer());
  const run = async (name: string, effect: (f: Fixture) => void | Promise<void>) => {
    const f = settlementFixture(temporary, native.ops);
    try {
      await effect(f);
      checks.push(name);
    } finally {
      f.close();
    }
  };
  try {
    await run(
      'journal closed owned PNG JPEG reads are bounded and expose no raw capability',
      (f) => {
        for (const bytes of [pngBytes, jpegBytes]) {
          const writer = start(f, native.ops, bytes);
          const reader = writer.openRead();
          try {
            assert.deepEqual(Object.keys(reader).sort(), [
              'byteLength',
              'close',
              'lease',
              'read',
              'retainStaged',
            ]);
            assert.equal(reader.byteLength, bytes.length);
            const result: Buffer[] = [];
            for (let offset = 0; offset < bytes.length; offset += 32768)
              result.push(reader.read(offset, Math.min(32768, bytes.length - offset)));
            assert.deepEqual(Buffer.concat(result), bytes);
            for (const [offset, length] of [
              [-1, 1],
              [0, 0],
              [0, 32769],
              [bytes.length, 1],
              [0.5, 1],
              [0, 1.5],
            ])
              refused(() => reader.read(offset ?? -1, length ?? -1), 'bounded managed read');
          } finally {
            reader.close();
          }
          refused(() => reader.read(0, 1), 'closed read view refuses');
          assert.equal(f.settle(), 'settled');
        }
      },
    );
    await run(
      'journal staged conversion frees active slots preserves all debt and same artifact',
      (f) => {
        const selected = owner();
        const first = start(f, native.ops, pngBytes, selected);
        const second = start(f, native.ops, pngBytes, selected);
        refused(() => f.store.reserve(selected, 1), 'two active device rows', 'busy');
        const before = f.store.inspect().find((row) => row.id === first.lease.id);
        assert(before);
        const reader = first.openRead();
        try {
          const inode = fs.statSync(path.join(f.home, 'scratch', `${first.lease.id}.artifact`)).ino;
          assert.equal(reader.retainStaged(), 'staged');
          assert.equal(reader.retainStaged(), 'staged');
          const after = new Reservations(path.join(f.home, 'ledger'))
            .inspect()
            .find((row) => row.id === first.lease.id);
          assert(after);
          assert.equal(after.state, 'staged');
          assert(after.charge >= before.charge && after.bytes === before.bytes);
          assert.deepEqual(after.journal, before.journal);
          assert.equal(
            fs.statSync(path.join(f.home, 'scratch', `${first.lease.id}.artifact`)).ino,
            inode,
          );
          const third = f.store.reserve(selected, 1);
          refused(
            () => f.store.reserve(selected, 1),
            'staged frees exactly one active slot',
            'busy',
          );
          f.store.releaseAfterCleanup(third);
          assert.equal(f.store.inspect().length, 2);
          refused(() => f.store.retain(first.lease.id, 'staged'), 'generic retain rejects journal');
          refused(
            () => f.store.releaseAfterCleanup(first.lease.id),
            'generic refund rejects journal',
          );
          refused(
            () =>
              f.store.retainJournal({ ...first.lease, nonce: '0'.repeat(32) }, () => {
                assert.fail('wrong nonce must refuse before measurement');
              }),
            'wrong lease nonce',
          );
          refused(
            () =>
              f.store.writeJournal(
                first.lease,
                1,
                () => {
                  assert.fail('staged writer must refuse before measurement');
                },
                () => assert.fail('staged writer effect'),
              ),
            'staged remains read-only',
          );
        } finally {
          reader.close();
        }
        assert.equal(
          settleJournal(f.store, first.lease, f.scratch, f.metadata, native.ops),
          'settled',
        );
        assert.equal(
          settleJournal(f.store, first.lease, f.scratch, f.metadata, native.ops),
          'already_settled',
        );
        assert.equal(
          settleJournal(f.store, second.lease, f.scratch, f.metadata, native.ops),
          'settled',
        );
      },
    );
    await run('journal staged rows keep device home artifact and byte admission barriers', (f) => {
      const selected = owner();
      for (let index = 0; index < 128; index++) {
        const writer = start(f, native.ops, pngBytes, index < 32 ? selected : owner());
        const reader = writer.openRead();
        try {
          assert.equal(reader.retainStaged(), 'staged');
        } finally {
          reader.close();
        }
        if (index === 31)
          refused(() => f.store.reserve(selected, 1), '32 retained device slots', 'busy');
      }
      assert.equal(f.store.inspect().length, 128);
      refused(() => f.store.reserve(owner(), 1), '128 retained home slots', 'busy');
    });
    await run(
      'journal staged byte debt remains under the original home admission accounting',
      (f) => {
        const writer = start(f, native.ops, pngBytes);
        const reader = writer.openRead();
        try {
          reader.retainStaged();
        } finally {
          reader.close();
        }
        for (let index = 0; index < 9; index++)
          f.store.reserveJournal(
            owner(),
            10 * 1024 * 1024,
            f.scratch.identity,
            f.metadata.identity,
          );
        refused(
          () =>
            f.store.reserveJournal(
              owner(),
              10 * 1024 * 1024,
              f.scratch.identity,
              f.metadata.identity,
            ),
          'retained bytes prevent extra home admission',
          'busy',
        );
        assert(f.store.inspect()[0]?.state === 'staged');
      },
    );
    await run(
      'journal open read needs successful close and preeffect busy creates no new debt',
      (f) => {
        const writer = beginJournal(
          f.store,
          owner(),
          pngBytes.length,
          f.scratch,
          f.metadata,
          native.ops,
        );
        writer.write(pngBytes);
        refused(() => writer.openRead(), 'not closed');
        writer.close();
        const before = f.store.inspect()[0]?.charge;
        const intent = RecoveryIntent.open(f.scratch, f.metadata, writer.lease.id, native.ops);
        try {
          refused(() => writer.openRead(), 'real nonblocking intent contention', 'busy');
        } finally {
          intent.close();
        }
        assert.equal(f.store.inspect()[0]?.charge, before);
        const reader = writer.openRead();
        reader.close();
        assert.equal(
          settleJournal(f.store, writer.lease, f.scratch, f.metadata, native.ops),
          'settled',
        );
      },
    );
    for (const fault of [
      'missing',
      'short',
      'replacement',
      'growth',
      'mutation',
      'mode',
      'link',
    ] as const) {
      await run(`journal owned ${fault} artifact refuses and retains blocking debt`, async (f) => {
        const writer = start(f, native.ops, pngBytes);
        const filename = f.file('artifact');
        let reader: JournalRead | undefined;
        try {
          if (fault !== 'missing' && fault !== 'short') reader = writer.openRead();
          if (fault === 'missing') fs.unlinkSync(filename);
          else if (fault === 'short') fs.truncateSync(filename, pngBytes.length - 1);
          else if (fault === 'replacement') {
            fs.renameSync(filename, `${filename}.original`);
            fs.writeFileSync(filename, pngBytes, { mode: 0o600 });
          } else if (fault === 'growth') fs.appendFileSync(filename, pngBytes.subarray(0, 1));
          else if (fault === 'mutation') {
            const fd = fs.openSync(filename, 'r+');
            try {
              fs.writeSync(fd, jpegBytes.subarray(0, 1), 0, 1, 0);
            } finally {
              fs.closeSync(fd);
            }
            await Bun.sleep(1); // The publication check follows an actual async handoff.
          } else if (fault === 'mode') fs.chmodSync(filename, 0o640);
          else fs.linkSync(filename, `${filename}.linked`);
          if (reader) {
            refused(() => reader?.read(0, 1), 'changed retained artifact read');
            refused(() => reader?.retainStaged(), 'changed retained artifact publication');
          } else refused(() => writer.openRead(), 'no closed complete owned artifact');
          assert((f.store.inspect()[0]?.charge ?? 0) >= CLEANUP_BLOCKING_DEBT);
          assert.equal(f.store.inspect()[0]?.state, 'active');
        } finally {
          reader?.close();
        }
      });
    }
    for (const root of ['scratch', 'metadata'] as const) {
      await run(`journal captured ${root} replacement refuses read and staged retention`, (f) => {
        const writer = start(f, native.ops, pngBytes);
        const reader = writer.openRead();
        try {
          const configured = path.join(f.home, root);
          fs.renameSync(configured, `${configured}.original`);
          fs.mkdirSync(configured, { mode: 0o700 });
          fs.writeFileSync(path.join(configured, 'unrelated'), pngBytes, { mode: 0o600 });
          refused(() => reader.read(0, 1), 'changed root read');
          refused(() => reader.retainStaged(), 'changed root retain');
          assert((f.store.inspect()[0]?.charge ?? 0) >= CLEANUP_BLOCKING_DEBT);
          assert.deepEqual(fs.readFileSync(path.join(configured, 'unrelated')), pngBytes);
        } finally {
          reader.close();
        }
      });
    }
    await run('journal held read view blocks cleanup until close then settles staged once', (f) => {
      const writer = start(f, native.ops, pngBytes);
      const reader = writer.openRead();
      try {
        reader.retainStaged();
        const before = f.store.inspect();
        refused(() => f.settle(), 'held read intent blocks actual cleanup', 'busy');
        assert.deepEqual(f.store.inspect(), before);
        assert.deepEqual(reader.read(0, pngBytes.length), pngBytes);
      } finally {
        reader.close();
      }
      assert.equal(f.settle(), 'settled');
      assert.equal(f.settle(), 'already_settled');
      f.empty();
    });
    for (const mode of ['staging-writer-close-fault', 'staging-reader-close-fault']) {
      await run(
        `journal actual ${mode} retains intent until death without recycled FD retry`,
        async (f) => {
          await settlementProcess(
            [f.home, mode],
            children,
            mode,
            async () => {
              f.adoptLease();
              f.charged();
              refused(() => f.settle(), 'failed close owner remains flocked', 'busy');
            },
            sourceEntry(),
          );
          f.adoptLease();
          assert.equal(f.settle(), 'settled');
          f.empty();
        },
      );
    }
  } finally {
    fs.rmSync(temporary, { recursive: true });
    native.close();
  }
  return {
    checks,
    children,
    jpegInputSha256: new Bun.CryptoHasher('sha256').update(jpegBytes).digest('hex'),
    scope:
      'Owned closed journal reads and retained accounting only; no transfer authority or publication caller',
  };
}
