import { runReading } from './run-reading.ts';

/** One line of "Listed by owning process" in `pmset -g assertions`. */
export interface AssertionHolder {
  readonly pid: number;
  readonly process: string;
  /** The assertion type, for example `PreventUserIdleSystemSleep`. */
  readonly type: string;
  /** Self-chosen by the holder; never copy it into a log or a reason. */
  readonly name: string;
  /** From a `Created for PID: N.` detail line, else null. */
  readonly createdForPid: number | null;
}

export type AssertionsReading =
  | {
      readonly kind: 'ok';
      /** Each type of "Assertion status system-wide" with its count. */
      readonly systemWide: Readonly<Record<string, number>>;
      readonly holders: readonly AssertionHolder[];
    }
  | { readonly kind: 'unknown'; readonly reason: string };

const TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4}\s*$/;
const SYSTEM_HEADER = /^Assertion status system-wide:\s*$/;
const OWNERS_HEADER = /^Listed by owning process:\s*$/;
// Blocks this parser skips by their header, whatever they list.
const SKIPPED_HEADER = /^(Kernel Assertions|Idle sleep preventers):/;
const SYSTEM_LINE = /^\s+([A-Za-z]+)\s+(\d+)$/;
const HOLDER_LINE =
  /^\s+pid (\d+)\((.*)\): \[0x[0-9a-f]+\] \d+:\d{2}:\d{2} ([A-Za-z]+) named: "(.*)"\s*$/;
const CREATED_FOR = /^\s+Created for PID: (\d+)\.\s*$/;
const DETAIL_LINES: readonly RegExp[] = [
  /^\s+Details: .*$/,
  /^\s+Localized=.*$/,
  /^\s+Timeout will fire in \d+ secs Action=[A-Za-z]+\s*$/,
  /^\s+Resources: .*$/,
];

const unknown = (reason: string): AssertionsReading => ({ kind: 'unknown', reason });

type Block = 'none' | 'system' | 'owners' | 'skipped';

/**
 * Parses `pmset -g assertions`.
 * The grammar comes from a captured fixture (`tests/power/fixtures/`); anything that does not
 * match it is unknown, never skipped (ADR 0050: refuse level 2 on any parse failure).
 * The `Kernel Assertions:` header is the last block of the captured output, and a read without it
 * is unknown, so a cut at a line boundary inside the owning-process block is caught too.
 * That makes a Mac that never prints the header read unknown (a refusal), never a false ok.
 * A reason names the kind of failure and the line number, never the line's text, because
 * assertion names can carry application or document names.
 */
export function parseAssertions(text: string): AssertionsReading {
  // A truncated read has no final newline.
  if (!text.endsWith('\n')) return unknown('output does not end with a newline');

  const lines = text.split('\n');
  lines.pop();
  const systemWide: Record<string, number> = {};
  const holders: AssertionHolder[] = [];
  let current: { -readonly [K in keyof AssertionHolder]: AssertionHolder[K] } | null = null;
  let block: Block = 'none';
  let sawSystem = false;
  let sawOwners = false;
  let sawKernel = false;
  let sawContent = false;

  for (const [index, line] of lines.entries()) {
    const at = index + 1;
    if (line.trim() === '') continue;
    if (!sawContent) {
      sawContent = true;
      if (TIMESTAMP.test(line)) continue;
    }
    if (!/^\s/.test(line)) {
      if (SYSTEM_HEADER.test(line)) {
        if (sawSystem) return unknown(`duplicate system-wide header at line ${at}`);
        sawSystem = true;
        block = 'system';
      } else if (OWNERS_HEADER.test(line)) {
        if (sawOwners) return unknown(`duplicate owning-process header at line ${at}`);
        sawOwners = true;
        block = 'owners';
      } else if (SKIPPED_HEADER.test(line)) {
        if (line.startsWith('Kernel Assertions:')) sawKernel = true;
        block = 'skipped';
      } else {
        return unknown(`unrecognized header at line ${at}`);
      }
      current = null;
      continue;
    }

    if (block === 'skipped') continue;
    if (block === 'system') {
      const match = SYSTEM_LINE.exec(line);
      if (!match?.[1] || !match[2]) return unknown(`unrecognized system-wide line ${at}`);
      if (match[1] in systemWide) return unknown(`duplicate system-wide type at line ${at}`);
      systemWide[match[1]] = Number(match[2]);
      continue;
    }
    if (block !== 'owners') return unknown(`indented line before a header at line ${at}`);

    const holder = HOLDER_LINE.exec(line);
    if (holder) {
      current = {
        pid: Number(holder[1]),
        process: holder[2] ?? '',
        type: holder[3] ?? '',
        name: holder[4] ?? '',
        createdForPid: null,
      };
      holders.push(current);
      continue;
    }
    if (!current) return unknown(`detail line before a holder at line ${at}`);
    const created = CREATED_FOR.exec(line);
    if (created) {
      if (current.createdForPid !== null) return unknown(`second created-for line at ${at}`);
      current.createdForPid = Number(created[1]);
      continue;
    }
    if (DETAIL_LINES.some((pattern) => pattern.test(line))) continue;
    return unknown(`unrecognized line in the owning-process block at line ${at}`);
  }

  if (!sawSystem) return unknown('no system-wide block');
  if (!sawOwners) return unknown('no owning-process block');
  if (!sawKernel) return unknown('no kernel-assertions header, so the output may be truncated');
  return { kind: 'ok', systemWide, holders };
}

/** `pmset -g assertions`, parsed. */
export async function readAssertions(): Promise<AssertionsReading> {
  const run = await runReading('/usr/bin/pmset', ['-g', 'assertions']);
  if (!run.ok) return unknown(`run failed: ${run.reason}`);
  return parseAssertions(run.stdout);
}
