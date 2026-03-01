import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeStore } from '../../src/remote/code-store.ts';

describe('CodeStore', () => {
  let tmpDir: string;
  let codeFile: string;
  let store: CodeStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-code-store-'));
    codeFile = path.join(tmpDir, 'connection-code');
    store = new CodeStore(codeFile);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('load returns null when file does not exist', () => {
    expect(store.load()).toBeNull();
  });

  test('save and load round-trip', () => {
    store.save('ABCD-2345');
    expect(store.load()).toBe('ABCD-2345');
  });

  test('load returns null for invalid code format', () => {
    fs.writeFileSync(codeFile, 'invalid-code', 'utf-8');
    expect(store.load()).toBeNull();
  });

  test('load returns null for empty file', () => {
    fs.writeFileSync(codeFile, '', 'utf-8');
    expect(store.load()).toBeNull();
  });

  test('load trims whitespace', () => {
    fs.writeFileSync(codeFile, '  WXYZ-6789\n', 'utf-8');
    expect(store.load()).toBe('WXYZ-6789');
  });

  test('load rejects lowercase codes', () => {
    fs.writeFileSync(codeFile, 'abcd-2345', 'utf-8');
    expect(store.load()).toBeNull();
  });

  test('load rejects codes with ambiguous characters', () => {
    // 0, O, 1, I, L are excluded from the unambiguous character set
    fs.writeFileSync(codeFile, 'ABCD-0000', 'utf-8');
    expect(store.load()).toBeNull();

    fs.writeFileSync(codeFile, 'OILZ-2345', 'utf-8');
    expect(store.load()).toBeNull();
  });

  test('refresh generates a valid code and saves it', () => {
    const code = store.refresh();
    expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789]{4}$/);
    expect(store.load()).toBe(code);
  });

  test('refresh generates different codes', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 10; i++) {
      codes.add(store.refresh());
    }
    // With ~33 bits of entropy, 10 codes should all be unique
    expect(codes.size).toBe(10);
  });

  test('save creates parent directory if needed', () => {
    const deepFile = path.join(tmpDir, 'nested', 'dir', 'code');
    const deepStore = new CodeStore(deepFile);
    deepStore.save('MNPQ-5678');
    expect(deepStore.load()).toBe('MNPQ-5678');
  });

  test('load throws on permission errors (non-ENOENT)', () => {
    // Create a file then make it unreadable
    fs.writeFileSync(codeFile, 'ABCD-2345', 'utf-8');
    fs.chmodSync(codeFile, 0o000);
    expect(() => store.load()).toThrow();
    // Restore permissions for cleanup
    fs.chmodSync(codeFile, 0o644);
  });

  test('save sets restrictive file permissions', () => {
    store.save('ABCD-2345');
    const stat = fs.statSync(codeFile);
    // 0o600 = owner read/write only
    expect(stat.mode & 0o777).toBe(0o600);
  });

  test('refresh overwrites existing code', () => {
    store.save('AAAA-2222');
    const newCode = store.refresh();
    expect(newCode).not.toBe('AAAA-2222');
    expect(store.load()).toBe(newCode);
  });
});
