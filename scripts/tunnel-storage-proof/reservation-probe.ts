import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { withInterprocessFileLockNonblocking } from '../../packages/daemon/src/storage/interprocess-file-lock';
import { writeRestrictedJson } from '../../packages/daemon/src/storage/restricted-json';
import image from '../tunnel-decoder-proof/fixture.png' with { type: 'file' };
import { ReservationError, Reservations } from './reservations';

const MIB = 1024 * 1024;
const HOME_BYTES = 100 * MIB;
const owner = () => ({
  device: randomBytes(32).toString('hex'),
  session: randomUUID(),
  hub: randomBytes(16).toString('hex'),
});
const executable = () =>
  Bun.main.startsWith('/$bunfs/') ? [process.execPath] : [process.execPath, Bun.main];

async function child(args: string[]): Promise<{ output: string; pid: number; reaped: boolean }> {
  const proc = Bun.spawn([...executable(), '--owned-spike', ...args], {
    env: { PATH: '/usr/bin:/bin', LANG: 'C', TMPDIR: os.tmpdir() },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stdout = new Response(proc.stdout).text();
  const stderr = new Response(proc.stderr).text();
  try {
    const exit = await Promise.race([
      proc.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('owned reservation child timed out')), 10_000);
      }),
    ]);
    const detail = await stderr;
    assert.equal(exit, 0, `owned reservation child exit: ${detail}`);
    return { output: await stdout, pid: proc.pid, reaped: proc.exitCode !== null };
  } finally {
    clearTimeout(timer);
    if (proc.exitCode === null) proc.kill('SIGKILL');
    await Promise.all([proc.exited, stdout, stderr]);
  }
}

async function together(args: string[][]) {
  // Await every owned child even if one fails, before deleting the shared fixture.
  const results = await Promise.allSettled(args.map(child));
  return results.map((result) => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  });
}

export async function reservationChild(
  mode: string | undefined,
  directory: string | undefined,
  sharedOwner: string | undefined,
): Promise<void> {
  assert(directory && path.isAbsolute(directory), 'owned ledger argument');
  const deadline = performance.now() + 3000;
  let store: Reservations | undefined;
  while (!store && performance.now() < deadline) {
    try {
      store = new Reservations(directory);
    } catch (error) {
      assert(error instanceof ReservationError && error.code === 'busy', 'open busy refusal');
      await Bun.sleep(5);
    }
  }
  assert(store, 'owned ledger opened before deadline');
  if (mode === 'inspect') {
    console.log(JSON.stringify(store.inspect()));
    return;
  }
  assert(mode === 'reserve' || mode === 'tiny', 'owned ledger child mode');
  const captured = mode === 'tiny' ? JSON.parse(sharedOwner ?? 'null') : null;
  assert(mode !== 'tiny' || captured, 'owned shared device argument');
  const ids: string[] = [];
  while (performance.now() < deadline) {
    try {
      const records = store.inspect();
      if (
        mode === 'tiny'
          ? records.filter((item) => item.device === captured.device && item.state === 'active')
              .length >= 2
          : records.reduce((sum, item) => sum + item.charge, 0) >= HOME_BYTES
      )
        break;
      ids.push(store.reserve(captured ?? owner(), mode === 'tiny' ? 1 : 10 * MIB));
    } catch (error) {
      assert(error instanceof ReservationError && error.code === 'busy', 'concurrent busy refusal');
      await Bun.sleep(5);
    }
  }
  console.log(JSON.stringify(ids));
}

