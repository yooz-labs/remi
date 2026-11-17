import { runReading } from './run-reading.ts';

/** macOS thermal pressure, from `OSThermalNotification.h` (`TARGET_OS_OSX`): 0 to 4. */
export type ThermalLevel = 'nominal' | 'moderate' | 'heavy' | 'trapping' | 'sleeping';

export type ThermalReading =
  | { readonly kind: 'ok'; readonly level: ThermalLevel }
  | { readonly kind: 'unknown'; readonly reason: string };

const LEVELS: readonly ThermalLevel[] = ['nominal', 'moderate', 'heavy', 'trapping', 'sleeping'];

const LINE = /^com\.apple\.system\.thermalpressurelevel ([0-9]+)$/;

/** Accepts exactly one `com.apple.system.thermalpressurelevel N` line with N from 0 to 4. */
export function parseThermal(text: string): ThermalReading {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  if (lines.length !== 1) return { kind: 'unknown', reason: 'not exactly one line' };
  const match = LINE.exec((lines[0] ?? '').trim());
  if (!match) return { kind: 'unknown', reason: 'unrecognized line' };
  const level = LEVELS[Number(match[1])];
  if (!level || !/^[0-4]$/.test(match[1] ?? '')) {
    return { kind: 'unknown', reason: 'level out of range' };
  }
  return { kind: 'ok', level };
}

/**
 * `notifyutil -g com.apple.system.thermalpressurelevel`; reads without root.
 *
 * `nominal` is NOT proof of health: `notifyutil -g` prints 0 for any notification name,
 * including one nobody ever posted (VERIFIED on a made-up name), so a renamed or dead key reads
 * as nominal.
 * `pmset -g therm` cannot cross-check it: on a healthy Mac it prints "No thermal warning level has
 * been recorded", which a dead key shows too, and the text it prints once a warning is recorded
 * is UNVERIFIED here.
 * Callers (the battery and level-2 slices) must treat `nominal` as "no pressure reported", and
 * only a level above nominal as a positive signal.
 */
export async function readThermal(): Promise<ThermalReading> {
  const run = await runReading('/usr/bin/notifyutil', [
    '-g',
    'com.apple.system.thermalpressurelevel',
  ]);
  if (!run.ok) return { kind: 'unknown', reason: `run failed: ${run.reason}` };
  return parseThermal(run.stdout);
}
