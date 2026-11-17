import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseRootDomain } from '../../../src/power/readings/root-domain.ts';

const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/mac16-11-macos-27.2/${name}`, import.meta.url), 'utf8');

test('the Mac mini capture has sleep enabled and no lid', () => {
  expect(parseRootDomain(fixture('ioreg-iopmrootdomain.txt'))).toEqual({
    sleepDisabled: 'no',
    clamshell: 'absent',
  });
});

test('SleepDisabled = Yes reads yes', () => {
  expect(parseRootDomain(fixture('ioreg-iopmrootdomain.sleepdisabled-yes.txt'))).toEqual({
    sleepDisabled: 'yes',
    clamshell: 'absent',
  });
});

test('AppleClamshellState Yes is closed and No is open (derived fixtures, not a laptop capture)', () => {
  expect(parseRootDomain(fixture('ioreg-iopmrootdomain.clamshell-closed.txt'))).toEqual({
    sleepDisabled: 'no',
    clamshell: 'closed',
  });
  expect(parseRootDomain(fixture('ioreg-iopmrootdomain.clamshell-open.txt'))).toEqual({
    sleepDisabled: 'no',
    clamshell: 'open',
  });
});

test('two SleepDisabled lines make sleepDisabled unknown and leave the lid reading alone', () => {
  expect(parseRootDomain(fixture('ioreg-iopmrootdomain.two-sleepdisabled-lines.txt'))).toEqual({
    sleepDisabled: 'unknown',
    clamshell: 'absent',
  });
});

test('another SleepDisabled value is unknown', () => {
  expect(parseRootDomain(fixture('ioreg-iopmrootdomain.sleepdisabled-other-value.txt'))).toEqual({
    sleepDisabled: 'unknown',
    clamshell: 'absent',
  });
});

test('two AppleClamshellState lines make the lid unknown', () => {
  expect(parseRootDomain(fixture('ioreg-iopmrootdomain.two-clamshell-lines.txt'))).toEqual({
    sleepDisabled: 'no',
    clamshell: 'unknown',
  });
});

test('an empty read is unknown for both fields, never "no lid"', () => {
  expect(parseRootDomain(fixture('ioreg-iopmrootdomain.empty.txt'))).toEqual({
    sleepDisabled: 'unknown',
    clamshell: 'unknown',
  });
});

test('a read cut before the closing brace is unknown for both fields, never "no lid"', () => {
  expect(parseRootDomain(fixture('ioreg-iopmrootdomain.cut-before-closing-brace.txt'))).toEqual({
    sleepDisabled: 'unknown',
    clamshell: 'unknown',
  });
});

test('absent means the key is not listed in a complete read', () => {
  const text = fixture('ioreg-iopmrootdomain.txt');
  expect(text).not.toContain('AppleClamshellState');
  expect(parseRootDomain(text).clamshell).toBe('absent');
});
