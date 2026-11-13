import { afterEach, expect, test } from 'bun:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { withInterprocessFileLockNonblocking } from '../../src/storage/interprocess-file-lock';
import { beginJournal, settleJournal } from '../../src/tunnel/journal-settlement';
import { openManagedTunnelStorage } from '../../src/tunnel/managed-tunnel-storage';

const homes: string[] = [];
const home = () => {
  const directory = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'remi-managed-storage-')));
  fs.chmodSync(directory, 0o700);
  homes.push(directory);
  return directory;
};
const owner = () => ({
  device: randomBytes(32).toString('hex'),
  session: randomUUID(),
  hub: randomBytes(16).toString('hex'),
});
afterEach(() => {
  for (const directory of homes.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

test('exact shared namespace and hub keep live journal/read barriers and independent native owners', async () => {
  const directory = home();
  const first = await openManagedTunnelStorage(directory);
  const second = await openManagedTunnelStorage(directory);
  try {
    expect(first.base).toBe(join(directory, 'image-staging'));
    expect(fs.readdirSync(first.base).sort()).toEqual(['ledger', 'metadata', 'scratch']);
    const stat = fs.lstatSync(join(first.base, 'ledger'), { bigint: true });
    const expected = createHash('sha256')
      .update(`remi-image-staging:${stat.dev}:${stat.ino}`)
      .digest('hex')
      .slice(0, 32);
    expect(first.hub).toBe(expected);
    expect(second.hub).toBe(expected);
    const selected = { ...owner(), hub: first.hub };
    const writer = beginJournal(first.store, selected, 7, first.scratch, first.metadata, first.ops);
    writer.write('managed');
    second.recover();
    expect(first.store.inspect()[0]?.state).toBe('active');
    writer.close();
    const reader = writer.openRead();
    second.recover();
    expect(first.store.inspect()[0]?.state).toBe('active');
    second.close();
    second.close();
    expect(reader.read(0, 7).toString()).toBe('managed');
    reader.close();
    expect(settleJournal(first.store, writer.lease, first.scratch, first.metadata, first.ops)).toBe(
      'settled',
    );
    expect(first.store.inspect()[0]?.charge).toBe(0);
    expect(fs.readdirSync(join(first.base, 'scratch'))).toEqual([]);
    expect(fs.readdirSync(join(first.base, 'metadata'))).toEqual([]);
  } finally {
    second.close();
    first.close();
    first.close();
  }
});

test('real process death releases journal ownership for the same shared recovery implementation', async () => {
  const directory = home();
  const source = join(directory, 'child.ts');
  const storageModule = resolve(import.meta.dir, '../../src/tunnel/managed-tunnel-storage.ts');
  const journalModule = resolve(import.meta.dir, '../../src/tunnel/journal-settlement.ts');
  fs.writeFileSync(
    source,
    `import {openManagedTunnelStorage} from ${JSON.stringify(storageModule)};import {beginJournal} from ${JSON.stringify(journalModule)};const storage=await openManagedTunnelStorage(process.argv[2]);const writer=beginJournal(storage.store,${JSON.stringify(owner())},7,storage.scratch,storage.metadata,storage.ops);writer.write('managed');process.exit(0);`,
    { mode: 0o600 },
  );
  const child = Bun.spawn([process.execPath, '--no-env-file', source, directory], {
    cwd: directory,
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: directory, TMPDIR: tmpdir() },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const exit = await Promise.race([
      child.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Owned storage child deadline')), 5000);
      }),
    ]);
    expect(exit).toBe(0);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill('SIGKILL');
    await child.exited;
  }
  const storage = await openManagedTunnelStorage(directory);
  try {
    expect(storage.store.inspect().some((row) => row.state === 'active' && row.charge > 0)).toBe(
      true,
    );
    storage.recover();
    expect(
      storage.store.inspect().every((row) => row.state === 'settled' && row.charge === 0),
    ).toBe(true);
    expect(fs.readdirSync(join(storage.base, 'scratch'))).toEqual([]);
    expect(fs.readdirSync(join(storage.base, 'metadata'))).toEqual([]);
  } finally {
    storage.close();
  }
});

test('initialization contention is nonblocking and private opening never recreates lost ledger state', async () => {
  const directory = home();
  const started = performance.now();
  const pending = withInterprocessFileLockNonblocking(
    join(directory, 'image-staging-initialize'),
    () => openManagedTunnelStorage(directory),
  );
  await expect(pending).rejects.toThrow();
  expect(performance.now() - started).toBeLessThan(1000);
  expect(fs.existsSync(join(directory, 'image-staging'))).toBe(false);
  const storage = await openManagedTunnelStorage(directory);
  storage.close();
  const ledger = join(storage.base, 'ledger', 'reservations.json');
  fs.unlinkSync(ledger);
  await expect(openManagedTunnelStorage(directory)).rejects.toThrow();
  expect(fs.existsSync(ledger)).toBe(false);
  const unsafe = home();
  fs.chmodSync(unsafe, 0o755);
  await expect(openManagedTunnelStorage(unsafe)).rejects.toThrow();
  expect(fs.readdirSync(unsafe)).toEqual([]);
});
