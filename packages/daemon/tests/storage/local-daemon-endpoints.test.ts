/** Real files/processes for routing metadata; metadata is not an admission grant. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type LocalDaemonEndpoint,
  publishLocalDaemonEndpoint,
  readLocalDaemonEndpoint,
  releaseLocalDaemonEndpoint,
} from '../../src/storage/local-daemon-endpoints.ts';

const FAILURE = 'Local daemon endpoint record operation failed';

describe('local daemon endpoint records: real restricted files and process ownership', () => {
  let home: string;
  let endpoint: LocalDaemonEndpoint;
  let file: string;
  const servers: ReturnType<typeof Bun.serve>[] = [];
  const children: ReturnType<typeof Bun.spawn>[] = [];

  beforeEach(() => {
    home = fs.mkdtempSync(join(tmpdir(), 'remi-endpoint-'));
    const held = () => {
      const server = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        fetch: () => new Response('held'),
      });
      servers.push(server);
      return server.port as number;
    };
    endpoint = {
      version: 1,
      publicPort: held(),
      privatePort: held(),
      pid: process.pid,
      instanceId: randomUUID(),
    };
    file = join(home, 'local-endpoints', `${endpoint.publicPort}.json`);
  });

  afterEach(async () => {
    for (const child of children) child.kill();
    await Promise.all(children.splice(0).map((child) => child.exited));
    for (const server of servers.splice(0)) server.stop(true);
    fs.rmSync(home, { recursive: true, force: true });
  });

  async function waitForFile(path: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(path)) {
      if (Date.now() >= deadline) throw new Error('Timed out waiting for record process');
      await Bun.sleep(5);
    }
  }

  function spawnPublisher(instanceId = randomUUID()) {
    const script = join(home, `publisher-${instanceId}.ts`);
    const ready = join(home, `ready-${instanceId}.json`);
    const module = new URL('../../src/storage/local-daemon-endpoints.ts', import.meta.url).href;
    fs.writeFileSync(
      script,
      `
      import { writeFileSync, renameSync } from 'node:fs';
      import { publishLocalDaemonEndpoint } from ${JSON.stringify(module)};
      const record = { ...${JSON.stringify(endpoint)}, pid: process.pid, instanceId: ${JSON.stringify(instanceId)} };
      try {
        publishLocalDaemonEndpoint(record, ${JSON.stringify(home)});
        writeFileSync(${JSON.stringify(`${ready}.tmp`)}, JSON.stringify({ success: true, record }));
        renameSync(${JSON.stringify(`${ready}.tmp`)}, ${JSON.stringify(ready)});
        await Bun.sleep(30000);
      } catch (error) {
        writeFileSync(${JSON.stringify(`${ready}.tmp`)}, JSON.stringify({ success: false, error: error.message }));
        renameSync(${JSON.stringify(`${ready}.tmp`)}, ${JSON.stringify(ready)});
        process.exit(1);
      }
    `,
    );
    const child = Bun.spawn([process.execPath, script], {
      cwd: home,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    children.push(child);
    return { child, ready };
  }

  test('atomic publication is0600 under0700, exact idempotence, expected PID and release', () => {
    expect(readLocalDaemonEndpoint(endpoint.publicPort, { home })).toEqual({ kind: 'absent' });
    publishLocalDaemonEndpoint(endpoint, home);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(join(home, 'local-endpoints')).mode & 0o777).toBe(0o700);
    expect(
      readLocalDaemonEndpoint(endpoint.publicPort, { home, expectedPid: process.pid }),
    ).toEqual({ kind: 'found', endpoint });
    const before = fs.readFileSync(file, 'utf8');
    publishLocalDaemonEndpoint(endpoint, home);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(
      readLocalDaemonEndpoint(endpoint.publicPort, { home, expectedPid: process.pid + 1 }),
    ).toEqual({ kind: 'invalid' });
    releaseLocalDaemonEndpoint(endpoint, home);
    releaseLocalDaemonEndpoint(endpoint, home);
    expect(readLocalDaemonEndpoint(endpoint.publicPort, { home })).toEqual({ kind: 'absent' });
    expect(fs.readdirSync(join(home, 'local-endpoints'))).toEqual([]);
  });

  test('a different live owner is refused and every ownership field protects retirement', async () => {
    publishLocalDaemonEndpoint(endpoint, home);
    const other = { ...endpoint, instanceId: randomUUID() };
    expect(() => publishLocalDaemonEndpoint(other, home)).toThrow(FAILURE);
    for (const changed of [
      other,
      { ...endpoint, pid: process.pid + 1 },
      { ...endpoint, privatePort: endpoint.publicPort },
    ]) {
      releaseLocalDaemonEndpoint(changed, home);
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(endpoint);
    }
    releaseLocalDaemonEndpoint(endpoint, home);
    publishLocalDaemonEndpoint(other, home);
    const script = join(home, 'old-owner-release.ts');
    const module = new URL('../../src/storage/local-daemon-endpoints.ts', import.meta.url).href;
    fs.writeFileSync(
      script,
      `import { releaseLocalDaemonEndpoint } from ${JSON.stringify(module)};
      releaseLocalDaemonEndpoint(${JSON.stringify(endpoint)}, ${JSON.stringify(home)});`,
    );
    const child = Bun.spawn([process.execPath, script], {
      cwd: home,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    children.push(child);
    expect(await child.exited).toBe(0);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(other);
  });

  test('a real child owner becomes stale only after exit and can then be replaced', async () => {
    const { child, ready } = spawnPublisher();
    await waitForFile(ready);
    const result = JSON.parse(fs.readFileSync(ready, 'utf8'));
    expect(result.success).toBe(true);
    expect(readLocalDaemonEndpoint(endpoint.publicPort, { home, expectedPid: child.pid })).toEqual({
      kind: 'found',
      endpoint: result.record,
    });
    expect(() => publishLocalDaemonEndpoint(endpoint, home)).toThrow(FAILURE);
    child.kill();
    await child.exited;
    expect(readLocalDaemonEndpoint(endpoint.publicPort, { home })).toEqual({ kind: 'invalid' });
    publishLocalDaemonEndpoint(endpoint, home);
    expect(readLocalDaemonEndpoint(endpoint.publicPort, { home })).toEqual({
      kind: 'found',
      endpoint,
    });
  });

  test('concurrent real publishers serialize and exactly one live owner wins', async () => {
    const first = spawnPublisher();
    const second = spawnPublisher();
    await Promise.all([waitForFile(first.ready), waitForFile(second.ready)]);
    const results = [first, second].map(({ ready }) => JSON.parse(fs.readFileSync(ready, 'utf8')));
    expect(results.filter((result) => result.success)).toHaveLength(1);
    expect(results.find((result) => !result.success)?.error).toBe(FAILURE);
    const winner = results.find((result) => result.success)?.record;
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(winner);
    expect(fs.readdirSync(join(home, 'local-endpoints'))).toEqual([`${endpoint.publicPort}.json`]);
  }, 10_000);

  test('publication waits for a genuinely held existing interprocess lock', async () => {
    const ready = join(home, 'lock-ready');
    const released = join(home, 'lock-released');
    const script = join(home, 'hold-lock.ts');
    const module = new URL('../../src/storage/interprocess-file-lock.ts', import.meta.url).href;
    fs.writeFileSync(
      script,
      `
      import { writeFileSync } from 'node:fs';
      import { withInterprocessFileLock } from ${JSON.stringify(module)};
      withInterprocessFileLock(${JSON.stringify(file)}, () => {
        writeFileSync(${JSON.stringify(ready)}, 'held');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
        writeFileSync(${JSON.stringify(released)}, 'released');
      });
    `,
    );
    const child = Bun.spawn([process.execPath, script], {
      cwd: home,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    children.push(child);
    await waitForFile(ready);
    expect(fs.existsSync(released)).toBe(false);
    publishLocalDaemonEndpoint(endpoint, home);
    expect(fs.existsSync(released)).toBe(true);
    expect(await child.exited).toBe(0);
    expect(readLocalDaemonEndpoint(endpoint.publicPort, { home })).toEqual({
      kind: 'found',
      endpoint,
    });
  });

  test('format, exact fields, bounds, scalar types and public lookup key are strict', () => {
    publishLocalDaemonEndpoint(endpoint, home);
    const invalid: unknown[] = [
      null,
      [],
      'not a record',
      { ...endpoint, extra: true },
      { ...endpoint, version: 2 },
      { ...endpoint, publicPort: `${endpoint.publicPort}` },
      { ...endpoint, publicPort: 0 },
      { ...endpoint, publicPort: 65536 },
      { ...endpoint, privatePort: 1.5 },
      { ...endpoint, privatePort: -1 },
      { ...endpoint, pid: 0 },
      { ...endpoint, pid: 1.5 },
      { ...endpoint, pid: Number.MAX_SAFE_INTEGER + 1 },
      { ...endpoint, instanceId: 'not-a-uuid' },
      { ...endpoint, instanceId: `A${endpoint.instanceId.slice(1)}` },
      { ...endpoint, publicPort: endpoint.privatePort },
    ];
    for (const value of invalid) {
      fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
      expect(readLocalDaemonEndpoint(endpoint.publicPort, { home })).toEqual({ kind: 'invalid' });
      expect(() => publishLocalDaemonEndpoint(endpoint, home)).toThrow(FAILURE);
      expect(() => releaseLocalDaemonEndpoint(endpoint, home)).toThrow(FAILURE);
    }
    fs.writeFileSync(file, '{ private marker: do not echo this }');
    expect(readLocalDaemonEndpoint(endpoint.publicPort, { home })).toEqual({ kind: 'invalid' });
    expect(() => publishLocalDaemonEndpoint(endpoint, home)).toThrow(FAILURE);
    expect(() => releaseLocalDaemonEndpoint(endpoint, home)).toThrow(FAILURE);
  });

  test('invalid mutation tuples are refused before creating any record', () => {
    for (const invalid of [
      { ...endpoint, publicPort: '../escape' },
      { ...endpoint, instanceId: '' },
      { ...endpoint, version: 0 },
    ]) {
      expect(() => publishLocalDaemonEndpoint(invalid as LocalDaemonEndpoint, home)).toThrow(
        FAILURE,
      );
      expect(() => releaseLocalDaemonEndpoint(invalid as LocalDaemonEndpoint, home)).toThrow(
        FAILURE,
      );
    }
    expect(fs.existsSync(join(home, 'local-endpoints'))).toBe(false);
    expect(readLocalDaemonEndpoint(Number.NaN, { home })).toEqual({ kind: 'invalid' });
    expect(readLocalDaemonEndpoint(endpoint.publicPort, { home, expectedPid: 0 })).toEqual({
      kind: 'invalid',
    });
  });

  test('unreadable, unrestricted, symlink and not-directory states refuse without raw errors', () => {
    publishLocalDaemonEndpoint(endpoint, home);
    for (const mode of [0o000, 0o644]) {
      fs.chmodSync(file, mode);
      expect(readLocalDaemonEndpoint(endpoint.publicPort, { home })).toEqual({ kind: 'invalid' });
      expect(() => publishLocalDaemonEndpoint(endpoint, home)).toThrow(FAILURE);
      expect(() => releaseLocalDaemonEndpoint(endpoint, home)).toThrow(FAILURE);
    }
    fs.chmodSync(file, 0o600);
    const saved = `${file}.saved`;
    fs.renameSync(file, saved);
    fs.symlinkSync(saved, file);
    expect(readLocalDaemonEndpoint(endpoint.publicPort, { home })).toEqual({ kind: 'invalid' });
    expect(() => releaseLocalDaemonEndpoint(endpoint, home)).toThrow(FAILURE);
    fs.rmSync(join(home, 'local-endpoints'), { recursive: true });
    fs.writeFileSync(join(home, 'local-endpoints'), 'not a directory');
    expect(() => publishLocalDaemonEndpoint(endpoint, home)).toThrow(FAILURE);
  });
});
