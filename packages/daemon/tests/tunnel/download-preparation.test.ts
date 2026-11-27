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
  createDownloadJournalBatch,
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
    super.writeJournal(...args);
    this.writePositions.push(args[1]);
  }

  override captureJournalRead(...args: Parameters<Reservations['captureJournalRead']>): number {
    const bytes = super.captureJournalRead(...args);
    this.readAccounts++;
    return bytes;
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

test('10 MiB download preparation uses exact write and verification transaction counts', async () => {
  await withCopyFixture(10 * MIB, async ({ bytes, store, prepare }) => {
    const copy = await prepare(unguardedContext);
    try {
      const counts = { writes: store.writePositions.length, readAccounts: store.readAccounts };
      // One committed write per MiB.
      expect(counts.writes, JSON.stringify(counts)).toBe(10);
      // Reader open accounts once, then 10 full reads and the final one-byte check account
      // three times each when each readSync fills the requested range.
      expect(counts.readAccounts, JSON.stringify(counts)).toBe(34);
      expect(copy.byteLength).toBe(bytes.length);
      expect(copy.digest).toBe(createHash('sha256').update(bytes).digest('base64url'));
      expect(() => copy.read(0, MIB + 1)).toThrow('recovery unavailable');
    } finally {
      expect(copy.retire()).toBe('settled');
    }
  });
});

test('prepared download reads accept the wire chunk limit and reject one byte more', async () => {
  const limit = SOURCE_CHUNK;
  await withCopyFixture(limit + 1, async ({ bytes, prepare }) => {
    const copy = await prepare(unguardedContext);
    try {
      expect(() => copy.read(0, limit + 1)).toThrow('recovery unavailable');
      expect(copy.read(0, limit)).toEqual(bytes.subarray(0, limit));
    } finally {
      expect(copy.retire()).toBe('settled');
    }
  });
});

test.each([
  { size: MIB - 1, writePositions: [MIB - 1] },
  { size: MIB, writePositions: [MIB] },
  { size: MIB + 1, writePositions: [MIB, MIB + 1] },
  { size: 2 * MIB, writePositions: [MIB, 2 * MIB] },
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

test('a short source read carries a straddling chunk into the next journal batch', async () => {
  const size = MIB + SOURCE_CHUNK;
  await withCopyFixture(size, async ({ bytes, home }) => {
    const output = join(home, 'batched.bin');
    const writePositions: number[] = [];
    const batch = createDownloadJournalBatch(size, (chunk) => {
      fs.appendFileSync(output, chunk, { mode: 0o600 });
      writePositions.push(fs.statSync(output).size);
    });
    const source = fs.openSync(join(home, 'project', 'sample.bin'), 'r');
    try {
      const chunk = Buffer.alloc(SOURCE_CHUNK);
      for (let at = 0; at < size; ) {
        // Supply one fewer byte on the first read so that a later full chunk crosses 1 MiB.
        const length = Math.min(at === 0 ? SOURCE_CHUNK - 1 : SOURCE_CHUNK, size - at);
        expect(fs.readSync(source, chunk, 0, length, at)).toBe(length);
        batch.append(chunk.subarray(0, length));
        at += length;
      }
      batch.flush();
    } finally {
      fs.closeSync(source);
    }
    expect(writePositions).toEqual([MIB, size]);
    expect(fs.readFileSync(output)).toEqual(bytes);
  });
});

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
