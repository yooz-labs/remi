import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import type { FileDownloadMessage, FileFetchAccepted } from '@remi/shared';
import { withInterprocessFileLockNonblocking } from '../../src/storage/interprocess-file-lock';
import { ImageStagingService } from '../../src/tunnel/image-staging-service';
import { openManagedTunnelStorage } from '../../src/tunnel/managed-tunnel-storage';
import {
  type DownloadFixture,
  type DownloadPeer,
  downloadFixture,
  until,
} from '../helpers/file-download-service-fixture';

const fixtures: DownloadFixture[] = [];
async function fixture(options: Parameters<typeof downloadFixture>[0] = {}) {
  const f = await downloadFixture(options);
  fixtures.push(f);
  return f;
}
afterEach(async () => {
  const errors: unknown[] = [];
  for (const f of fixtures.splice(0)) {
    try {
      await f.close();
      expect(fs.existsSync(f.files.directory)).toBe(false);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, 'Owned download fixtures did not close');
});
function accepted(message: FileDownloadMessage): FileFetchAccepted {
  if (message.type !== 'file_fetch_accepted')
    throw new Error('Expected actual download acceptance');
  return message;
}
function settled(f: DownloadFixture) {
  expect(
    f
      .ledger()
      .inspect()
      .every((row) => row.state === 'settled' && row.charge === 0),
  ).toBe(true);
  for (const name of ['scratch', 'metadata'])
    expect(fs.readdirSync(join(f.files.home, 'image-staging', name))).toEqual([]);
}
async function pull(peer: DownloadPeer, value: FileFetchAccepted) {
  const chunks: Buffer[] = [];
  let received = 0;
  for (let seq = 0; received < value.byteLength; seq++) {
    const request = peer.read(value, seq, received);
    const chunk = await peer.submit(request);
    expect(chunk.type).toBe('file_fetch_chunk');
    if (chunk.type !== 'file_fetch_chunk') throw new Error('Expected actual private chunk');
    expect(chunk.requestId).toBe(request.id);
    expect(chunk.seq).toBe(seq);
    const bytes = Buffer.from(chunk.data, 'base64url');
    expect(bytes.length).toBe(Math.min(32768, value.byteLength - received));
    chunks.push(bytes);
    received += bytes.length;
  }
  return Buffer.concat(chunks);
}
const records = (f: DownloadFixture) => (f.service as unknown as { records: Set<unknown> }).records;

for (const harness of ['claude', 'codex'] as const)
  test(`actual signed TLS ${harness} binding pulls only validated private bytes and confirms settlement`, async () => {
    const f = await fixture({ harness });
    f.write('sample.bin', 'owned inert download');
    const peer = await f.client();
    expect(f.service.isAvailable(peer.id)).toBe(true);
    const value = accepted(await peer.submit(peer.begin()));
    expect(value.fileName).toBe('sample.bin');
    expect(value.mediaType).toBe('application/octet-stream');
    expect(peer.frames.filter((frame) => frame.type === 'file_fetch_chunk')).toEqual([]);
    expect((await pull(peer, value)).toString()).toBe('owned inert download');
    expect(await peer.submit(peer.complete(value))).toMatchObject({
      type: 'file_fetch_result',
      outcome: 'complete',
    });
    settled(f);
  });

test('one-byte, exact32KiB, final short chunk and10MiB/seq319 boundaries use actual files', async () => {
  const f = await fixture();
  const peer = await f.client();
  for (const size of [1, 32768, 32769, 10485760]) {
    const source = Buffer.alloc(size, 0x6d);
    f.write('sample.bin', source);
    const value = accepted(await peer.submit(peer.begin()));
    expect(value.byteLength).toBe(size);
    expect(value.digest).toBe(createHash('sha256').update(source).digest('base64url'));
    expect(await pull(peer, value)).toEqual(source);
    expect(await peer.submit(peer.complete(value))).toMatchObject({ outcome: 'complete' });
    settled(f);
  }
}, 30000);

test('FileAdmission still refuses empty, oversized, denied spelling, symlink and hard-link sources', async () => {
  const f = await fixture();
  const peer = await f.client();
  f.write('sample.bin', 'ordinary');
  f.write('empty.bin', '');
  f.write('large.bin', Buffer.alloc(10485761));
  fs.symlinkSync('sample.bin', join(f.files.work, 'link.bin'));
  fs.linkSync(join(f.files.work, 'sample.bin'), join(f.files.work, 'hard.bin'));
  for (const path of [
    'empty.bin',
    'large.bin',
    '.hidden',
    '../sample.bin',
    'node_modules/data',
    'credentials',
    'backup~',
    'key.pem',
    'link.bin',
    'hard.bin',
  ]) {
    const result = await peer.submit(peer.begin(path));
    expect(result).toMatchObject({
      type: 'file_fetch_refused',
      code: path === 'empty.bin' ? 'empty_file' : 'unavailable',
    });
  }
  settled(f);
});

test('active begin conflict never duplicates the reserved copy; terminal begin reuse makes a fresh copy', async () => {
  const f = await fixture();
  const peer = await f.client();
  f.write('sample.bin', Buffer.alloc(32769, 0x72));
  const begin = peer.begin();
  const work = f.service.handle(peer.id, begin);
  expect(await peer.submit(begin)).toMatchObject({ code: 'conflict' });
  await work;
  await until(
    () => peer.frames.some((frame) => frame.type === 'file_fetch_accepted'),
    'first acceptance',
  );
  const first = accepted(
    peer.frames.find((frame) => frame.type === 'file_fetch_accepted') as FileDownloadMessage,
  );
  expect(
    f
      .ledger()
      .inspect()
      .filter((row) => row.state === 'active'),
  ).toHaveLength(1);
  expect(await peer.submit(peer.cancel(begin.id))).toMatchObject({ outcome: 'cancelled' });
  settled(f);
  f.write('sample.bin', 'fresh');
  const before = peer.frames.length;
  await f.service.handle(peer.id, { ...begin, timestamp: new Date().toISOString() });
  await until(
    () => peer.frames.slice(before).some((frame) => frame.type === 'file_fetch_accepted'),
    'fresh same-id acceptance',
  );
  const second = accepted(
    peer.frames
      .slice(before)
      .find((frame) => frame.type === 'file_fetch_accepted') as FileDownloadMessage,
  );
  expect(second.transferId).not.toBe(first.transferId);
  expect(await peer.submit(peer.read(first))).toMatchObject({ code: 'unavailable' });
  expect((await pull(peer, second)).toString()).toBe('fresh');
  await peer.submit(peer.complete(second));
  settled(f);
});

test('duplicate, skipped and wrong cumulative reads terminate without chunk replay', async () => {
  const f = await fixture();
  const peer = await f.client();
  f.write('sample.bin', Buffer.alloc(32769, 0x73));
  for (const mode of ['skip', 'count', 'duplicate']) {
    const value = accepted(await peer.submit(peer.begin()));
    if (mode === 'duplicate') await peer.submit(peer.read(value));
    const request =
      mode === 'count'
        ? peer.read(value, 0, 1)
        : mode === 'skip'
          ? peer.read(value, 1, 0)
          : peer.read(value);
    expect(await peer.submit(request)).toMatchObject({ code: 'sequence' });
    expect(await peer.submit(peer.read(value))).toMatchObject({ code: 'unavailable' });
    settled(f);
  }
});

test('early complete and incorrect length/digest retire with integrity and never report complete', async () => {
  const f = await fixture();
  const peer = await f.client();
  f.write('sample.bin', 'complete only exact verified bytes');
  for (const mode of ['early', 'length', 'digest']) {
    const value = accepted(await peer.submit(peer.begin()));
    if (mode !== 'early') await pull(peer, value);
    const request = {
      ...peer.complete(value),
      ...(mode === 'length' && { receivedBytes: value.byteLength - 1 }),
      ...(mode === 'digest' && { digest: Buffer.alloc(32).toString('base64url') }),
    };
    expect(await peer.submit(request)).toMatchObject({ code: 'integrity' });
    settled(f);
  }
  expect(peer.frames.some((frame) => frame.type === 'file_fetch_result')).toBe(false);
});

test('cancel at the real first preparation yield suppresses acceptance and confirms owned settlement', async () => {
  const f = await fixture();
  const peer = await f.client();
  f.write('sample.bin', Buffer.alloc(10485760));
  const begin = peer.begin();
  const work = f.service.handle(peer.id, begin);
  expect(records(f).size).toBe(1);
  const row = f
    .ledger()
    .inspect()
    .find((row) => row.state === 'active' && row.charge > 0);
  if (!row) throw new Error('Owned cancelled journal missing');
  const artifact = join(f.files.home, 'image-staging', 'scratch', `${row.id}.artifact`);
  const initial = fs.statSync(artifact).size;
  let maximum = initial;
  let done = false;
  void work.then(() => {
    done = true;
  });
  const cancelled = peer.submit(peer.cancel(begin.id));
  while (!done) {
    if (fs.existsSync(artifact)) maximum = Math.max(maximum, fs.statSync(artifact).size);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(maximum).toBe(initial);
  expect(await cancelled).toMatchObject({ outcome: 'cancelled' });
  await work;
  expect(
    peer.frames.some(
      (frame) => frame.type === 'file_fetch_accepted' || frame.type === 'file_fetch_chunk',
    ),
  ).toBe(false);
  expect(await peer.submit(peer.cancel(begin.id))).toMatchObject({ code: 'unavailable' });
  settled(f);
});

test('cancel after a real private read but before actual send queues zero content', async () => {
  const f = await fixture();
  const peer = await f.client();
  f.write('sample.bin', 'cancel private bytes');
  const begin = peer.begin();
  const value = accepted(await peer.submit(begin));
  const read = f.service.handle(peer.id, peer.read(value));
  expect(await peer.submit(peer.cancel(begin.id))).toMatchObject({ outcome: 'cancelled' });
  await read;
  expect(peer.frames.some((frame) => frame.type === 'file_fetch_chunk')).toBe(false);
  settled(f);
});

test('cancel while the actual managed descriptor is open for private verification suppresses publication', async () => {
  const f = await fixture();
  const peer = await f.client();
  f.write('sample.bin', Buffer.alloc(10485760, 0x76));
  const begin = peer.begin();
  const work = f.service.handle(peer.id, begin);
  const row = f
    .ledger()
    .inspect()
    .find((row) => row.state === 'active');
  if (!row) throw new Error('Owned verifying journal missing');
  const artifact = join(f.files.home, 'image-staging', 'scratch', `${row.id}.artifact`);
  await until(
    () => fs.statSync(artifact).size === 10485760,
    'actual complete private artifact',
    15000,
  );
  function privateReadDescriptor() {
    if (process.platform === 'linux') {
      for (const fd of fs.readdirSync('/proc/self/fd')) {
        try {
          if (fs.readlinkSync(`/proc/self/fd/${fd}`) !== artifact) continue;
          const flags = fs
            .readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8')
            .match(/^flags:\s+([0-7]+)/m)?.[1];
          if (flags && (Number.parseInt(flags, 8) & 3) === 0) return true;
        } catch {
          /* A closed descriptor is not a verification witness. */
        }
      }
      return false;
    }
    const output = execFileSync('/usr/sbin/lsof', ['-a', '-p', String(process.pid), '-Ffan'], {
      encoding: 'utf8',
    });
    let mode = '';
    for (const line of output.split('\n')) {
      if (line.startsWith('f')) mode = '';
      if (line.startsWith('a')) mode = line.slice(1);
      if (line === `n${artifact}` && mode === 'r') return true;
    }
    return false;
  }
  await until(privateReadDescriptor, 'actual read-only private verification descriptor', 5000);
  expect(peer.frames.some((frame) => frame.type === 'file_fetch_accepted')).toBe(false);
  expect(await peer.submit(peer.cancel(begin.id))).toMatchObject({ outcome: 'cancelled' });
  await work;
  expect(
    peer.frames.some(
      (frame) => frame.type === 'file_fetch_accepted' || frame.type === 'file_fetch_chunk',
    ),
  ).toBe(false);
  settled(f);
}, 20000);

test('original grant revoke/regrant between private read and actual send never sends old content', async () => {
  const f = await fixture();
  const peer = await f.client();
  f.write('sample.bin', 'old grant bytes');
  const value = accepted(await peer.submit(peer.begin()));
  const pending = f.service.handle(peer.id, peer.read(value));
  await f.base.trust.removeAuthorizedKey(peer.identity.fingerprint);
  await f.base.trust.addAuthorizedKey(peer.identity.publicKeyRaw, 'owned replacement grant');
  await pending;
  await Bun.sleep(10);
  expect(peer.frames.some((frame) => frame.type === 'file_fetch_chunk')).toBe(false);
  settled(f);
});

test('actual attachment replacement between private read/send is permanent despite reattach', async () => {
  const f = await fixture();
  const peer = await f.client();
  f.write('sample.bin', 'attachment bytes');
  const value = accepted(await peer.submit(peer.begin()));
  const work = f.service.handle(peer.id, peer.read(value));
  f.base.registry.detachConnection(peer.id);
  f.base.registry.attachConnection(f.sessionId(), peer.id);
  await work;
  expect(peer.frames.some((frame) => frame.type === 'file_fetch_chunk')).toBe(false);
  expect(await peer.submit(peer.read(value))).toMatchObject({ code: 'unavailable' });
  settled(f);
});

test('trusted runtime/protection incarnation change is checked at actual send and never revives', async () => {
  const f = await fixture();
  const peer = await f.client();
  f.write('sample.bin', 'runtime bytes');
  const value = accepted(await peer.submit(peer.begin()));
  const old = f.context();
  const work = f.service.handle(peer.id, peer.read(value));
  f.setContext({ runtime: {}, protectedRootPaths: [f.protectedPath] });
  await work;
  f.setContext(old);
  expect(peer.frames.some((frame) => frame.type === 'file_fetch_chunk')).toBe(false);
  expect(await peer.submit(peer.read(value))).toMatchObject({ code: 'unavailable' });
  settled(f);
});

test('missing protected configuration refuses; actual protected-directory replacement retires the copy', async () => {
  const f = await fixture();
  const peer = await f.client();
  f.write('sample.bin', 'protected context');
  const old = f.context();
  for (const context of [
    null,
    { runtime: {}, protectedRootPaths: [] },
    { runtime: {}, protectedRootPaths: [join(f.files.directory, 'absent')] },
  ]) {
    f.setContext(context);
    expect(f.service.isAvailable(peer.id)).toBe(false);
    expect(await peer.submit(peer.begin())).toMatchObject({ code: 'unavailable' });
  }
  f.setContext(old);
  const value = accepted(await peer.submit(peer.begin()));
  const moved = `${f.protectedPath}-old`;
  fs.renameSync(f.protectedPath, moved);
  fs.mkdirSync(f.protectedPath, { mode: 0o700 });
  expect(await peer.submit(peer.read(value))).toMatchObject({ code: 'binding_changed' });
  settled(f);
});

test('actual plaintext/private capability and cross-connection owners cannot consume the copy', async () => {
  const f = await fixture();
  const peer = await f.client();
  const other = await f.client();
  const privatePeer = await f.client({ private: true, capability: true });
  f.write('sample.bin', 'one owner only');
  const value = accepted(await peer.submit(peer.begin()));
  expect(await other.submit(other.read(value))).toMatchObject({ code: 'unavailable' });
  expect(f.service.isAvailable(privatePeer.id)).toBe(false);
  await f.service.handle(privatePeer.id, privatePeer.begin());
  expect(privatePeer.frames).toEqual([]);
  expect((await pull(peer, value)).toString()).toBe('one owner only');
  await peer.submit(peer.complete(value));
  const plain = await fixture({ tls: false });
  const unencrypted = await plain.client();
  plain.write('sample.bin', 'plain refused');
  expect(plain.service.isAvailable(unencrypted.id)).toBe(false);
  await plain.service.handle(unencrypted.id, unencrypted.begin());
  expect(plain.ledger().inspect()).toEqual([]);
});

test('128 pending records are bounded before yield with no129th record or async backlog', async () => {
  const f = await fixture();
  const peer = await f.client();
  f.write('sample.bin', 'bounded pending');
  const begins = Array.from({ length: 128 }, () => peer.begin());
  const work = begins.map((begin) => f.service.handle(peer.id, begin));
  expect(records(f).size).toBe(128);
  const extra = f.service.handle(peer.id, peer.begin());
  expect(records(f).size).toBe(128);
  await Promise.all([...work, extra]);
  await until(
    () => peer.frames.filter((frame) => frame.type === 'file_fetch_accepted').length === 2,
    'actual bounded acceptances',
  );
  for (const begin of begins) {
    if (
      peer.frames.some(
        (frame) => frame.type === 'file_fetch_accepted' && frame.requestId === begin.id,
      )
    )
      await peer.submit(peer.cancel(begin.id));
  }
  expect(records(f).size).toBe(0);
  settled(f);
}, 20000);

test('download and actual image adopter use the same signed-key quota owner and physical ledger', async () => {
  const f = await fixture();
  const peer = await f.client();
  f.write('sample.bin', 'shared owner');
  const first = peer.begin();
  const second = peer.begin();
  await peer.submit(first);
  await peer.submit(second);
  const image = await ImageStagingService.open({
    home: f.files.home,
    identityStore: f.base.trust,
    sessionRegistry: f.base.registry,
    bindingStore: f.bindings,
    directAdapter: () => f.base.adapter,
  });
  try {
    const responses: unknown[] = [];
    await image.handle(
      peer.id,
      {
        type: 'image_upload_begin',
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        sessionId: f.sessionId(),
        binding: { harness: 'claude', harnessSessionId: f.binding().harnessSessionId },
        mediaType: 'image/png',
        byteLength: 1,
        digest: Buffer.alloc(32).toString('base64url'),
      },
      (message) => responses.push(message),
    );
    expect(responses).toEqual([
      expect.objectContaining({ type: 'image_upload_refused', code: 'busy' }),
    ]);
    expect(
      f
        .ledger()
        .inspect()
        .filter((row) => row.state === 'active'),
    ).toHaveLength(2);
    await peer.submit(peer.cancel(first.id));
    await peer.submit(peer.cancel(second.id));
    settled(f);
  } finally {
    expect(await image.close()).toBe(true);
  }
});

function ledgerLockChild(f: DownloadFixture, earlyExit = false) {
  const ready = join(f.files.directory, 'lock-ready');
  const release = join(f.files.directory, 'lock-release');
  const script = join(f.files.directory, 'lock-child.ts');
  const ledger = join(f.files.home, 'image-staging', 'ledger', 'reservations.json');
  fs.writeFileSync(
    script,
    `import * as fs from 'node:fs';import {withInterprocessFileLockNonblocking} from ${JSON.stringify(resolve(import.meta.dir, '../../src/storage/interprocess-file-lock.ts'))};${earlyExit ? 'process.exit(7);' : ''}withInterprocessFileLockNonblocking(${JSON.stringify(ledger)},()=>{fs.writeFileSync(${JSON.stringify(ready)},'ready');const end=Date.now()+10000;while(!fs.existsSync(${JSON.stringify(release)})&&Date.now()<end)Bun.sleepSync(5);});`,
  );
  const child = Bun.spawn([process.execPath, '--no-env-file', script], {
    cwd: f.files.directory,
    env: f.files.env,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'pipe',
  });
  let reaped = false;
  const exited = child.exited.then((status) => {
    reaped = true;
    return status;
  });
  const stderr = (async () => {
    const reader = child.stderr.getReader();
    const chunks: Uint8Array[] = [];
    let remaining = 4096;
    try {
      while (remaining > 0) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = next.value.subarray(0, remaining);
        chunks.push(chunk);
        remaining -= chunk.length;
      }
    } finally {
      await reader.cancel();
    }
    return Buffer.concat(chunks).toString();
  })();
  const deadline = performance.now() + 3000; // One existing three-second child bound, including reap.
  return {
    async ready() {
      await until(
        () => fs.existsSync(ready) || reaped,
        'actual ledger lock or child exit',
        Math.max(1, deadline - performance.now()),
      );
      if (!fs.existsSync(ready))
        throw new Error(`Owned lock child exited before ready: ${await exited}; ${await stderr}`);
    },
    async close() {
      const errors: unknown[] = [];
      try {
        fs.writeFileSync(release, 'release');
        await until(
          () => reaped,
          'actual owned lock child reaped',
          Math.max(1, deadline - performance.now()),
        );
      } catch (error) {
        errors.push(error);
      } finally {
        try {
          if (!reaped) process.kill(child.pid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') errors.push(error);
        } finally {
          await exited;
        }
      }
      expect(() => process.kill(child.pid, 0)).toThrow();
      if (errors.length)
        throw new AggregateError(errors, `Owned lock child cleanup failed: ${await stderr}`);
      return { status: await exited, reaped, stderr: await stderr };
    },
  };
}

test('actual held ledger lock refuses cancel success, retains debt, then safe retirement retry settles', async () => {
  const f = await fixture();
  const peer = await f.client();
  f.write('sample.bin', 'settlement owner');
  const begin = peer.begin();
  await peer.submit(begin);
  const ledger = join(f.files.home, 'image-staging', 'ledger', 'reservations.json');
  const child = ledgerLockChild(f);
  try {
    await child.ready();
    expect(await peer.submit(peer.cancel(begin.id))).toMatchObject({ code: 'cleanup_failed' });
    const rows = JSON.parse(fs.readFileSync(ledger, 'utf8')) as { records: { charge: number }[] };
    expect(rows.records.some((row) => row.charge > 0)).toBe(true);
    expect(records(f).size).toBe(1);
  } finally {
    expect((await child.close()).status).toBe(0);
  }
  await f.service.maintain();
  expect(records(f).size).toBe(0);
  settled(f);
});

test('owned ledger child exit before readiness fails promptly and is actually reaped', async () => {
  const f = await fixture();
  const child = ledgerLockChild(f, true);
  try {
    await expect(child.ready()).rejects.toThrow('Owned lock child exited before ready: 7');
  } finally {
    expect(await child.close()).toMatchObject({ status: 7, reaped: true, stderr: '' });
  }
});

test('original grant lock contention is bounded, retires owned work and never borrows a later grant', async () => {
  const f = await fixture();
  const peer = await f.client();
  f.write('sample.bin', 'nonblocking original owner');
  const value = accepted(await peer.submit(peer.begin()));
  const started = performance.now();
  const work = withInterprocessFileLockNonblocking(
    join(f.files.home, 'auth', 'authorized_keys.json'),
    () => f.service.handle(peer.id, peer.read(value)),
  );
  await work;
  expect(performance.now() - started).toBeLessThan(1000);
  expect(peer.frames.some((frame) => frame.type === 'file_fetch_chunk')).toBe(false);
  expect(await peer.submit(peer.read(value))).toMatchObject({ code: 'unavailable' });
  settled(f);
});

test('actual uncertain preparation poisons admission and keeps debt until owned process death/recovery', async () => {
  const directory = fs.mkdtempSync(join(process.env['TMPDIR'] ?? '/tmp', 'remi-download-fault-'));
  const receipt = join(directory, 'receipt.json');
  const script = resolve(
    import.meta.dir,
    '../../../../scripts/tunnel-download-proof/clock-acceptance.ts',
  );
  const child = Bun.spawn([process.execPath, '--no-env-file', script, '--cleanup-fault', receipt], {
    cwd: directory,
    env: {
      HOME: directory,
      TMPDIR: process.env['TMPDIR'] ?? '/tmp',
      PATH: '/opt/homebrew/bin:/usr/bin:/bin',
      NODE_ENV: 'test',
    },
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const stderr = new Response(child.stderr).text();
  let ownedDirectory: string | undefined;
  try {
    await until(() => child.exitCode !== null, 'actual fault child exited', 15000);
    expect(await child.exited, await stderr).toBe(0);
    expect(() => process.kill(child.pid, 0)).toThrow();
    const saved = JSON.parse(fs.readFileSync(receipt, 'utf8')) as {
      home: string;
      directory: string;
      charged: boolean;
      close: boolean;
    };
    ownedDirectory = saved.directory;
    expect(saved).toMatchObject({
      charged: true,
      close: false,
      safelyDrained: true,
      launcherRemoved: true,
    });
    const storage = await openManagedTunnelStorage(saved.home);
    try {
      expect(storage.store.inspect().some((row) => row.charge > 0)).toBe(true);
      storage.recover();
      expect(
        storage.store.inspect().every((row) => row.state === 'settled' && row.charge === 0),
      ).toBe(true);
      expect(fs.readdirSync(join(saved.home, 'image-staging', 'scratch'))).toEqual([]);
    } finally {
      storage.close();
    }
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await child.exited;
    if (!ownedDirectory && fs.existsSync(receipt))
      ownedDirectory = (JSON.parse(fs.readFileSync(receipt, 'utf8')) as { directory: string })
        .directory;
    if (ownedDirectory) fs.rmSync(ownedDirectory, { recursive: true, force: true });
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 20000);

test('disconnect and joined close retire all indexed and preparing work without source reopening', async () => {
  const f = await fixture();
  const peer = await f.client();
  f.write('sample.bin', Buffer.alloc(10485760));
  const work = f.service.handle(peer.id, peer.begin());
  const closing = f.service.invalidateConnection(peer.id);
  peer.ws.close();
  await Promise.all([work, closing]);
  expect(records(f).size).toBe(0);
  settled(f);
  expect(await f.service.close()).toBe(true);
  expect(await f.service.close()).toBe(true);
});

test('dedicated outbound validates original exact host fields and refuses the actual closed connection', async () => {
  const f = await fixture();
  const peer = await f.client();
  f.write('sample.bin', 'strict outbound');
  const value = accepted(await peer.submit(peer.begin()));
  const connection = peer.connection();
  if (!connection) throw new Error('Owned actual Connection missing');
  const before = peer.received.length;
  expect(connection.sendFileDownloadFrame({ ...value, extra: true } as FileFetchAccepted)).toBe(
    false,
  );
  expect(connection.sendFileDownloadFrame({ ...value, byteLength: 0 })).toBe(false);
  await Bun.sleep(10);
  expect(peer.received.length).toBe(before);
  await peer.submit(peer.cancel(value.requestId));
  peer.ws.close();
  await until(() => !connection.isConnected, 'actual outbound connection closed');
  expect(connection.sendFileDownloadFrame(value)).toBe(false);
  settled(f);
});

test('joined close waits for the actual in-flight private read continuation', async () => {
  for (const earlyComplete of [false, true]) {
    const f = await fixture();
    const peer = await f.client();
    f.write('sample.bin', 'joined private read');
    const value = accepted(await peer.submit(peer.begin()));
    let finished = false;
    const work = f.service.handle(peer.id, peer.read(value)).then(() => {
      finished = true;
    });
    if (earlyComplete) await f.service.handle(peer.id, peer.complete(value));
    expect(await f.service.close()).toBe(true);
    expect(finished).toBe(true);
    await work;
    expect(peer.frames.some((frame) => frame.type === 'file_fetch_chunk')).toBe(false);
    settled(f);
  }
});

test('overlapping reads terminate sequence while joining the original read without a queue', async () => {
  const f = await fixture();
  const peer = await f.client();
  f.write('sample.bin', 'overlapping private read');
  const value = accepted(await peer.submit(peer.begin()));
  const original = f.service.handle(peer.id, peer.read(value));
  expect(await peer.submit(peer.read(value))).toMatchObject({ code: 'sequence' });
  await original;
  expect(peer.frames.some((frame) => frame.type === 'file_fetch_chunk')).toBe(false);
  expect(records(f).size).toBe(0);
  settled(f);
});
