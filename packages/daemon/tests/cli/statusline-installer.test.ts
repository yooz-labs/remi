import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildStatuslineScript, installStatusLine } from '../../src/cli/statusline-installer.ts';

describe('buildStatuslineScript', () => {
  test('interpolates the remi directory into REMI_STATUS_FILE', () => {
    const script = buildStatuslineScript('/tmp/fake-remi');
    expect(script).toContain('REMI_STATUS_FILE="/tmp/fake-remi/status-$REMI_PORT.json"');
  });

  test('starts with bash shebang', () => {
    expect(buildStatuslineScript('/x')).toStartWith('#!/bin/bash\n');
  });

  test('emits the final echo line for context percentage and model', () => {
    const script = buildStatuslineScript('/x');
    expect(script).toContain('% context');
    expect(script).toContain('used_percentage');
  });

  test('renders "remi:" with no stray space before the port (#560)', () => {
    const script = buildStatuslineScript('/x');
    expect(script).toContain('REMI="remi:$REMI_PORT');
    expect(script).not.toContain('remi :$REMI_PORT');
  });

  test('surfaces auto-approve eval state in the status segment (#560)', () => {
    const script = buildStatuslineScript('/x');
    // reads the auto-approve fields from the per-port status JSON
    expect(script).toContain('.autoApprove.inFlight');
    expect(script).toContain('.autoApprove.lastVerdict');
    // status segment reflects evaluating / needs-you when a permission is decided
    expect(script).toContain('STATE="evaluating');
    expect(script).toContain('STATE="needs you"');
  });
});

describe('installStatusLine', () => {
  let tmpRemi: string;
  let sandbox: string;
  let settingsPath: string;

  beforeEach(() => {
    tmpRemi = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-statusline-'));
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-sandbox-'));
    settingsPath = path.join(sandbox, '.claude', 'settings.json');
  });

  afterEach(() => {
    fs.rmSync(tmpRemi, { recursive: true, force: true });
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  test('writes statusline.sh into the target directory with exec mode', () => {
    installStatusLine(tmpRemi, settingsPath);
    const scriptPath = path.join(tmpRemi, 'statusline.sh');
    expect(fs.existsSync(scriptPath)).toBe(true);
    const stat = fs.statSync(scriptPath);
    expect((stat.mode & 0o777).toString(8)).toBe('755');
  });

  test('installs statusLine key in the settings file when missing', () => {
    installStatusLine(tmpRemi, settingsPath);
    expect(fs.existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(settings.statusLine).toEqual({
      type: 'command',
      command: path.join(tmpRemi, 'statusline.sh'),
    });
  });

  test('preserves existing statusLine key if already set', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ statusLine: { type: 'command', command: '/custom/path' } }),
    );
    installStatusLine(tmpRemi, settingsPath);
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(settings.statusLine.command).toBe('/custom/path');
  });

  test('does not clobber unrelated settings keys', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ foo: 'bar', env: { X: '1' } }));
    installStatusLine(tmpRemi, settingsPath);
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(settings.foo).toBe('bar');
    expect(settings.env).toEqual({ X: '1' });
    expect(settings.statusLine).toBeDefined();
  });

  test('does not throw when the settings file is corrupted JSON', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, '{not valid json');
    expect(() => installStatusLine(tmpRemi, settingsPath)).not.toThrow();
  });
});
