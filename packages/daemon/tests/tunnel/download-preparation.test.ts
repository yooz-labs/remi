import { expect, test } from 'bun:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentity } from '@remi/shared';
import { IdentityStore } from '../../src/auth/identity-store';
import { DirectoryRoot, FileAdmission } from '../../src/tunnel/admission';
import {
  type DownloadCopyContext,
  DownloadPreparationError,
  prepareDownloadCopy,
} from '../../src/tunnel/download-preparation';
import { recoveryNative } from '../../src/tunnel/recovery-native';
import { Reservations } from '../../src/tunnel/reservations';

const MIB = 1024 * 1024;
const SOURCE_CHUNK = 32 * 1024;

// Count transactions on one ledger. Every call reaches the real lock and filesystem.
class CountingReservations extends Reservations {
  readonly writePositions: number[] = [];
  readAccounts = 0;

  override writeJournal(...args: Parameters<Reservations['writeJournal']>): void {
    this.writePositions.push(args[1]);
    super.writeJournal(...args);
  }

  override captureJournalRead(...args: Parameters<Reservations['captureJournalRead']>): number {
    this.readAccounts++;
    return super.captureJournalRead(...args);
  }
}

async function withCopyFixture(
  size: number,
  run: (fixture: {
    bytes: Buffer<ArrayBuffer>;
    home: string;
    scratchPath: string;
    metadataPath: string;
    store: CountingReservations;
    prepare: (context: DownloadCopyContext) => ReturnType<typeof prepareDownloadCopy>;
  }) => Promise<void>,
): Promise<void> {
  const native = await recoveryNative();
  const home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'remi-download-copy-')));
  const roots: DirectoryRoot[] = [];
  try {
    const openAt = native.ops.openAt.bind(native.ops);
    const capture = (name: string): DirectoryRoot => {
      const directory = join(home, name);
      fs.mkdirSync(directory, { mode: 0o700 });
      const root = DirectoryRoot.capture(directory, openAt);
      if (!root) throw new Error('Owned download root capture failed');
      roots.push(root);
      return root;
    };
    const project = capture('project');
    const scratch = capture('scratch');
    const metadata = capture('metadata');
    const bytes = randomBytes(size);
    fs.writeFileSync(join(project.pathname, 'sample.bin'), bytes, { mode: 0o600 });
    const ledger = join(home, 'ledger');
    Reservations.create(ledger);
    const store = new CountingReservations(ledger);
    const owner = {
      device: randomBytes(32).toString('hex'),
      session: randomUUID(),
      hub: randomBytes(16).toString('hex'),
    };
    const source = new FileAdmission(openAt, []).open(project, ['sample.bin']);
    if (!source) throw new Error('Owned download source admission failed');
    try {
      await run({
        bytes,
        home,
        scratchPath: scratch.pathname,
        metadataPath: metadata.pathname,
        store,
        prepare: (context) =>
          prepareDownloadCopy(source, store, owner, scratch, metadata, native.ops, context),
      });
    } finally {
      source.close();
    }
  } finally {
    for (const root of roots.reverse()) root.close();
    native.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const unguardedContext: DownloadCopyContext = {
  effect: (operation) => operation(),
  yield: () => Bun.sleep(0),
};

test('10 MiB download preparation bounds real write and verification transactions', async () => {
  await withCopyFixture(10 * MIB, async ({ bytes, store, prepare }) => {
    const copy = await prepare(unguardedContext);
    try {
      const counts = { writes: store.writePositions.length, readAccounts: store.readAccounts };
      // Count reader open and the final descriptor recheck as part of verification.
      expect(counts.writes, JSON.stringify(counts)).toBeLessThanOrEqual(12);
      expect(counts.readAccounts, JSON.stringify(counts)).toBeLessThanOrEqual(3 * 12);
      expect(copy.byteLength).toBe(bytes.length);
      expect(copy.digest).toBe(createHash('sha256').update(bytes).digest('base64url'));
      expect(() => copy.read(0, MIB + 1)).toThrow('recovery unavailable');
    } finally {
      expect(copy.retire()).toBe('settled');
    }
  });
});

test.each([
  { size: MIB + 1, writePositions: [MIB, MIB + 1] },
  { size: 123, writePositions: [123] },
])(
  'download preparation preserves exact bytes for size $size',
  async ({ size, writePositions }) => {
    await withCopyFixture(size, async ({ bytes, store, prepare }) => {
      const copy = await prepare(unguardedContext);
      try {
        expect<readonly number[]>(store.writePositions).toEqual(writePositions);
        expect(copy.byteLength).toBe(bytes.length);
        expect(copy.digest).toBe(createHash('sha256').update(bytes).digest('base64url'));
        const parts: Buffer[] = [];
        for (let at = 0; at < size; at += SOURCE_CHUNK)
          parts.push(copy.read(at, Math.min(SOURCE_CHUNK, size - at)));
        expect(Buffer.concat(parts)).toEqual(bytes);
      } finally {
        expect(copy.retire()).toBe('settled');
      }
    });
  },
);

test('revoking the captured grant after a source chunk settles without writing the batch', async () => {
  await withCopyFixture(MIB, async ({ home, scratchPath, metadataPath, store, prepare }) => {
    const identity = await createIdentity();
    const trust = new IdentityStore(home);
    await trust.addAuthorizedKey(identity.publicKey, 'owned download');
    const epoch = trust.captureAuthorizationEpoch(identity.publicKey);
    if (epoch === null) throw new Error('Owned grant capture failed');
    let yields = 0;
    await expect(
      prepare({
        effect: (operation) =>
          trust.withAuthorizationEpochNonblocking(identity.publicKey, (current) => {
            if (current !== epoch) throw new DownloadPreparationError('unavailable', true);
            return operation();
          }),
        async yield() {
          if (++yields === 1) expect(trust.removeAuthorizedKey(identity.fingerprint)).toBe(true);
        },
      }),
    ).rejects.toMatchObject({ code: 'unavailable', cleanupConfirmed: true });
    expect(yields).toBe(1);
    expect(store.writePositions).toEqual([]);
    expect(store.readAccounts).toBe(0);
    expect(store.inspect()).toMatchObject([{ state: 'settled', charge: 0 }]);
    expect(fs.readdirSync(scratchPath)).toEqual([]);
    expect(fs.readdirSync(metadataPath)).toEqual([]);
  });
});
