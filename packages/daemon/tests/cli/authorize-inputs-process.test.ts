/** The real authorize/keys CLI processes against disposable homes and real Ed25519 identities. */
import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { boundedEscape, createIdentity } from '@remi/shared';
import { IdentityStore } from '../../src/auth/identity-store.ts';

const CLI = path.resolve(import.meta.dir, '../../src/cli.ts');
const AUTHORIZE = path.resolve(import.meta.dir, '../../src/cli/authorize.ts');
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function isolatedHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-authorize-input-'));
  dirs.push(dir);
  const home = path.join(dir, 'state');
  return {
    dir,
    home,
    env: {
      HOME: dir,
      REMI_HOME: home,
      PATH: '/usr/bin:/bin',
      NODE_ENV: 'test',
    },
  };
}

async function runProcess(
  host: ReturnType<typeof isolatedHome>,
  command: readonly string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn([process.execPath, ...command], {
    env: host.env,
    cwd: host.dir,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

function cli(host: ReturnType<typeof isolatedHome>, args: readonly string[]) {
  return runProcess(host, [CLI, ...args]);
}

function moduleAuthorize(host: ReturnType<typeof isolatedHome>, input: string, label: string) {
  const code = `import { runAuthorize } from ${JSON.stringify(AUTHORIZE)}; await runAuthorize(${JSON.stringify({ input, label })});`;
  return runProcess(host, ['--eval', code]);
}

function expectDefaultHomeUntouched(host: ReturnType<typeof isolatedHome>) {
  expect(fs.existsSync(path.join(host.dir, '.remi'))).toBe(false);
}

test('public-only files and inline JSON authorize exactly their owned keys', async () => {
  const host = isolatedHome();
  const store = new IdentityStore(host.home);
  const inline = await createIdentity();
  const file = await createIdentity();
  const metadata = JSON.stringify({
    publicKey: inline.publicKey,
    fingerprint: 'untrusted-display-metadata',
    label: 'ignored-metadata',
    otherHarmlessField: 'still accepted',
  });
  const keyFile = path.join(host.dir, 'public-key.json');
  fs.writeFileSync(keyFile, JSON.stringify({ publicKey: file.publicKey, label: 'file metadata' }));
  const publicFileBytes = fs.readFileSync(keyFile);

  const inlineLabel = ' Café 📱 "Work" \\ Desk ';
  const importedInline = await cli(host, ['authorize', metadata, '--label', inlineLabel]);
  expect(importedInline.code).toBe(0);
  expect(importedInline.stdout).toContain(inlineLabel);

  const importedFile = await cli(host, ['authorize', keyFile]);
  expect(importedFile.code).toBe(0);

  const maxLabel = '🧠'.repeat(64);
  const maxLabelIdentity = await createIdentity();
  const importedMaxLabel = await cli(host, [
    'authorize',
    JSON.stringify({ publicKey: maxLabelIdentity.publicKey }),
    '--label',
    maxLabel,
  ]);
  expect(importedMaxLabel.code).toBe(0);
  expect(importedMaxLabel.stdout).toContain(maxLabel);

  expect(store.listAuthorizedKeys()).toMatchObject([
    { publicKey: inline.publicKey, fingerprint: inline.fingerprint, label: inlineLabel },
    { publicKey: file.publicKey, fingerprint: file.fingerprint, label: 'unnamed' },
    {
      publicKey: maxLabelIdentity.publicKey,
      fingerprint: maxLabelIdentity.fingerprint,
      label: maxLabel,
    },
  ]);
  expect(store.listPendingKeys()).toEqual([]);
  expect(fs.readFileSync(keyFile)).toEqual(publicFileBytes);
  expectDefaultHomeUntouched(host);
});

test('private identity exports and any private-field presence are refused without store mutation', async () => {
  const host = isolatedHome();
  const identity = await createIdentity();
  const store = new IdentityStore(host.home);
  await store.registerPendingKey(identity.publicKey);
  const pendingBefore = store.listPendingKeys();
  const fullExport = JSON.stringify(identity);
  const privateFile = path.join(host.dir, 'private-identity.json');
  fs.writeFileSync(privateFile, fullExport);
  const privateFileBytes = fs.readFileSync(privateFile);

  for (const input of [privateFile, fullExport]) {
    const result = await cli(host, ['authorize', input, '--label', 'owned device']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Refusing private identity data');
    expect(result.stdout + result.stderr).not.toContain(identity.encryptedPrivateKey);
    expect(result.stdout + result.stderr).not.toContain('"encryptedPrivateKey"');
    expect(store.listAuthorizedKeys()).toEqual([]);
    expect(store.listPendingKeys()).toEqual(pendingBefore);
    expect(fs.readFileSync(privateFile)).toEqual(privateFileBytes);
  }

  const emptyIdentityValues: Record<string, unknown> = {
    encryptedPrivateKey: '',
    salt: '',
    iv: '',
    iterations: 0,
  };
  for (const field of ['encryptedPrivateKey', 'salt', 'iv', 'iterations']) {
    for (const [suffix, value] of [
      ['null', null],
      ['empty', emptyIdentityValues[field]],
    ] as const) {
      const input = JSON.stringify({ publicKey: identity.publicKey, [field]: value });
      const inputFile = path.join(host.dir, `${field}-${suffix}.json`);
      fs.writeFileSync(inputFile, input);
      const inputFileBytes = fs.readFileSync(inputFile);
      for (const candidate of [inputFile, input]) {
        const result = await cli(host, ['authorize', candidate]);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('Refusing private identity data');
        expect(result.stdout + result.stderr).not.toContain(`"${field}"`);
        expect(store.listAuthorizedKeys()).toEqual([]);
        expect(store.listPendingKeys()).toEqual(pendingBefore);
        expect(fs.readFileSync(inputFile)).toEqual(inputFileBytes);
      }
    }
  }
  expectDefaultHomeUntouched(host);
});

test('malformed JSON and non-object JSON fail with fixed errors and no reflected input', async () => {
  const host = isolatedHome();
  const marker = 'MALFORMED_PUBLIC_KEY_SECRET_MARKER';
  const malformedText = `{"publicKey":"${marker}",`;
  const malformedFile = path.join(host.dir, 'malformed.json');
  fs.writeFileSync(malformedFile, malformedText);
  const malformedFileBytes = fs.readFileSync(malformedFile);
  for (const input of [malformedText, malformedFile]) {
    const malformed = await cli(host, ['authorize', input]);
    expect(malformed.code).toBe(1);
    expect(malformed.stderr.trim()).toBe(
      'Invalid public key input: expected a JSON object with a publicKey string.',
    );
    expect(malformed.stdout + malformed.stderr).not.toContain(marker);
    expect(fs.readFileSync(malformedFile)).toEqual(malformedFileBytes);
  }

  for (const input of ['null', '[]']) {
    const result = await cli(host, ['authorize', input]);
    expect(result.code).toBe(1);
    expect(result.stderr.trim()).toBe(
      'Invalid public key input: expected a JSON object with a publicKey string.',
    );
  }
  expect(new IdentityStore(host.home).listAuthorizedKeys()).toEqual([]);
  expectDefaultHomeUntouched(host);
});

test('unsafe labels are refused before pending authorization, including malformed UTF-16', async () => {
  const host = isolatedHome();
  const identity = await createIdentity();
  const store = new IdentityStore(host.home);
  await store.registerPendingKey(identity.publicKey);
  const pendingBefore = store.listPendingKeys();
  const invalidLabels = [
    '',
    '   ',
    '\u0000device',
    '\tdevice',
    'line\nbreak',
    '\u007Fdevice',
    'control\u0085',
    'right\u202Eleft',
    '\u200B',
    'x'.repeat(65),
    '\uD800',
  ];
  for (const label of invalidLabels) {
    const result = await moduleAuthorize(host, identity.fingerprint, label);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Invalid label:');
    expect(store.listAuthorizedKeys()).toEqual([]);
    expect(store.listPendingKeys()).toEqual(pendingBefore);
  }

  const leadingHyphenDirect = await moduleAuthorize(host, identity.fingerprint, '-device');
  expect(leadingHyphenDirect.code).toBe(1);
  expect(leadingHyphenDirect.stderr).toContain('Invalid label:');
  expect(store.listPendingKeys()).toEqual(pendingBefore);

  // The actual CLI argv parser rejects this form before `runAuthorize`; it remains mutation-free.
  const leadingHyphen = await cli(host, ['authorize', identity.fingerprint, '--label', '-device']);
  expect(leadingHyphen.code).toBe(1);
  expect(leadingHyphen.stderr).toContain('Error: --label requires a value.');
  expect(store.listPendingKeys()).toEqual(pendingBefore);

  const second = await createIdentity();
  const rejectedImport = await moduleAuthorize(
    host,
    JSON.stringify({ publicKey: second.publicKey }),
    '\u202E',
  );
  expect(rejectedImport.code).toBe(1);
  expect(rejectedImport.stderr).toContain('Invalid label:');
  expect(store.isAuthorized(second.publicKey, second.fingerprint)).toBe(false);
  expect(store.listPendingKeys()).toEqual(pendingBefore);
  expectDefaultHomeUntouched(host);
});

test('legacy labels are made visible and bounded when listed without rewriting the store', async () => {
  const host = isolatedHome();
  const store = new IdentityStore(host.home);
  const legacy = [
    { identity: await createIdentity(), label: '\tLegacy\nText and more' },
    { identity: await createIdentity(), label: 'abcdefghi\u202ETail' },
    { identity: await createIdentity(), label: `${'z'.repeat(15)}🧠` },
  ];
  for (const item of legacy) await store.addAuthorizedKey(item.identity.publicKey, item.label);
  const grantsPath = path.join(host.home, 'authorized_keys.json');
  const before = fs.readFileSync(grantsPath);

  const result = await cli(host, ['keys']);
  expect(result.code).toBe(0);
  const lines = result.stdout.split('\n');
  for (const item of legacy) {
    const row = lines.find((line) => line.startsWith(item.identity.fingerprint));
    const visible = boundedEscape(
      item.label.replaceAll('\t', '\u2409').replaceAll('\n', '\u240a'),
      16,
    );
    expect(row).toContain(visible);
    expect(visible.length).toBeLessThanOrEqual(16);
  }
  expect(boundedEscape('abcdefghi\u202ETail', 16)).toBe('abcdefghi\\u202E…');
  expect(boundedEscape(`${'z'.repeat(15)}🧠`, 16)).toBe(`${'z'.repeat(15)}…`);
  expect(result.stdout).not.toContain('\u202E');
  expect(result.stdout).not.toContain('\t');
  expect(fs.readFileSync(grantsPath)).toEqual(before);
  expectDefaultHomeUntouched(host);
});
