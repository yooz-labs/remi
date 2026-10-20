import { expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DirectoryRoot } from '../../src/tunnel/admission';
import { beginJournal, settleJournal } from '../../src/tunnel/journal-settlement';
import { recoveryNative } from '../../src/tunnel/recovery-native';
import { Reservations } from '../../src/tunnel/reservations';

async function fixture() {
  const native = await recoveryNative();
  const home = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'remi reference-')));
  fs.chmodSync(home, 0o700);
  const scratchPath = path.join(home, 'scratch');
  const metadataPath = path.join(home, 'metadata');
  fs.mkdirSync(scratchPath, { mode: 0o700 });
  fs.mkdirSync(metadataPath, { mode: 0o700 });
  const scratch = DirectoryRoot.capture(scratchPath, native.ops.openAt.bind(native.ops));
  const metadata = DirectoryRoot.capture(metadataPath, native.ops.openAt.bind(native.ops));
  if (!scratch || !metadata) throw new Error('Actual reference roots unavailable');
  const store = Reservations.create(path.join(home, 'ledger'));
  const owner = {
    device: randomBytes(32).toString('hex'),
    session: randomUUID(),
    hub: randomBytes(16).toString('hex'),
  };
  return {
    native,
    home,
    scratch,
    metadata,
    scratchPath,
    store,
    stage(bytes: Buffer) {
      const writer = beginJournal(store, owner, bytes.length, scratch, metadata, native.ops);
      writer.write(bytes);
      writer.close();
      const reader = writer.openRead();
      return { writer, reader, named: path.join(scratchPath, `${writer.lease.id}.artifact`) };
    },
    close() {
      scratch.close();
      metadata.close();
      native.close();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

const image = (kind: 'png' | 'jpg') =>
  fs.readFileSync(
    path.resolve(import.meta.dir, `../../../../scripts/tunnel-decoder-proof/fixture.${kind}`),
  );

test('owned staged references reuse exact PNG/JPEG names and retain their quota', async () => {
  const f = await fixture();
  try {
    for (const kind of ['png', 'jpg'] as const) {
      const bytes = image(kind);
      const { writer, reader, named } = f.stage(bytes);
      try {
        expect(() => reader.referencePath()).toThrow('unavailable');
        // The same pre-staged bounded view remains available to the decoder.
        expect(reader.read(0, 1)).toEqual(bytes.subarray(0, 1));
        expect(reader.retainStaged()).toBe('staged');
        const before = f.store.inspect().find((row) => row.id === writer.lease.id);
        const names = fs.readdirSync(f.scratchPath);
        expect(reader.referencePath()).toBe(named);
        expect(fs.readFileSync(reader.referencePath())).toEqual(bytes);
        expect(fs.readdirSync(f.scratchPath)).toEqual(names);
        expect(f.store.inspect().find((row) => row.id === writer.lease.id)).toEqual(before);
        expect(before?.charge).toBeGreaterThanOrEqual(bytes.length);
        expect(before?.state).toBe('staged');
      } finally {
        reader.close();
      }
      expect(() => reader.referencePath()).toThrow('unavailable');
      expect(settleJournal(f.store, writer.lease, f.scratch, f.metadata, f.native.ops)).toBe(
        'settled',
      );
      expect(f.store.inspect().find((row) => row.id === writer.lease.id)?.charge).toBe(0);
    }
  } finally {
    f.close();
  }
});

for (const mode of ['replacement', 'symlink', 'hardlink', 'mutation', 'unlink'] as const) {
  test(`owned reference refuses an actual artifact ${mode}`, async () => {
    const f = await fixture();
    const { reader, named } = f.stage(image('png'));
    try {
      reader.retainStaged();
      expect(reader.referencePath()).toBe(named);
      const moved = `${named}.retained`;
      if (mode === 'replacement' || mode === 'symlink') {
        fs.renameSync(named, moved);
        if (mode === 'replacement') fs.writeFileSync(named, 'replacement', { mode: 0o600 });
        else fs.symlinkSync(moved, named);
      } else if (mode === 'hardlink') fs.linkSync(named, moved);
      else if (mode === 'mutation') fs.writeFileSync(named, 'changed');
      else fs.unlinkSync(named);
      expect(() => reader.referencePath()).toThrow('unavailable');
      expect(f.store.inspect()[0]?.charge).toBeGreaterThan(0);
      if (mode === 'replacement') expect(fs.readFileSync(named, 'utf8')).toBe('replacement');
    } finally {
      reader.close();
      f.close();
    }
  });
}

test('owned reference refuses a replaced configured scratch root', async () => {
  const f = await fixture();
  const { reader } = f.stage(image('png'));
  const moved = path.join(f.home, 'original-scratch');
  try {
    reader.retainStaged();
    fs.renameSync(f.scratchPath, moved);
    fs.mkdirSync(f.scratchPath, { mode: 0o700 });
    expect(() => reader.referencePath()).toThrow('unavailable');
    expect(fs.readdirSync(f.scratchPath)).toEqual([]);
    expect(f.store.inspect()[0]?.charge).toBeGreaterThan(0);
    fs.rmdirSync(f.scratchPath);
    fs.renameSync(moved, f.scratchPath);
    expect(fs.readFileSync(reader.referencePath())).toEqual(image('png'));
  } finally {
    reader.close();
    f.close();
  }
});
