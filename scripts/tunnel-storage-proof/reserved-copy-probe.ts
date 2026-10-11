import { FFIType, cc, dlopen, ptr } from 'bun:ffi';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { withInterprocessFileLockNonblocking } from '../../packages/daemon/src/storage/interprocess-file-lock';
import { writeRestrictedJson } from '../../packages/daemon/src/storage/restricted-json';
import image from '../tunnel-decoder-proof/fixture.png' with { type: 'file' };
import { DirectoryRoot, FileAdmission } from './admission';
import nativeSource from './openat.c' with { type: 'file' };
import type { CopyCheckpoint, PrivateOps } from './private-copy';
import { CLEANUP_BLOCKING_DEBT, Reservations } from './reservations';
import { ReservedCopyError, reserveAndCopy } from './reserved-copy';

const owner = () => ({
  device: randomBytes(32).toString('hex'),
  session: randomUUID(),
  hub: randomBytes(16).toString('hex'),
});
const name = (value: string) => Buffer.from(`${value}\0`);

export async function reservedCopyProbe() {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remi-reserved-copy-')));
  const helper = path.join(temporary, 'fixed.c');
  fs.writeFileSync(helper, Buffer.from(await Bun.file(nativeSource).arrayBuffer()), {
    mode: 0o600,
    flag: 'wx',
  });
  const fixed = cc({
    source: helper,
    flags: ['-nostdlib'],
    symbols: {
      remi_openat_create: {
        args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32],
        returns: FFIType.i32,
      },
      remi_preallocate_owned: {
        args: [FFIType.ptr, FFIType.i32, FFIType.i32],
        returns: FFIType.i32,
      },
    },
  });
  const library = process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
  const lib = dlopen(library, {
    openat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    linkat: {
      args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32],
      returns: FFIType.i32,
    },
    unlinkat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  });
  const loader = dlopen(process.platform === 'darwin' ? library : 'libdl.so.2', {
    dlopen: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.ptr },
    dlsym: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    dlclose: { args: [FFIType.ptr], returns: FFIType.i32 },
  });
  const libraryName = name(library);
  const openAtName = name('openat');
  const allocateName = name(process.platform === 'darwin' ? 'fcntl' : 'fallocate');
  const handle = loader.symbols.dlopen(ptr(libraryName), 2);
  assert(handle !== null && handle > 0, 'owned native fixture library');
  const openAtAddress = loader.symbols.dlsym(handle, ptr(openAtName));
  const allocateAddress = loader.symbols.dlsym(handle, ptr(allocateName));
  const ops: PrivateOps = {
    openAt: (fd, value, flags) => {
      const encoded = name(value);
      return lib.symbols.openat(fd, ptr(encoded), flags);
    },
    create: (fd, value, flags, mode) => {
      const encoded = name(value);
      return fixed.symbols.remi_openat_create(openAtAddress, fd, ptr(encoded), flags, mode);
    },
    link: (fd, from, to) => {
      const left = name(from);
      const right = name(to);
      return lib.symbols.linkat(fd, ptr(left), fd, ptr(right), 0);
    },
    unlink: (fd, value) => {
      const encoded = name(value);
      return lib.symbols.unlinkat(fd, ptr(encoded), 0);
    },
  };
  const bytes = Buffer.from(await Bun.file(image).arrayBuffer());
  const checks: string[] = [];
  let sequence = 0;
  const fixture = () => {
    const home = path.join(temporary, String(sequence++));
    const project = path.join(home, 'project');
    const privatePath = path.join(home, 'private');
    fs.mkdirSync(project, { recursive: true, mode: 0o700 });
    fs.mkdirSync(privatePath, { mode: 0o700 });
    const filename = path.join(project, 'image.png');
    fs.writeFileSync(filename, bytes, { mode: 0o600 });
    const projectRoot = DirectoryRoot.capture(project, ops.openAt);
    const scratch = DirectoryRoot.capture(privatePath, ops.openAt);
    assert(projectRoot && scratch, 'reserved fixture roots');
    const source = new FileAdmission(ops.openAt, []).open(projectRoot, ['image.png']);
    assert(source, 'reserved fixture admitted PNG');
    const ledgerPath = path.join(home, 'ledger');
    const store = Reservations.create(ledgerPath);
    return {
      home,
      privatePath,
      filename,
      scratch,
      source,
      store,
      ledgerPath,
      close() {
        source.close();
        scratch.close();
        projectRoot.close();
        fs.rmSync(home, { recursive: true, force: true });
      },
    };
  };
  const accountingError = (operation: () => unknown, cleanupConfirmed: boolean, witness: string) =>
    assert.throws(
      operation,
      (error) => error instanceof ReservedCopyError && error.cleanupConfirmed === cleanupConfirmed,
      witness,
    );
  const cleanupWitnesses: {
    completed: boolean;
    originalInode: number;
    heldInode: number;
    unlinkResult: number;
    retainedCharge: number;
    allocatedBytes: number;
  }[] = [];
  const measurements = {
    logicalBytes: bytes.length,
    originalAllocatedBytes: 0,
    preallocatedBytes: 0,
    retainedCharge: 0,
    allocationExit: -1,
    cleanupWitnesses,
    unknownAllocation: { reusedDescriptor: false, fixtureAllocatedBytes: 0, blockingDebt: 0 },
  };
  try {
    assert(handle && openAtAddress && allocateAddress, 'owned native fixture symbols');
    {
      const f = fixture();
      let created = -1;
      const observations: boolean[] = [];
      let chargedAtDeletion = false;
      const wrapped = {
        ...ops,
        unlink(fd: number, value: string) {
          if (value.endsWith('.complete')) chargedAtDeletion = f.store.inspect().length === 1;
          return ops.unlink(fd, value);
        },
      };
      try {
        const artifact = reserveAndCopy(f.source, f.scratch, wrapped, f.store, owner(), (event) => {
          observations.push(f.store.inspect().some((record) => record.state === 'active'));
          if (event.stage === 'created') created = event.fd;
          if (event.stage === 'validated') {
            measurements.originalAllocatedBytes = fs.fstatSync(created).blocks * 512;
            measurements.allocationExit = fixed.symbols.remi_preallocate_owned(
              allocateAddress,
              process.platform === 'darwin' ? 1 : 0,
              created,
            );
            measurements.preallocatedBytes = fs.fstatSync(created).blocks * 512;
          }
        });
        assert(artifact, 'reserved owned PNG copied');
        try {
          assert(
            observations.length >= 3 && observations.every(Boolean),
            'active reservation precedes private effects',
          );
          assert.equal(measurements.allocationExit, 0, 'actual preallocation syscall succeeded');
          assert(
            measurements.preallocatedBytes > Math.ceil(bytes.length / 4096) * 4096,
            'actual preallocation exceeds logical rounding',
          );
          assert.equal(artifact.size, bytes.length, 'reserved exact length');
          assert.equal(
            artifact.sha256,
            createHash('sha256').update(bytes).digest('hex'),
            'reserved exact digest',
          );
          const copied = Buffer.alloc(bytes.length);
          assert.equal(artifact.read(copied, 0), bytes.length, 'reserved exact read length');
          assert.deepEqual(copied, bytes, 'reserved exact PNG bytes');
          const record = f.store.inspect()[0];
          assert(record?.state === 'staged', 'reserved staged before handle returned');
          measurements.retainedCharge = record.charge;
          assert.equal(
            record.charge,
            measurements.preallocatedBytes,
            'staged reservation includes same descriptor allocated blocks',
          );
        } finally {
          artifact.close();
        }
        assert(chargedAtDeletion, 'reservation retained until confirmed deletion');
        artifact.close();
        assert.deepEqual(fs.readdirSync(f.privatePath), [], 'reserved successful deletion');
        assert.equal(f.store.inspect().length, 0, 'confirmed deletion refunded reservation');
      } finally {
        f.close();
      }
      checks.push('reserved owned PNG preallocated blocks staging and deletion');
    }
    {
      const f = fixture();
      const events: CopyCheckpoint[] = [];
      try {
        for (let index = 0; index < 10; index++) f.store.reserve(owner(), 10 * 1024 * 1024);
        assert.throws(
          () =>
            reserveAndCopy(f.source, f.scratch, ops, f.store, owner(), (event) =>
              events.push(event),
            ),
          { code: 'busy' },
          'full home refuses reserved copy',
        );
        assert.equal(events.length, 0, 'full home has no copy checkpoint');
        assert.deepEqual(fs.readdirSync(f.privatePath), [], 'full home has no private creation');
      } finally {
        f.close();
      }
      checks.push('full home reservation refuses before private copy effects');
    }
    {
      const f = fixture();
      let changed = false;
      try {
        const artifact = reserveAndCopy(f.source, f.scratch, ops, f.store, owner(), (event) => {
          if (event.stage === 'read' && !changed) {
            fs.appendFileSync(f.filename, 'growth');
            changed = true;
          }
        });
        assert(changed, 'reserved growth checkpoint completed');
        assert.equal(artifact, null, 'reserved growth refused');
        assert.deepEqual(fs.readdirSync(f.privatePath), [], 'reserved growth partial deleted');
        assert.equal(f.store.inspect().length, 0, 'reserved growth refunded after cleanup');
      } finally {
        f.close();
      }
      checks.push('source growth cleanup confirmed before reservation refund');
    }
    for (const completed of [true, false]) {
      const f = fixture();
      let moved = '';
      let original = '';
      let inode = 0;
      let device = 0;
      let syscall = 0;
      let changed = false;
      let partialFD = -1;
      let allocationExit = -1;
      const wrapped = {
        ...ops,
        unlink(fd: number, value: string) {
          if (!changed && value.endsWith(completed ? '.complete' : '.partial')) {
            original = path.join(f.privatePath, value);
            moved = path.join(f.privatePath, 'owned-held');
            inode = fs.statSync(original).ino;
            device = fs.statSync(original).dev;
            fs.renameSync(original, moved);
            changed = true;
            syscall = ops.unlink(fd, value); // Actual ENOENT after sameName succeeded.
            return syscall;
          }
          return ops.unlink(fd, value);
        },
      };
      try {
        if (completed) {
          const artifact = reserveAndCopy(
            f.source,
            f.scratch,
            wrapped,
            f.store,
            owner(),
            (event) => {
              if (event.stage === 'created') partialFD = event.fd;
            },
          );
          assert(artifact, 'reserved cleanup fixture copied');
          try {
            allocationExit = fixed.symbols.remi_preallocate_owned(
              allocateAddress,
              process.platform === 'darwin' ? 1 : 0,
              partialFD,
            );
            assert.equal(allocationExit, 0, 'failed completed allocation checkpoint completed');
            accountingError(() => artifact.close(), false, 'completed unlink failure visible');
            assert(changed && syscall !== 0, 'actual completed native unlink failed');
            assert.equal(fs.statSync(moved).ino, inode, 'completed held inode preserved');
            assert.equal(
              f.store.inspect()[0]?.state,
              'cleanup',
              'failed completed cleanup retains cleanup state',
            );
            assert.equal(f.store.inspect().length, 1, 'failed completed cleanup retains charge');
            assert.equal(
              f.store.inspect()[0]?.charge,
              Math.max(8192, fs.statSync(moved).blocks * 512),
              'failed completed retains actual allocated block charge',
            );
            cleanupWitnesses.push({
              completed,
              originalInode: inode,
              heldInode: fs.statSync(moved).ino,
              unlinkResult: syscall,
              retainedCharge: f.store.inspect()[0]?.charge ?? 0,
              allocatedBytes: fs.statSync(moved).blocks * 512,
            });
          } finally {
            if (changed) fs.renameSync(moved, original);
            artifact.close();
          }
          assert.equal(f.store.inspect().length, 0, 'completed retry refunded after deletion');
        } else {
          accountingError(
            () =>
              reserveAndCopy(f.source, f.scratch, wrapped, f.store, owner(), (event) => {
                if (event.stage === 'created') partialFD = event.fd;
                if (event.stage === 'read') {
                  allocationExit = fixed.symbols.remi_preallocate_owned(
                    allocateAddress,
                    process.platform === 'darwin' ? 1 : 0,
                    partialFD,
                  );
                  fs.appendFileSync(f.filename, 'growth');
                }
              }),
            false,
            'partial unlink failure visible',
          );
          assert(changed && syscall !== 0, 'actual partial native unlink failed');
          assert.equal(allocationExit, 0, 'failed partial allocation checkpoint completed');
          assert.equal(fs.statSync(moved).ino, inode, 'partial held inode preserved');
          const record = f.store.inspect()[0];
          assert(record?.state === 'cleanup', 'failed partial cleanup retains cleanup state');
          assert.equal(
            record.charge,
            Math.max(8192, fs.statSync(moved).blocks * 512),
            'failed partial retains actual allocated block charge',
          );
          cleanupWitnesses.push({
            completed,
            originalInode: inode,
            heldInode: fs.statSync(moved).ino,
            unlinkResult: syscall,
            retainedCharge: record.charge,
            allocatedBytes: fs.statSync(moved).blocks * 512,
          });
          const held = fs.statSync(moved);
          assert(
            held.isFile() &&
              held.ino === inode &&
              held.dev === device &&
              held.nlink === 1 &&
              held.uid === process.getuid?.(),
            'known partial fixture ownership confirmed',
          );
          fs.unlinkSync(moved); // Explicit known owned fixture; no ledger-based discovery.
          assert(!fs.existsSync(moved), 'explicit owned partial deletion confirmed');
          f.store.releaseAfterCleanup(record.id);
          assert.equal(f.store.inspect().length, 0, 'explicit partial cleanup refunded');
        }
      } finally {
        f.close();
      }
      checks.push(
        completed
          ? 'actual completed unlink failure retains reservation and retries'
          : 'actual partial unlink failure retains reservation until explicit cleanup',
      );
    }
    {
      const f = fixture();
      const replacement = path.join(f.home, 'other-owned.png');
      fs.writeFileSync(replacement, bytes, { mode: 0o600 });
      let partialFD = -1;
      let replacementFD = -1;
      let moved = '';
      let owned: fs.Stats | undefined;
      let syscall = 0;
      let allocationExit = -1;
      const wrapped = {
        ...ops,
        unlink(fd: number, value: string) {
          const original = path.join(f.privatePath, value);
          owned = fs.statSync(original);
          moved = path.join(f.privatePath, 'owned-held');
          fs.renameSync(original, moved);
          syscall = ops.unlink(fd, value);
          return syscall;
        },
      };
      try {
        accountingError(
          () =>
            reserveAndCopy(f.source, f.scratch, wrapped, f.store, owner(), (event) => {
              if (event.stage === 'created') partialFD = event.fd;
              if (event.stage === 'read') {
                allocationExit = fixed.symbols.remi_preallocate_owned(
                  allocateAddress,
                  process.platform === 'darwin' ? 1 : 0,
                  partialFD,
                );
                fs.closeSync(partialFD);
                replacementFD = fs.openSync(replacement, 'r');
                fs.appendFileSync(f.filename, 'growth');
              }
            }),
          false,
          'unknown owned allocation cleanup remains unconfirmed',
        );
        assert.equal(allocationExit, 0, 'unknown allocation preallocation checkpoint completed');
        assert.equal(replacementFD, partialFD, 'actual private descriptor reused');
        assert(owned && syscall !== 0 && moved, 'unknown allocation actual native unlink failed');
        const held = fs.statSync(moved);
        assert(
          held.dev === owned.dev &&
            held.ino === owned.ino &&
            held.isFile() &&
            held.nlink === 1 &&
            held.uid === process.getuid?.(),
          'unknown allocation known held fixture identity',
        );
        assert.notEqual(
          fs.statSync(replacement).ino,
          held.ino,
          'replacement descriptor is not the owned partial',
        );
        const record = f.store.inspect()[0];
        assert(record?.state === 'cleanup', 'unknown allocation retains cleanup state');
        assert.equal(
          record.charge,
          CLEANUP_BLOCKING_DEBT,
          'unknown allocation retains blocking accounting debt',
        );
        assert.throws(
          () => f.store.reserve(owner(), 1),
          { code: 'busy' },
          'unknown allocation blocks every fresh admission',
        );
        measurements.unknownAllocation = {
          reusedDescriptor: true,
          fixtureAllocatedBytes: held.blocks * 512,
          blockingDebt: record.charge,
        };
        assert.throws(
          () => fs.fstatSync(replacementFD),
          { code: 'EBADF' },
          'discard closed replacement descriptor',
        );
        fs.unlinkSync(moved); // Explicit known fixture cleanup; no allocation or deletion path fallback.
        assert(!fs.existsSync(moved), 'unknown allocation explicit owned deletion confirmed');
        f.store.releaseAfterCleanup(record.id);
        f.store.reserve(owner(), 1);
      } finally {
        // If a checkpoint failed before discard acquired the replacement, close only that owned FD.
        try {
          if (replacementFD >= 0) fs.closeSync(replacementFD);
        } catch (error) {
          assert.equal(
            (error as NodeJS.ErrnoException).code,
            'EBADF',
            'owned replacement already closed',
          );
        }
        f.close();
      }
    }
    {
      const f = fixture();
      try {
        const artifact = reserveAndCopy(f.source, f.scratch, ops, f.store, owner());
        assert(artifact, 'reserved root replacement copied');
        fs.renameSync(f.privatePath, path.join(f.home, 'retained-private'));
        fs.mkdirSync(f.privatePath, { mode: 0o700 });
        fs.writeFileSync(path.join(f.privatePath, 'marker'), bytes, { mode: 0o600 });
        artifact.close();
        assert.deepEqual(
          fs.readdirSync(path.join(f.home, 'retained-private')),
          [],
          'reserved captured root cleaned',
        );
        assert.deepEqual(
          fs.readFileSync(path.join(f.privatePath, 'marker')),
          bytes,
          'reserved replacement outside untouched',
        );
        assert.equal(f.store.inspect().length, 0, 'captured cleanup released reservation');
      } finally {
        f.close();
      }
      checks.push('captured private root replacement cleanup precedes reservation release');
    }
    {
      const f = fixture();
      try {
        const artifact = reserveAndCopy(f.source, f.scratch, ops, f.store, owner());
        assert(artifact, 'reserved accounting fixture copied');
        const file = path.join(f.ledgerPath, 'reservations.json');
        withInterprocessFileLockNonblocking(file, () => {
          accountingError(
            () => artifact.close(),
            true,
            'accounting contention distinguishes confirmed deletion',
          );
          assert.deepEqual(
            fs.readdirSync(f.privatePath),
            [],
            'contended accounting has confirmed deletion',
          );
          assert.equal(
            JSON.parse(fs.readFileSync(file, 'utf8')).records.length,
            1,
            'prewrite lock refusal retained accounting',
          );
        });
        const valid = JSON.parse(fs.readFileSync(file, 'utf8'));
        writeRestrictedJson(file, { ...valid, version: 2 });
        accountingError(() => artifact.close(), true, 'corrupt accounting after deletion refuses');
        writeRestrictedJson(file, valid); // Restore this known fixture, never initialize fresh accounting.
        artifact.close();
        artifact.close();
        assert.equal(f.store.inspect().length, 0, 'known lock-refusal retry released accounting');
      } finally {
        f.close();
      }
      checks.push('confirmed deletion accounting contention and corrupt read refusal');
    }
    return { checks, measurements };
  } finally {
    fixed.close();
    lib.close();
    loader.symbols.dlclose(handle);
    loader.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
