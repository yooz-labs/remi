import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { type ThermalLevel, parseThermal } from '../../../src/power/readings/thermal.ts';

const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/mac16-11-macos-27.2/${name}`, import.meta.url), 'utf8');

test('the Mac mini capture is nominal', () => {
  expect(parseThermal(fixture('notifyutil-thermalpressurelevel.txt'))).toEqual({
    kind: 'ok',
    level: 'nominal',
  });
});

test('each value from 0 to 4 maps to its name', () => {
  const names: ThermalLevel[] = ['nominal', 'moderate', 'heavy', 'trapping', 'sleeping'];
  for (const [value, level] of names.entries()) {
    expect(parseThermal(`com.apple.system.thermalpressurelevel ${value}\n`)).toEqual({
      kind: 'ok',
      level,
    });
  }
});

test('a value of 5, a non-numeric value, an empty read and two lines are unknown', () => {
  for (const name of [
    'notifyutil-thermalpressurelevel.value-5.txt',
    'notifyutil-thermalpressurelevel.non-numeric.txt',
    'notifyutil-thermalpressurelevel.empty.txt',
    'notifyutil-thermalpressurelevel.two-lines.txt',
  ]) {
    expect(parseThermal(fixture(name)).kind).toBe('unknown');
  }
});

test('other shapes are unknown: a negative, a wide number, another key, the failure text', () => {
  for (const text of [
    'com.apple.system.thermalpressurelevel -1\n',
    'com.apple.system.thermalpressurelevel 10\n',
    'com.apple.system.thermalpressurelevel 04\n',
    'com.apple.system.thermalpressurelevel: Failed with code 9\n',
    'com.apple.system.other 1\n',
    'com.apple.system.thermalpressurelevel 1 extra\n',
  ]) {
    expect(parseThermal(text).kind).toBe('unknown');
  }
});
