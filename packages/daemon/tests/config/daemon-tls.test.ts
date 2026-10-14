import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_CONFIG,
  applyEnvOverrides,
  formatConfig,
  generateDefaultConfig,
  loadConfig,
} from '../../src/config/config.ts';
import { loadDaemonTls } from '../../src/config/daemon-tls.ts';
import { directTlsFixture } from '../helpers/direct-tls-fixture.ts';

let fixture: ReturnType<typeof directTlsFixture>;
beforeAll(() => {
  fixture = directTlsFixture();
});
afterAll(() => fixture.cleanup());

test('TLS defaults/null disable; complete table survives merge and config-relative reads', () => {
  expect(DEFAULT_CONFIG.daemon.tls).toBeNull();
  expect(loadDaemonTls(null, fixture.configPath)).toBeUndefined();
  const cfg = loadConfig(fixture.configPath);
  expect(cfg.daemon.tls).toEqual({
    certificate_file: 'certs/server.pem',
    private_key_file: 'certs/server.key',
  });
  const loaded = loadDaemonTls(cfg.daemon.tls, fixture.configPath);
  const hash = (value: string | undefined) =>
    createHash('sha256')
      .update(value ?? '')
      .digest('hex');
  expect(hash(loaded?.key)).toBe(hash(fixture.tls.key));
  expect(hash(loaded?.cert)).toBe(hash(fixture.tls.cert));
  const generated = join(fixture.home, 'generated.toml');
  fs.writeFileSync(generated, generateDefaultConfig());
  expect(loadConfig(generated).daemon.tls).toBeNull();
  expect(formatConfig(cfg, fixture.configPath)).toContain('tls = configured');
});

test('TLS raw table rejects partial, unknown, scalar, array, empty and control-bearing paths', () => {
  const cases = [
    '[daemon]\ntls=false',
    '[daemon]\ntls=[]',
    '[daemon.tls]',
    '[daemon.tls]\ncertificate_file="x"',
    '[daemon.tls]\nprivate_key_file="x"',
    '[daemon.tls]\ncertificate_file="x"\nprivate_key_file="y"\nextra=true',
    '[daemon.tls]\ncertificate_file=""\nprivate_key_file="y"',
    '[daemon.tls]\ncertificate_file="x"\nprivate_key_file="  "',
    '[daemon.tls]\ncertificate_file=3\nprivate_key_file="y"',
    '[daemon.tls]\ncertificate_file="pasted-secret\\u0000"\nprivate_key_file="y"',
  ];
  const path = join(fixture.home, 'invalid.toml');
  for (const text of cases) {
    fs.writeFileSync(path, text);
    expect(() => loadConfig(path)).toThrow();
  }
  for (const path of ['pasted-private-material\0', 'pasted-private-material\n', '\t']) {
    let error = '';
    try {
      loadDaemonTls({ certificate_file: path, private_key_file: 'missing' }, fixture.configPath);
    } catch (value) {
      error = String(value);
    }
    expect(error.includes('TLS_CONFIG_INVALID')).toBe(true);
    expect(error.includes('pasted-private-material')).toBe(false);
  }
  expect(() =>
    applyEnvOverrides({
      ...DEFAULT_CONFIG,
      daemon: { ...DEFAULT_CONFIG.daemon, tls: {} as never },
    }),
  ).toThrow('TLS_CONFIG_INVALID');
});

test('TLS loader and TOML parser diagnostics never echo pasted bodies or expand a tilde', () => {
  fs.mkdirSync(join(fixture.home, '~'));
  fs.copyFileSync(join(fixture.certs, 'server.key'), join(fixture.home, '~', 'owned.key'));
  const literalTilde = loadDaemonTls(
    { certificate_file: 'certs/server.pem', private_key_file: '~/owned.key' },
    fixture.configPath,
  );
  expect(
    createHash('sha256')
      .update(literalTilde?.key ?? '')
      .digest('hex'),
  ).toBe(createHash('sha256').update(fixture.tls.key).digest('hex'));
  let error = '';
  try {
    loadDaemonTls(
      { certificate_file: 'pasted-private-material', private_key_file: '~/missing' },
      fixture.configPath,
    );
  } catch (value) {
    error = String(value);
  }
  expect(error.includes('TLS_FILES_UNAVAILABLE')).toBe(true);
  expect(error.includes('pasted-private-material')).toBe(false);
  const path = join(fixture.home, 'syntax.toml');
  fs.writeFileSync(
    path,
    '[daemon.tls]\ncertificate_file="pasted-private-material\0"\nprivate_key_file="x"',
  );
  try {
    loadConfig(path);
  } catch (value) {
    error = String(value);
  }
  expect(error.includes('pasted-private-material')).toBe(false);
  expect(error.includes('TOML_PARSE_FAILED') || error.includes('TLS_CONFIG_INVALID')).toBe(true);
});
