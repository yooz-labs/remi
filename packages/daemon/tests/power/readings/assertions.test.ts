import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseAssertions } from '../../../src/power/readings/assertions.ts';

const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/mac16-11-macos-27.2/${name}`, import.meta.url), 'utf8');

test('the Mac mini capture parses to its exact system-wide counts and holders', () => {
  const reading = parseAssertions(fixture('pmset-g-assertions.txt'));
  if (reading.kind !== 'ok') throw new Error(`expected ok, got unknown: ${reading.reason}`);
  expect(reading.systemWide).toEqual({
    BackgroundTask: 0,
    ApplePushServiceTask: 0,
    UserIsActive: 1,
    PreventUserIdleDisplaySleep: 1,
    SoftwareUpdateTask: 0,
    PreventSystemSleep: 1,
    PreventSystemSleepSecurityIndicator: 0,
    ExternalMedia: 1,
    PreventUserIdleSystemSleep: 1,
    NetworkClientActive: 1,
  });
  expect(reading.holders).toHaveLength(12);
  expect(reading.holders[0]).toEqual({
    pid: 377,
    process: 'powerd',
    type: 'PreventUserIdleSystemSleep',
    name: 'Powerd - Prevent sleep while display is on',
    createdForPid: null,
  });
  expect(reading.holders.map((holder) => `${holder.pid}:${holder.process}:${holder.type}`)).toEqual(
    [
      '377:powerd:PreventUserIdleSystemSleep',
      '377:powerd:ExternalMedia',
      '46453:caffeinate:PreventUserIdleDisplaySleep',
      '54016:caffeinate:PreventUserIdleSystemSleep',
      '435:WindowServer:UserIsActive',
      '55885:caffeinate:PreventUserIdleSystemSleep',
      '592:coreaudiod:PreventUserIdleSystemSleep',
      '51357:Sampleapp:NoIdleSleepAssertion',
      '56379:caffeinate:PreventUserIdleSystemSleep',
      '1568:AssetCacheTetheratorService:NetworkClientActive',
      '28759:screensharingd:PreventSystemSleep',
      '28759:screensharingd:UserIsActive',
    ],
  );
});

test('a Created for PID detail line fills createdForPid, and only that holder', () => {
  const reading = parseAssertions(fixture('pmset-g-assertions.txt'));
  if (reading.kind !== 'ok') throw new Error('expected ok');
  const audio = reading.holders.find((holder) => holder.process === 'coreaudiod');
  expect(audio?.createdForPid).toBe(662);
  expect(reading.holders.filter((holder) => holder.createdForPid !== null)).toHaveLength(1);
});

test('a holder name keeps its text, including a trailing quote-free tail and the Electron-style name', () => {
  const reading = parseAssertions(fixture('pmset-g-assertions.txt'));
  if (reading.kind !== 'ok') throw new Error('expected ok');
  const names = reading.holders.map((holder) => holder.name);
  expect(names).toContain('Sample Framework');
  expect(names).toContain('Remote user is connected');
  expect(names.filter((name) => name === 'caffeinate command-line tool')).toHaveLength(4);
});

const NEGATIVES: ReadonlyArray<readonly [string, string]> = [
  ['pmset-g-assertions.truncated-mid-holder.txt', 'output does not end with a newline'],
  ['pmset-g-assertions.no-final-newline.txt', 'output does not end with a newline'],
  [
    'pmset-g-assertions.unrecognized-line-in-owners-block.txt',
    'unrecognized line in the owning-process block at line 15',
  ],
  ['pmset-g-assertions.duplicate-system-wide-type.txt', 'duplicate system-wide type at line 4'],
  ['pmset-g-assertions.detail-before-holder.txt', 'detail line before a holder at line 14'],
  ['pmset-g-assertions.empty.txt', 'output does not end with a newline'],
];

for (const [name, reason] of NEGATIVES) {
  test(`${name} is unknown, with a reason that holds no input text`, () => {
    expect(parseAssertions(fixture(name))).toEqual({ kind: 'unknown', reason });
  });
}

test('an unrecognized line is unknown wherever it sits in the owning-process block', () => {
  const lines = fixture('pmset-g-assertions.txt').split('\n');
  const start = lines.findIndex((line) => line === 'Listed by owning process:');
  const end = lines.findIndex((line) => line.startsWith('Kernel Assertions:'));
  for (let at = start + 1; at < end; at += 1) {
    const copy = [...lines];
    copy.splice(at, 0, '   something new: a-private-document-title');
    const reading = parseAssertions(copy.join('\n'));
    expect(reading.kind).toBe('unknown');
    if (reading.kind === 'unknown') expect(reading.reason).not.toContain('a-private-document');
  }
});

test('a text with no owning-process block, or no system-wide block, is unknown', () => {
  const text = fixture('pmset-g-assertions.txt');
  const noOwners = text.slice(0, text.indexOf('Listed by owning process:'));
  expect(parseAssertions(noOwners)).toEqual({ kind: 'unknown', reason: 'no owning-process block' });
  const noSystem = text.slice(text.indexOf('Listed by owning process:'));
  expect(parseAssertions(noSystem)).toEqual({ kind: 'unknown', reason: 'no system-wide block' });
});

test('the kernel assertions block is skipped by its header, whatever its lines say', () => {
  const text = `${fixture('pmset-g-assertions.txt')}   id=999  level=1 anything at all\n`;
  expect(parseAssertions(text).kind).toBe('ok');
});
