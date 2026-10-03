/**
 * Codex app-server fixtures: loading and the redaction scan (epic #1175,
 * phase 1 #1181).
 *
 * The fixtures under `tests/fixtures/codex-app-server/` are frames captured from
 * a real Codex app-server, redacted by `scripts/extract-codex-fixtures.ts`. The
 * raw captures hold local paths, thread ids and account metadata, so they are
 * never committed; `scanForLeaks` is the gate that proves the redacted copies
 * carry none.
 *
 * The scan is an ALLOWLIST first and a denylist second:
 * - every absolute path must start with `/work/` (plus a few system shells);
 * - every UUID must be one of the sequential placeholders;
 * - then a generic list of patterns that must not appear at all.
 * The denylist holds no real personal string. The current user name and host
 * name are read from the running process, so the committed source never names
 * them.
 */
import { readFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { join } from 'node:path';

export const FIXTURE_DIR = join(import.meta.dir, '..', 'fixtures', 'codex-app-server');

/** One captured frame: which client saw it, which way it travelled, and its JSON body. */
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

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const PLACEHOLDER_UUID = /^00000000-0000-7000-8000-0{9}[0-9a-f]{3}$/i;

/** Where an absolute path may point: the fake project and Codex home, and the shells a command names. */
const ALLOWED_PATH = /^(?:\/work(?:\/|$)|\/bin\/(?:zsh|bash|sh)$|\/dev\/null$)/;
/** An absolute path token: a `/` not glued to a word, URL scheme or other path, up to a delimiter. */
const PATH_TOKEN = /(?<![\w:./~-])\/[^\s"'`,)\]}]+/g;

export interface LeakFinding {
  rule: string;
  match: string;
}

/** `[rule, pattern]` pairs for text that must not appear in a fixture at all. */
const DENIED: ReadonlyArray<readonly [string, RegExp]> = [
  ['users-path', /\/Users\//],
  ['private-path', /\/private\//],
  ['var-folders', /\/var\/folders/],
  ['home-path', /\/home\//],
  ['terminal-emulator', /ghostty/i],
  ['install-id', /installationId/],
  ['plan-type', /planType/],
  ['jwt', /eyJ/],
  ['bearer', /Bearer/i],
  ['api-key', /sk-/],
  ['auth', /auth/i],
  ['token', /token/i],
  ['email-or-handle', /@/],
  ['opaque-id', /\b(?:rs|msg|call)_[A-Za-z0-9]{6,}/],
];

/** Every static rule `scanForLeaks` applies (the current user and host name rules are added at run time). */
export const LEAK_RULES: readonly string[] = [
  'absolute-path',
  'uuid',
  ...DENIED.map(([rule]) => rule),
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The current user and host name as whole-word patterns, read from the process (never committed). */
function machineIdentity(): ReadonlyArray<readonly [string, RegExp]> {
  const out: Array<readonly [string, RegExp]> = [];
  const names: Array<[string, string | undefined]> = [
    ['username', safe(() => userInfo().username)],
    ['hostname', safe(() => hostname().split('.')[0])],
  ];
  for (const [rule, name] of names) {
    if (name && name.length >= 3) {
      out.push([rule, new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(name)}(?![A-Za-z0-9])`, 'i')]);
    }
  }
  return out;
}

function safe(read: () => string | undefined): string | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/**
 * Everything in `text` that breaks the fixture redaction contract. Empty means
 * clean. `extraDenied` adds `[rule, pattern]` pairs for a caller that knows one more string.
 */
export function scanForLeaks(
  text: string,
  extraDenied: ReadonlyArray<readonly [string, RegExp]> = [],
): LeakFinding[] {
  const findings: LeakFinding[] = [];
  for (const match of text.matchAll(PATH_TOKEN)) {
    if (!ALLOWED_PATH.test(match[0])) findings.push({ rule: 'absolute-path', match: match[0] });
  }
  for (const match of text.matchAll(UUID)) {
    if (!PLACEHOLDER_UUID.test(match[0])) findings.push({ rule: 'uuid', match: match[0] });
  }
  for (const [rule, pattern] of [...DENIED, ...machineIdentity(), ...extraDenied]) {
    const hit = pattern.exec(text);
    if (hit) findings.push({ rule, match: hit[0] });
  }
  return findings;
}
