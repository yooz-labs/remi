/**
 * Codex app-server fixtures: loading, and the reviewed free text the redaction
 * scan allows (epic #1175, phase 1 #1181).
 *
 * The fixtures under `tests/fixtures/codex-app-server/` are frames captured from
 * a real Codex app-server, redacted by `scripts/extract-codex-fixtures.ts`. The
 * raw captures hold local paths, thread ids and account metadata, so they are
 * never committed; the scan is the gate that proves the redacted copies carry
 * none.
 *
 * The scan itself, `scanForLeaks`, lives in `fixture-scan.ts`; this file loads
 * the fixtures and the reviewed set of free-text strings the scan allows.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const FIXTURE_DIR = join(import.meta.dir, '..', 'fixtures', 'codex-app-server');

/** One captured frame: which client saw it, which way it traveled, and its JSON body. */
export interface FixtureFrame {
  client: string;
  dir: 'in' | 'out';
  /** 1-based line of the frame in the raw capture; absent for `report-derived` frames. */
  line?: number;
  frame: Record<string, unknown>;
}

export interface FixtureIndexFile {
  file: string;
  /** `real`, `report-derived` or `synthetic-from-schema`. */
  label: string;
  /** Raw capture the frames came from; absent for the two derived files. */
  source?: string;
  sourceSha256?: string;
  /** Structural redactions applied to this captured source before it became public. */
  redactions?: string[];
  frames: number;
}

export interface FixtureIndex {
  extractorVersion: number;
  cliVersion: string;
  files: FixtureIndexFile[];
}

export function readFixtureText(file: string): string {
  return readFileSync(join(FIXTURE_DIR, file), 'utf8');
}

export function readFixtureIndex(): FixtureIndex {
  return JSON.parse(readFixtureText('index.json')) as FixtureIndex;
}

/** Every frame of one fixture file, in capture order. */
export function loadFixtureFrames(file: string): FixtureFrame[] {
  return readFixtureText(file)
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as FixtureFrame);
}

/** The frame at `line` of the raw capture a fixture file came from. */
export function fixtureFrameAt(file: string, line: number): FixtureFrame {
  const hit = loadFixtureFrames(file).find((f) => f.line === line);
  if (!hit) throw new Error(`fixture ${file} has no frame from source line ${line}`);
  return hit;
}

/** The sequential UUID-shaped placeholder for id number `n` (1-based). */
export function placeholderUuid(n: number): string {
  return `00000000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
}

/** The reviewed free-text strings the scan allows (placeholder UUIDs normalized to `<uuid>`). */
export const APPROVED_FREE_TEXT_FILE = join(FIXTURE_DIR, 'approved-free-text.json');

export function readApprovedFreeText(file = APPROVED_FREE_TEXT_FILE): Set<string> {
  return new Set(JSON.parse(readFileSync(file, 'utf8')) as string[]);
}