export async function reservationProbe(): Promise<void> {
  const storageChild = await child(['--reservation-storage']);
  const storage = JSON.parse(storageChild.output.trim().split('\n').at(-1) ?? 'null');
  assert.equal(storage.bun, Bun.version, 'original storage Bun');
  assert.equal(storage.platform, process.platform, 'original storage host');
  assert.equal(storage.arch, process.arch, 'original storage architecture');
  assert.equal(storage.checks.length, 27, 'original storage check count');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-reservation-'));
  fs.chmodSync(temporary, 0o700);
  const checks: string[] = [...storage.checks];
  const children = [{ pid: storageChild.pid, reaped: storageChild.reaped }];
  let sequence = 0;
  const fixture = () => {
    const directory = path.join(temporary, String(sequence++));
    return { directory, store: Reservations.create(directory) };
  };
  const busy = (operation: () => unknown, witness: string) =>
    assert.throws(operation, { code: 'busy' }, witness);
  const unavailable = (operation: () => unknown, witness: string) =>
    assert.throws(operation, { code: 'unavailable' }, witness);
  try {
    {
      const { directory, store } = fixture();
      for (const [bytes, charge] of [
        [1, 4096],
        [4096, 4096],
        [4097, 8192],
        [10 * MIB, 10 * MIB],
      ]) {
        assert(bytes !== undefined && charge !== undefined);
        const id = store.reserve(owner(), bytes);
        assert.equal(
          store.inspect().find((item) => item.id === id)?.charge,
          charge,
          'minimum rounded charge',
        );
        store.retain(id, 'staged');
      }
      for (const bytes of [0, 10 * MIB + 1, 1.5, Number.MAX_SAFE_INTEGER])
        unavailable(() => store.reserve(owner(), bytes), 'invalid file size refused');
      unavailable(
        () => store.reserve({ ...owner(), device: 'unknown' }, 1),
        'invalid owner refused',
      );
      const supplied = { ...owner(), unrelated: 'server metadata' };
      store.reserve(supplied, 1);
      assert(
        store.inspect().every((item) => !('unrelated' in item)),
        'only accounting owner fields are persisted',
      );
      assert.equal(fs.statSync(path.join(directory, 'reservations.json')).mode & 0o777, 0o600);
      checks.push('durable byte rounding file and identity admission');
    }
    for (const [key, limit] of [
      ['device', 2],
      ['session', 4],
      ['hub', 8],
    ] as const) {
      const { store } = fixture();
      const captured = owner();
      let first = '';
      for (let index = 0; index < limit; index++) {
        const id = store.reserve({ ...owner(), [key]: captured[key] }, 1);
        first ||= id;
      }
      busy(() => store.reserve({ ...owner(), [key]: captured[key] }, 1), `${key} active limit`);
      store.retain(first, 'staged');
      store.reserve({ ...owner(), [key]: captured[key] }, 1);
      assert.equal(store.inspect().length, limit + 1, 'staging retains artifact reservation');
    }
    checks.push('active device session and hub saturation with staged conversion');
    {
      const { store } = fixture();
      let first = '';
      for (let index = 0; index < 10; index++) {
        const id = store.reserve(owner(), 10 * MIB);
        first ||= id;
      }
      busy(() => store.reserve(owner(), 1), 'home byte budget');
      store.retain(first, 'cleanup');
      busy(() => store.reserve(owner(), 1), 'failed cleanup retains byte charge');
      checks.push('home byte and retained cleanup saturation');
    }
    for (const perDevice of [true, false]) {
      const { store } = fixture();
      const captured = owner();
      for (let index = 0; index < (perDevice ? 32 : 128); index++) {
        const id = store.reserve(perDevice ? { ...owner(), device: captured.device } : owner(), 1);
        store.retain(id, 'staged');
      }
      busy(
        () => store.reserve(perDevice ? { ...owner(), device: captured.device } : owner(), 1),
        'tiny artifact count limit',
      );
    }
    checks.push('tiny artifact home and device saturation');
    {
      const { directory, store } = fixture();
      const bytes = Buffer.from(await Bun.file(image).arrayBuffer());
      assert(bytes.length > 0, 'owned image supplies real allocation bytes');
      for (let index = 0; index < 9; index++) store.reserve(owner(), 10 * MIB);
      store.reserve(owner(), 10 * MIB - 4096);
      const id = store.reserve(owner(), 1);
      assert.equal(
        store.inspect().find((item) => item.id === id)?.state,
        'active',
        'reservation precedes creation',
      );
      const artifact = path.join(directory, `${id}.partial`);
      // Repeat only owned image bytes for an actual scratch-growth accounting control.
      fs.writeFileSync(
        artifact,
        Buffer.concat(Array(Math.ceil(8192 / bytes.length)).fill(bytes)).subarray(0, 8192),
        { flag: 'wx', mode: 0o600 },
      );
      const allocated = fs.statSync(artifact).blocks * 512;
      assert(allocated > 4096, 'real allocated blocks exceed minimum');
      store.retain(id, 'cleanup', allocated);
      busy(() => store.reserve(owner(), 1), 'actual allocation debt refuses new admission');
      unavailable(() => store.retain(id, 'staged'), 'cleanup cannot revive staging');
      fs.unlinkSync(artifact);
      assert(!fs.existsSync(artifact), 'owned deletion confirmed before release');
      store.releaseAfterCleanup(id);
      store.reserve(owner(), 1);
      checks.push('actual allocated blocks debt and confirmed deletion before release');
    }
    {
      const { directory, store } = fixture();
      store.reserve(owner(), 1);
      const file = path.join(directory, 'reservations.json');
      const valid = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const value of [
        null,
        {},
        { ...valid, version: 2 },
        { ...valid, unknown: true },
        { ...valid, records: [...valid.records, ...valid.records] },
        { ...valid, records: [{ ...valid.records[0], charge: 0 }] },
        { ...valid, records: [{ ...valid.records[0], bytes: '1' }] },
        { ...valid, records: [{ ...valid.records[0], state: 'unknown' }] },
        { ...valid, records: [{ ...valid.records[0], device: 'unknown' }] },
        {
          ...valid,
          records: [
            { ...valid.records[0], charge: Number.MAX_SAFE_INTEGER },
            { ...valid.records[0], id: randomBytes(16).toString('hex') },
          ],
        },
      ]) {
        writeRestrictedJson(file, value);
        unavailable(() => new Reservations(directory), 'malformed ledger refuses');
      }
      for (const [key, count, state] of [
        ['device', 3, 'active'],
        ['session', 5, 'active'],
        ['hub', 9, 'active'],
        ['device', 33, 'staged'],
        ['home', 129, 'staged'],
      ] as const) {
        const captured = owner();
        writeRestrictedJson(file, {
          version: 1,
          records: Array.from({ length: count }, () => ({
            ...owner(),
            ...(key === 'home' ? {} : { [key]: captured[key] }),
            id: randomBytes(16).toString('hex'),
            bytes: 1,
            charge: 4096,
            state,
          })),
        });
        unavailable(() => new Reservations(directory), 'inconsistent ledger counts refuse');
      }
      fs.writeFileSync(file, Buffer.alloc(256 * 1024 + 1));
      unavailable(() => new Reservations(directory), 'oversized ledger refuses');
      writeRestrictedJson(file, valid);
      fs.chmodSync(file, 0o644);
      unavailable(() => new Reservations(directory), 'nonprivate ledger refuses');
      fs.chmodSync(file, 0o600);
      fs.unlinkSync(file);
      unavailable(() => new Reservations(directory), 'missing ledger refuses without reset');
      writeRestrictedJson(file, valid);
      assert.equal(store.inspect().length, 1, 'preserved reservation after refusal controls');
      checks.push('missing malformed and nonprivate ledger refuses without reset');
    }
    {
      const { directory, store } = fixture();
      fs.renameSync(directory, `${directory}-moved`);
      fs.mkdirSync(directory, { mode: 0o700 });
      unavailable(() => store.reserve(owner(), 1), 'root replacement refuses');
      assert.deepEqual(fs.readdirSync(directory), [], 'replacement namespace untouched');
      checks.push('private metadata root replacement refusal');
    }
    {
      const { directory, store } = fixture();
      const results = await together(
        [0, 1, 2].map(() => ['--reservation-child', 'reserve', directory]),
      );
      children.push(...results.map(({ pid, reaped }) => ({ pid, reaped })));
      const ids = results.flatMap((item) => JSON.parse(item.output));
      assert.equal(ids.length, 10, 'multiprocess exact home saturation');
      assert.equal(new Set(ids).size, 10, 'multiprocess unique reservations');
      assert.equal(store.inspect().length, 10, 'multiprocess durable records');
      const restarted = await child(['--reservation-child', 'inspect', directory]);
      children.push({ pid: restarted.pid, reaped: restarted.reaped });
      assert.deepEqual(
        JSON.parse(restarted.output),
        store.inspect(),
        'restart preserves accounting',
      );
      const tiny = fixture();
      const captured = owner();
      const tinyResults = await together(
        [0, 1, 2].map(() => [
          '--reservation-child',
          'tiny',
          tiny.directory,
          JSON.stringify(captured),
        ]),
      );
      children.push(...tinyResults.map(({ pid, reaped }) => ({ pid, reaped })));
      const tinyIds = tinyResults.flatMap((item) => JSON.parse(item.output));
      assert.equal(tinyIds.length, 2, 'multiprocess shared device tiny saturation');
      assert.equal(new Set(tinyIds).size, 2, 'multiprocess shared device unique reservations');
      assert.equal(tiny.store.inspect().length, 2, 'multiprocess shared device durable records');
      assert(
        tiny.store
          .inspect()
          .every((item) => item.device === captured.device && item.state === 'active'),
        'multiprocess device identity shared across connections',
      );
      checks.push('real multiprocess admission and restart accounting');
    }
    {
      const { directory, store } = fixture();
      const file = path.join(directory, 'reservations.json');
      store.reserve(owner(), 1);
      const records = store.inspect();
      const originalInode = fs.statSync(file).ino;
      withInterprocessFileLockNonblocking(file, () => {
        writeRestrictedJson(file, { version: 1, records });
        const start = performance.now();
        busy(() => store.reserve(owner(), 1), 'contended lock refuses');
        busy(() => new Reservations(directory), 'contended constructor refuses');
        busy(() => store.inspect(), 'contended inspection refuses');
        assert(performance.now() - start < 250, 'nonblocking lock did not wait');
      });
      const renamed = fs.statSync(file);
      assert.notEqual(renamed.ino, originalInode, 'cooperating writer replaced actual inode');
      assert.deepEqual(
        new Reservations(directory).inspect(),
        records,
        'atomic rename reopen accounting',
      );
      assert.equal(fs.statSync(file).ino, renamed.ino, 'inspection does not rewrite metadata');
      withInterprocessFileLockNonblocking(file, () => {
        writeRestrictedJson(file, { version: 2, records });
      });
      unavailable(() => new Reservations(directory), 'corrupt cooperating write refuses reopen');
      unavailable(() => store.inspect(), 'corrupt cooperating write refuses inspect');
      withInterprocessFileLockNonblocking(file, () => {
        writeRestrictedJson(file, { version: 1, records });
      });
      store.reserve(owner(), 1);
      checks.push('nonblocking owned lock contention refuses without waiting');
    }
    assert(
      children.every((item) => item.reaped),
      'every owned child reaped',
    );
    console.log(
      JSON.stringify({
        bun: Bun.version,
        platform: process.platform,
        arch: process.arch,
        checks,
        children,
        parentMemoryAtReceipt: process.memoryUsage(),
        reservationInputSha256: createHash('sha256')
          .update(Buffer.from(await Bun.file(image).arrayBuffer()))
          .digest('hex'),
        scope:
          'standalone trusted-namespace quota accounting; no transfer authority, descriptor journal, orphan recovery or production caller',
      }),
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
