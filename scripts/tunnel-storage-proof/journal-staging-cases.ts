/// <reference path="./assets.d.ts" />
/// <reference path="../tunnel-decoder-proof/pngjs.d.ts" />
// Actual owned filesystem cases shared by Bun and the existing compiled settlement profile.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { withInterprocessFileLock } from '../../packages/daemon/src/storage/interprocess-file-lock';
import jpeg from '../tunnel-decoder-proof/fixture.jpg' with { type: 'file' };
import png from '../tunnel-decoder-proof/fixture.png' with { type: 'file' };
import type { JournalRead } from './journal-settlement';
import { SETTLEMENT_STAGES, beginJournal, settleJournal } from './journal-settlement';
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
    if (mode.startsWith('staging-image-')) {
      const match = /^staging-image-(png|jpg)-(.+)$/.exec(mode);
      assert(match);
      const extension = match[1] as 'png' | 'jpg';
      const stage = match[2];
      assert(SETTLEMENT_STAGES.some((value) => value === stage));
      const bytes = Buffer.from(await Bun.file(extension === 'png' ? png : jpeg).arrayBuffer());
      const writer = beginJournal(
        store,
        owner(),
        bytes.length,
        roots.scratch,
        roots.metadata,
        native.ops,
        extension,
      );
      writer.write(bytes);
      writer.close();
      const reader = writer.openRead();
      reader.retainStaged();
      reader.close();
      fs.writeFileSync(path.join(home, 'lease.json'), JSON.stringify(writer.lease), {
        mode: 0o600,
      });
      settleJournal(store, writer.lease, roots.scratch, roots.metadata, native.ops, (current) => {
        if (current !== stage) return;
        fs.writeSync(1, `${JSON.stringify({ checkpoint: mode, pid: process.pid })}\n`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000);
        throw new Error('image retirement checkpoint expired');
      });
      throw new Error('image retirement checkpoint not reached');
    }
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
      'journal closed owned PNG JPEG reads are bounded and expose no raw descriptor',
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
              'referencePath',
              'retainStaged',
            ]);
            assert.equal(reader.byteLength, bytes.length);
            refused(() => reader.referencePath(), 'reference requires retained staging');
            const result: Buffer[] = [];
            for (let offset = 0; offset < bytes.length; offset += 32768)
              result.push(reader.read(offset, Math.min(32768, bytes.length - offset)));
            assert.deepEqual(Buffer.concat(result), bytes);
            reader.retainStaged();
            assert.equal(reader.referencePath(), f.file('artifact'));
            assert.deepEqual(fs.readFileSync(reader.referencePath()), bytes);
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
          refused(() => reader.referencePath(), 'closed reference view refuses');
          assert.equal(f.settle(), 'settled');
        }
      },
    );
    for (const extension of ['png', 'jpg'] as const) {
      const bytes = extension === 'png' ? pngBytes : jpegBytes;
      const stageImage = (f: Fixture) => {
        const writer = beginJournal(
          f.store,
          owner(),
          bytes.length,
          f.scratch,
          f.metadata,
          native.ops,
          extension,
        );
        writer.write(bytes);
        writer.close();
        fs.writeFileSync(path.join(f.home, 'lease.json'), JSON.stringify(writer.lease), {
          mode: 0o600,
        });
        f.adoptLease();
        return writer;
      };
      await run(
        `journal image ${extension} original name quota markers and reopened cleanup`,
        (f) => {
          const writer = stageImage(f);
          const named = path.join(f.home, 'scratch', `${writer.lease.id}.${extension}`);
          const original = fs.statSync(named);
          assert.equal(original.nlink, 1);
          assert.equal(original.mode & 0o7777, 0o600);
          assert.deepEqual(fs.readdirSync(path.join(f.home, 'scratch')), [
            `${writer.lease.id}.${extension}`,
          ]);
          const reader = writer.openRead();
          try {
            refused(() => reader.referencePath(), 'image reference requires staged conversion');
            reader.retainStaged();
            assert.equal(reader.referencePath(), named);
            assert.deepEqual(fs.readFileSync(reader.referencePath()), bytes);
            assert.equal(fs.statSync(named).ino, original.ino);
            const retained = new Reservations(path.join(f.home, 'ledger')).inspect()[0];
            assert(retained?.journal);
            assert.equal(retained.journal.artifactExtension, extension);
            assert.equal(retained.state, 'staged');
            assert(retained.charge >= bytes.length + 3 * 4096);
            for (const kind of ['intent', 'owned']) {
              const marker = JSON.parse(
                fs.readFileSync(
                  path.join(f.home, 'metadata', `${writer.lease.id}.${kind}`),
                  'utf8',
                ),
              );
              assert.equal(marker.version, 2);
              assert.equal(marker.artifactExtension, extension);
            }
            refused(() => f.settle(), 'held image read blocks recovery', 'busy');
          } finally {
            reader.close();
          }
          const reopened = new Reservations(path.join(f.home, 'ledger'));
          const stored = reopened.inspect()[0];
          assert(stored?.journal);
          const captured = { id: stored.id, ...stored.journal };
          assert.equal(
            settleJournal(reopened, captured, f.scratch, f.metadata, native.ops),
            'settled',
          );
          assert.equal(
            settleJournal(reopened, captured, f.scratch, f.metadata, native.ops),
            'already_settled',
          );
          assert.equal(reopened.inspect()[0]?.charge, 0);
          assert.equal(reopened.inspect()[0]?.journal?.artifactExtension, extension);
          f.empty();
        },
      );
      await run(
        `journal image ${extension} wrong lease and immutable format refuse alternate cleanup`,
        (f) => {
          const writer = stageImage(f);
          const other = extension === 'png' ? 'jpg' : 'png';
          const alternate = path.join(f.home, 'scratch', `${writer.lease.id}.${other}`);
          fs.writeFileSync(alternate, bytes, { mode: 0o600 });
          const before = f.store.inspect();
          const { artifactExtension: originalExtension, ...legacyLease } = writer.lease;
          assert.equal(originalExtension, extension);
          for (const selected of [undefined, other] as const)
            refused(
              () =>
                settleJournal(
                  f.store,
                  selected === undefined
                    ? legacyLease
                    : { ...writer.lease, artifactExtension: selected },
                  f.scratch,
                  f.metadata,
                  native.ops,
                ),
              'wrong recorded extension',
            );
          assert.deepEqual(f.store.inspect(), before);
          const marker = path.join(f.home, 'metadata', `${writer.lease.id}.intent`);
          const original = fs.readFileSync(marker);
          const value = JSON.parse(original.toString());
          for (const selected of [other, 'png\u0000', null]) {
            fs.writeFileSync(marker, JSON.stringify({ ...value, artifactExtension: selected }));
            refused(() => writer.openRead(), 'immutable recorded extension mismatch');
            refused(() => f.settle(), 'cannot settle wrong format marker');
            f.charged();
            assert.deepEqual(fs.readFileSync(alternate), bytes);
          }
          fs.writeFileSync(marker, original);
          assert.equal(f.settle(), 'settled');
          assert.deepEqual(
            fs.readFileSync(alternate),
            bytes,
            'no alternate name was adopted or deleted',
          );
          fs.unlinkSync(alternate);
          f.empty();
        },
      );
      await run(
        `journal image ${extension} actual name mutations refuse retained references`,
        () => {
          for (const mode of [
            'replacement',
            'symlink',
            'hardlink',
            'mutation',
            'unlink',
            'root',
          ] as const) {
            const f = settlementFixture(temporary, native.ops);
            const writer = stageImage(f);
            const reader = writer.openRead();
            const named = path.join(f.home, 'scratch', `${writer.lease.id}.${extension}`);
            try {
              reader.retainStaged();
              assert.equal(reader.referencePath(), named);
              if (mode === 'replacement' || mode === 'symlink') {
                fs.renameSync(named, `${named}.retained`);
                if (mode === 'replacement') fs.writeFileSync(named, bytes, { mode: 0o600 });
                else fs.symlinkSync(`${named}.retained`, named);
              } else if (mode === 'hardlink') fs.linkSync(named, `${named}.linked`);
              else if (mode === 'mutation')
                fs.writeFileSync(named, bytes.subarray(0, bytes.length - 1));
              else if (mode === 'unlink') fs.unlinkSync(named);
              else {
                fs.renameSync(path.join(f.home, 'scratch'), path.join(f.home, 'scratch.retained'));
                fs.mkdirSync(path.join(f.home, 'scratch'), { mode: 0o700 });
              }
              refused(() => reader.referencePath(), 'changed original image reference');
              f.charged();
            } finally {
              reader.close();
              f.close();
            }
          }
        },
      );
      for (const stage of SETTLEMENT_STAGES) {
        await run(
          `journal image ${extension} actual SIGKILL ${stage} restart settles original name`,
          async (f) => {
            const mode = `staging-image-${extension}-${stage}`;
            await settlementProcess([f.home, mode], children, mode, undefined, sourceEntry());
            f.adoptLease();
            assert.equal(f.lease.artifactExtension, extension);
            // Preserve the existing death/restart fixture: nonblocking stores
            // never reclaim a dead writer's lock. Explicit waiting maintenance does.
            refused(() => f.settle(), 'fresh killed image ledger owner remains busy', 'busy');
            const ledgerFile = path.join(f.home, 'ledger', 'reservations.json');
            const lockFile = `${ledgerFile}.lock`;
            const killed = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
            assert.equal(killed.pid, children.at(-1)?.pid);
            assert.equal(killed.host, os.hostname());
            assert.throws(() => process.kill(killed.pid, 0), { code: 'ESRCH' });
            // Deliberate timestamp aging after exact reaping, not a wall-clock qualification.
            const past = Date.now() - 60000;
            fs.writeFileSync(lockFile, JSON.stringify({ ...killed, acquiredAt: past }));
            fs.utimesSync(lockFile, new Date(past), new Date(past));
            refused(
              () => f.settle(),
              'nonblocking image cleanup cannot reclaim stale lock',
              'busy',
            );
            withInterprocessFileLock(ledgerFile, () => {
              const current = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
              assert.equal(current.pid, process.pid);
            });
            assert.equal(f.settle(), stage === 'settled-committed' ? 'already_settled' : 'settled');
            assert.equal(f.store.inspect()[0]?.charge, 0);
            f.empty();
          },
        );
      }
    }
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
