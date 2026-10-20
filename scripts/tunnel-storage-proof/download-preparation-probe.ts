// Real admitted descriptors and managed journals; no network/client authority is claimed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { withInterprocessFileLockNonblocking } from '../../packages/daemon/src/storage/interprocess-file-lock';
import {
  type DownloadCopyContext,
  DownloadPreparationError,
  prepareDownloadCopy,
} from '../../packages/daemon/src/tunnel/download-preparation';
import { openManagedTunnelStorage } from '../../packages/daemon/src/tunnel/managed-tunnel-storage';
import { DirectoryRoot, FileAdmission } from './admission';
import { recoveryNative } from './recovery-native';
import { Reservations } from './reservations';
import { owner } from './settlement-fixture';

export const DOWNLOAD_PREPARATION_CHECKS = [
  'managed download exact bytes digest and source lifetime at three sizes',
  'managed download empty source creates no reservation',
  'managed download source mutation cleans owned partial',
  'managed download owner refusal between source chunks cleans owned partial',
  'managed download owner refusal during verification cleans owned copy',
  'managed download private mutation refuses before exposure',
  'managed download current read guard and idempotent retirement',
  'managed download settlement fault retains debt and closed-read truth',
  'managed download capacity busy is pre-reservation with confirmed source close',
  'managed download held ledger lock busy is pre-reservation and nonblocking',
  'managed download post-reservation failure retains charged cleanup debt',
  'managed storage independent native owners preserve exact shared namespace',
] as const;

