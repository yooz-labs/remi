import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { __resetLoggerForTests, configureLogger } from '../../src/cli/logger.ts';
import { currentProfiles } from '../../src/profiles/current-profiles.ts';

test('refreshes changed configuration and hides invalid contents', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'current-profiles-'));
  const file = path.join(root, 'config.toml');
  const logs: string[] = [];
  configureLogger({ writeLog: (line) => logs.push(line) });
  try {
    expect(currentProfiles(file)).toEqual({ entries: {}, notices: [] });
    fs.writeFileSync(
      file,
      '[profiles.work]\nlabel="Work"\n[profiles.work.claude]\nexpects="subscription"\n',
    );
    const first = currentProfiles(file);
    expect('entries' in first && first.entries['work']?.label).toBe('Work');
    expect(currentProfiles(file)).toBe(first);
    fs.appendFileSync(
      file,
      '\n[profiles.home]\nlabel="Home"\n[profiles.home.claude]\nexpects="subscription"\n',
    );
    const second = currentProfiles(file);
    expect(second).not.toBe(first);
    expect('entries' in second && second.entries['home']?.label).toBe('Home');
    fs.writeFileSync(file, '[[PLANTED-PRIVATE-CONTENT');
    expect(currentProfiles(file)).toBe(second);
    expect(JSON.stringify(currentProfiles(file))).not.toContain('PLANTED-PRIVATE-CONTENT');
    expect(logs.join('\n')).not.toContain('PLANTED-PRIVATE-CONTENT');
    expect(logs.join('\n')).not.toContain(root);
    const invalid = path.join(root, 'invalid.toml');
    fs.writeFileSync(invalid, '[[invalid');
    expect(currentProfiles(invalid)).toHaveProperty('error');
    const loop = path.join(root, 'loop');
    fs.symlinkSync(loop, loop);
    const before = logs.length;
    expect(currentProfiles(loop)).toHaveProperty('error');
    expect(currentProfiles(loop)).toHaveProperty('error');
    expect(logs.length).toBe(before + 1);
  } finally {
    __resetLoggerForTests();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
