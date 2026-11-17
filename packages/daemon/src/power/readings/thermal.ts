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

/** `notifyutil -g com.apple.system.thermalpressurelevel`; reads without root. */
export async function readThermal(): Promise<ThermalReading> {
  const run = await runReading('/usr/bin/notifyutil', [
    '-g',
    'com.apple.system.thermalpressurelevel',
  ]);
  if (!run.ok) return { kind: 'unknown', reason: `run failed: ${run.reason}` };
  return parseThermal(run.stdout);
}