export async function downloadPreparationProbe() {
  const temporary = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'remi-download-preparation-')),
  );
  const native = await recoveryNative();
  const checks: string[] = [];
  const measurements: { bytes: number; effects: number; yields: number; elapsedMs: number }[] = [];
  let sequence = 0;
  const fixture = (bytes: Buffer) => {
    const home = path.join(temporary, String(sequence++));
    for (const name of ['project', 'scratch', 'metadata'])
      fs.mkdirSync(path.join(home, name), { recursive: true, mode: 0o700 });
    const filename = path.join(home, 'project', 'data.bin');
    fs.writeFileSync(filename, bytes, { mode: 0o600 });
    const openAt = native.ops.openAt.bind(native.ops);
    const project = DirectoryRoot.capture(path.join(home, 'project'), openAt);
    const scratch = DirectoryRoot.capture(path.join(home, 'scratch'), openAt);
    const metadata = DirectoryRoot.capture(path.join(home, 'metadata'), openAt);
    assert(project && scratch && metadata, 'actual captured download roots');
    const source = new FileAdmission(openAt, []).open(project, ['data.bin']);
    assert(source, 'actual admitted download source');
    const store = Reservations.create(path.join(home, 'ledger'));
    const selectedOwner = owner();
    let allowed = true;
    let afterYield: ((count: number) => void) | undefined;
    const context: DownloadCopyContext & { effects: number; yields: number } = {
      effects: 0,
      yields: 0,
      effect<T>(operation: () => T): T {
        this.effects++;
        if (!allowed) throw new Error('OWNED_EFFECT_REFUSAL');
        return operation();
      },
      async yield() {
        this.yields++;
        await Bun.sleep(0);
        afterYield?.(this.yields);
      },
    };
    return {
      home,
      filename,
      source,
      store,
      selectedOwner,
      context,
      prepare: () =>
        prepareDownloadCopy(source, store, selectedOwner, scratch, metadata, native.ops, context),
      refuse: () => {
        allowed = false;
      },
      onYield: (callback: (count: number) => void) => {
        afterYield = callback;
      },
      empty() {
        assert.deepEqual(
          fs.readdirSync(path.join(home, 'scratch')),
          [],
          'owned private copy removed',
        );
        assert.deepEqual(
          fs.readdirSync(path.join(home, 'metadata')),
          [],
          'owned journal markers removed',
        );
        assert(
          store.inspect().every((record) => record.state === 'settled' && record.charge === 0),
          'only settled zero-charge rows remain',
        );
      },
      close() {
        source.close();
        project.close();
        scratch.close();
        metadata.close();
        fs.rmSync(home, { recursive: true, force: true });
      },
    };
  };
  const unavailable = (error: unknown) =>
    error instanceof DownloadPreparationError &&
    error.code === 'unavailable' &&
    error.cleanupConfirmed;
  try {
    for (const size of [1, 65537, 10 * 1024 * 1024]) {
      const bytes = Buffer.alloc(size, 0x6b);
      const f = fixture(bytes);
      try {
        let previousSize = 0;
        f.onYield(() => {
          const names = fs
            .readdirSync(path.join(f.home, 'scratch'))
            .filter((name) => name.endsWith('.artifact'));
          assert.equal(names.length, 1, 'one managed artifact');
          const name = names[0];
          assert(name);
          const current = fs.statSync(path.join(f.home, 'scratch', name)).size;
          assert(
            current >= previousSize && current - previousSize <= 32768,
            'one bounded copy write per yield',
          );
          previousSize = current;
        });
        const started = performance.now();
        const copy = await f.prepare();
        measurements.push({
          bytes: size,
          effects: f.context.effects,
          yields: f.context.yields,
          elapsedMs: performance.now() - started,
        });
        assert.equal(copy.byteLength, size);
        assert.equal(copy.digest, createHash('sha256').update(bytes).digest('base64url'));
        assert.equal(f.source.isCurrent(), false, 'source consumed and closed before publication');
        assert.equal(
          f.context.yields,
          2 * Math.ceil(size / 32768),
          'source and private validation both yield between chunks',
        );
        const hash = createHash('sha256');
        for (let at = 0; at < size; at += 32768)
          hash.update(copy.read(at, Math.min(32768, size - at)));
        assert.equal(hash.digest('base64url'), copy.digest);
        assert.equal(copy.retire(), 'settled');
        assert.equal(copy.retire(), 'already_settled');
        assert.throws(() => copy.read(0, 1), unavailable);
        f.empty();
        assert.deepEqual(
          fs.readFileSync(f.filename),
          bytes,
          'source bytes unchanged by copy/cleanup',
        );
      } finally {
        f.close();
      }
    }
    checks.push(DOWNLOAD_PREPARATION_CHECKS[0]);
    {
      const f = fixture(Buffer.alloc(0));
      try {
        await assert.rejects(
          f.prepare(),
          (error: unknown) =>
            error instanceof DownloadPreparationError &&
            error.code === 'empty_file' &&
            error.cleanupConfirmed,
        );
        assert.equal(f.store.inspect().length, 0);
        f.empty();
      } finally {
        f.close();
      }
      checks.push(DOWNLOAD_PREPARATION_CHECKS[1]);
    }
    for (const kind of [
      'source',
      'source-late',
      'copy-owner',
      'verify-owner',
      'private-before',
      'private',
      'private-late',
    ] as const) {
      const bytes = Buffer.alloc(65537, 0x31);
      const f = fixture(bytes);
      try {
        let changed = false;
        f.onYield((count) => {
          const at =
            kind === 'private-before'
              ? 3
              : kind === 'private-late'
                ? 6
                : kind === 'verify-owner' || kind === 'private' || kind === 'source-late'
                  ? 4
                  : 1;
          if (count !== at) return;
          changed = true;
          if (kind === 'source' || kind === 'source-late') fs.appendFileSync(f.filename, 'changed');
          else if (kind === 'private' || kind === 'private-before' || kind === 'private-late') {
            const name = fs
              .readdirSync(path.join(f.home, 'scratch'))
              .find((value) => value.endsWith('.artifact'));
            assert(name);
            fs.writeFileSync(path.join(f.home, 'scratch', name), Buffer.alloc(bytes.length, 0x32));
          } else f.refuse();
        });
        await assert.rejects(f.prepare(), unavailable, `${kind} refused before exposure`);
        assert(changed, `${kind} real mutation/owner boundary executed`);
        assert.equal(f.source.isCurrent(), false);
        f.empty();
      } finally {
        f.close();
      }
      // Additional timings of the same source/private mutation groups.
      if (kind === 'source-late' || kind === 'private-before' || kind === 'private-late') continue;
      const check =
        DOWNLOAD_PREPARATION_CHECKS[
          { source: 2, 'copy-owner': 3, 'verify-owner': 4, private: 5 }[kind]
        ];
      assert(check);
      checks.push(check);
    }
    {
      const f = fixture(Buffer.from('owned bytes'));
      try {
        const copy = await f.prepare();
        f.refuse();
        assert.throws(() => copy.read(0, 1), /OWNED_EFFECT_REFUSAL/);
        assert.equal(
          copy.retire(),
          'settled',
          'cleanup needs ownership, not a renewed access grant',
        );
        assert.equal(copy.retire(), 'already_settled');
        f.empty();
        const ledger = path.join(f.home, 'ledger', 'reservations.json');
        const original = fs.readFileSync(ledger);
        try {
          fs.writeFileSync(ledger, '{');
          assert.doesNotThrow(
            () => assert.equal(copy.retire(), 'already_settled'),
            'confirmed retirement stays settled despite unrelated ledger failure',
          );
        } finally {
          fs.writeFileSync(ledger, original);
        }
      } finally {
        f.close();
      }
      checks.push(DOWNLOAD_PREPARATION_CHECKS[6]);
    }
    {
      const f = fixture(Buffer.from('owned debt'));
      try {
        const copy = await f.prepare();
        const ledger = path.join(f.home, 'ledger', 'reservations.json');
        const original = fs.readFileSync(ledger);
        fs.writeFileSync(ledger, '{');
        assert.throws(
          () => copy.retire(),
          (error: unknown) =>
            error instanceof DownloadPreparationError &&
            error.code === 'cleanup_failed' &&
            !error.cleanupConfirmed,
        );
        assert.throws(
          () => copy.read(0, 1),
          (error: unknown) => error instanceof DownloadPreparationError && !error.cleanupConfirmed,
        );
        fs.writeFileSync(ledger, original);
        assert(
          f.store.inspect().some((record) => record.state === 'active' && record.charge > 0),
          'failed settlement never refunds debt',
        );
        assert.equal(
          copy.retire(),
          'settled',
          'confirmed closed reader permits a fresh metadata settlement attempt',
        );
        f.empty();
      } finally {
        f.close();
      }
      checks.push(DOWNLOAD_PREPARATION_CHECKS[7]);
    }
    for (const kind of ['quota', 'held-lock', 'post-debit'] as const) {
      const f = fixture(Buffer.from('actual admission stage bytes'));
      const ledger = path.join(f.home, 'ledger', 'reservations.json');
      if (kind === 'quota') {
        f.store.reserve(f.selectedOwner, 1);
        f.store.reserve(f.selectedOwner, 1);
      }
      const original = fs.readFileSync(ledger);
      try {
        if (kind === 'post-debit') fs.chmodSync(path.join(f.home, 'scratch'), 0o500);
        const started = performance.now();
        const pending =
          kind === 'held-lock'
            ? withInterprocessFileLockNonblocking(ledger, () => f.prepare())
            : f.prepare();
        await assert.rejects(
          pending,
          (error: unknown) =>
            error instanceof DownloadPreparationError &&
            error.code === (kind === 'post-debit' ? 'cleanup_failed' : 'busy') &&
            error.cleanupConfirmed === (kind !== 'post-debit'),
          'pre-reservation busy is distinguished from charged post-reservation failure',
        );
        assert(!f.source.isCurrent(), 'admission refusal closes original source');
        assert.throws(
          () => fs.fstatSync(f.source.fd),
          { code: 'EBADF' },
          'admission refusal closed actual descriptor',
        );
        if (kind === 'post-debit') {
          fs.chmodSync(path.join(f.home, 'scratch'), 0o700);
          assert(!fs.readFileSync(ledger).equals(original), 'post-reservation debit persists');
          assert(
            f.store.inspect().some((row) => row.state === 'active' && row.charge > 0),
            'uncertain begin keeps charged debt',
          );
        } else {
          assert(
            fs.readFileSync(ledger).equals(original),
            'pre-reservation busy never changes ledger',
          );
          assert.deepEqual(
            fs.readdirSync(path.join(f.home, 'scratch')),
            [],
            'pre-reservation busy allocates no artifact',
          );
          assert.deepEqual(
            fs.readdirSync(path.join(f.home, 'metadata')),
            [],
            'pre-reservation busy allocates no journal marker',
          );
          assert(performance.now() - started < 1000, 'pre-reservation busy remains nonblocking');
        }
      } finally {
        fs.chmodSync(path.join(f.home, 'scratch'), 0o700);
        f.close();
      }
      checks.push(
        DOWNLOAD_PREPARATION_CHECKS[kind === 'quota' ? 8 : kind === 'held-lock' ? 9 : 10],
      );
    }
    {
      const home = path.join(temporary, 'shared-owner');
      fs.mkdirSync(home, { mode: 0o700 });
      const first = await openManagedTunnelStorage(home);
      const second = await openManagedTunnelStorage(home);
      try {
        const ledger = fs.lstatSync(path.join(home, 'image-staging', 'ledger'), { bigint: true });
        const expected = createHash('sha256')
          .update(`remi-image-staging:${ledger.dev}:${ledger.ino}`)
          .digest('hex')
          .slice(0, 32);
        assert.equal(first.hub, expected, 'shared managed storage keeps original hub scope');
        assert.equal(second.hub, expected, 'independent managed owner shares exact ledger scope');
        const selected = { ...owner(), hub: first.hub };
        first.store.reserve(selected, 1);
        second.store.reserve(selected, 1);
        assert.throws(
          () => second.store.reserve(selected, 1),
          (error) => error instanceof Error && 'code' in error && error.code === 'busy',
          'shared native owners retain combined device limit',
        );
        second.close();
        second.close();
        assert(
          first.scratch.isCurrent() && first.metadata.isCurrent(),
          'another owner close preserves actual descriptor receivers',
        );
        assert.equal(first.store.inspect().length, 2, 'another owner close preserves ledger reads');
      } finally {
        second.close();
        first.close();
        first.close();
      }
      checks.push(DOWNLOAD_PREPARATION_CHECKS[11]);
    }
    return {
      checks,
      measurements,
      scope:
        'actual descriptor/journal preparation only; no transport/client/grant or held-answer acceptance',
    };
  } finally {
    native.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
