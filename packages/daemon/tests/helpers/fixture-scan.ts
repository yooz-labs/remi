/**
 * The redaction scan for the Codex app-server fixtures (epic #1175, phase 1 #1181).
 *
 * The fixtures are frames from a real Codex app-server, rewritten by
 * `scripts/extract-codex-fixtures.ts`. The raw captures hold local paths, ids and account
 * metadata, and this repository is public, so the scan is what proves the committed copies carry
 * none, and the extractor refuses to write anything that fails it.
 *
 * A denylist alone cannot do that: every pattern it lacks is a leak that passes. So the scan is
 * structural first. It parses each frame and decides, field by field, what a value may be:
 * - fields with one allowed value (`model`, `userAgent`, `serverName`, ...) must hold it;
 * - fields that name a place (`cwd`, `path`, `codexHome`, ...) must be null or a `/work/...` path
 *   with no `..`;
 * - id fields must be placeholders; timestamps must sit near a fixed fictional epoch;
 * - free text (a message, a command, a title) FAILS CLOSED: it must be in the reviewed
 *   `approved-free-text.json`, so re-extracting from a real session cannot carry prose through;
 * - everything else must be a plain token, never a sentence, a path or a URL.
 * Then every string and key meets a list of patterns that must not appear anywhere.
 *
 * It holds no real personal string. The current user, home directory and host name are read from
 * the running process, so committed source never names them.
 */
import { homedir, hostname, userInfo } from 'node:os';
import { basename } from 'node:path';

export interface LeakFinding {
  rule: string;
  match: string;
}

export interface ScanIdentity {
  username: string | undefined;
  homeName: string | undefined;
  host: string | undefined;
}

export interface ScanOptions {
  /**
   * The reviewed free-text strings (placeholder UUIDs normalized to `<uuid>`). When given, any
   * free-text field outside it is a finding; the committed fixtures and the extractor always pass it.
   */
  approvedFreeText?: ReadonlySet<string>;
  /** Whose names must not appear; read from the process unless a test supplies it. */
  identity?: ScanIdentity;
  /** `[rule, pattern]` pairs for a caller that knows one more string. */
  extraDenied?: ReadonlyArray<readonly [string, RegExp]>;
}

/** Keys whose string values (or string array elements) are prose or commands, and so need approval. */
export const FREE_TEXT_KEYS: ReadonlySet<string> = new Set([
  'text',
  'preview',
  'name',
  'command',
  'message',
  'reason',
  'question',
  'header',
  'label',
  'description',
  'summary',
  'title',
  'answers',
  'aggregatedOutput',
  'proposedExecpolicyAmendment',
  'execpolicy_amendment',
]);

/**
 * Keys that may hold exactly these values (null always passes; see `checkField`). A `parent.key`
 * entry applies only under that parent: `files.label` is an index entry's label, while a bare
 * `label` is free text (a question option).
 */
const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  dir: ['in', 'out'],
  'files.label': ['real', 'report-derived', 'synthetic-from-schema'],
  model: ['test-model'],
  userAgent: ['remi/0.160.0 (test)'],
  serverName: ['test-server'],
  developer_instructions: ['developer instructions omitted'],
  processId: ['4242'],
  originator: ['remi-spike'],
  environmentId: ['local'],
};

/** Keys that name a place: null, or a `/work` path. */
const PATH_KEY = /(?:path|cwd|dir|root|home|file|folder)s?$/i;

const PLACEHOLDER_UUID_SOURCE = '00000000-0000-7000-8000-[0-9a-f]{12}';
const PLACEHOLDER_UUID = new RegExp(`^${PLACEHOLDER_UUID_SOURCE}$`, 'i');
const PLACEHOLDER_UUID_ANYWHERE = new RegExp(PLACEHOLDER_UUID_SOURCE, 'gi');
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** An id the extractor can have written: a placeholder UUID, an item id built on one, a numbered opaque id. */
const PLACEHOLDER_ID = new RegExp(
  `^(?:exec-)?${PLACEHOLDER_UUID_SOURCE}$|^(?:msg|rs|call)-id-\\d+$|^q\\d+$`,
  'i',
);
const ID_KEY = /(?:^|[a-z])id$/i;
const CURSOR_KEY = /BackwardsCursor$/;
const CURSOR = new RegExp(
  `^\\{"requestedThreadId":"${PLACEHOLDER_UUID_SOURCE}","rolloutOrdinal":\\d+,"includeAnchor":true,"scope":\\{"kind":"[A-Za-z]+"\\}\\}$`,
  'i',
);
/** A plain token: a word, a version, a method name, an enum. Never a sentence, a path or a URL. */
const TOKEN = /^[A-Za-z0-9_.-]{1,80}$/;
const METHOD = /^[a-z][A-Za-z]*(?:\/[A-Za-z]+){1,3}$/;

const FICTIONAL_SECONDS = [1_700_000_000, 1_700_100_000] as const;
const FICTIONAL_MS = [1_700_000_000_000, 1_700_100_000_000] as const;

/** Paths a value may name: the fake project and Codex home, and the shells a command invokes. */
function isAllowedPath(path: string): boolean {
  if (path === '/dev/null' || /^\/bin\/(?:zsh|bash|sh)$/.test(path)) return true;
  if (path !== '/work' && !path.startsWith('/work/')) return false;
  return !path.split('/').some((segment) => segment === '..' || segment === '.');
}

/** An absolute path token: a `/` that does not continue a word, followed by a path character. */
const PATH_TOKEN = /(?<![\w])\/[A-Za-z0-9._~%@+-][^\s"'`,)\]}]*/g;

/**
 * `[rule, pattern]` pairs for text that must not appear in any string or key. Applied after
 * placeholder UUIDs are masked out, so a placeholder never trips a digit or hex rule.
 */
const DENIED: ReadonlyArray<readonly [string, RegExp]> = [
  ['users-path', /\/Users\//],
  ['private-path', /\/private\//],
  ['var-folders', /\/var\/folders/],
  ['home-path', /\/home\//],
  ['install-id', /installationId/],
  ['plan-type', /planType/],
  ['jwt', /eyJ/],
  ['bearer', /Bearer/i],
  ['api-key', /sk-/],
  [
    'cloud-token',
    /(?:ghp_|gho_|ghu_|ghs_|github_pat_|AKIA[0-9A-Z]{4,}|xox[baprs]-|sk_live_|sk_test_)/,
  ],
  ['auth', /auth/i],
  ['token', /token/i],
  ['email-or-handle', /@/],
  ['opaque-id', /\b(?:rs|msg|call)_[A-Za-z0-9]{6,}/],
  ['os-fingerprint', /\b(?:Mac OS|macOS \d|Windows NT|Ubuntu|Darwin)\b/],
  ['cpu-arch', /\b(?:arm64|x86_64|aarch64|amd64)\b/],
  ['model-name', /\b(?:gpt|claude|gemini|llama|mistral)-/i],
  ['rate-limit', /usedPercent|resetsAt|windowDurationMins|resetsInSeconds|rateLimits/],
  ['tilde', /~/],
  ['backslash', /\\/],
  ['url-scheme', /[a-z][a-z0-9+.-]*:\/\//i],
  ['percent-encoding', /%[0-9a-f]{2}/i],
  ['bad-char', /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f⁄∕⧸﹨／＼]/],
  ['long-hex', /(?<![0-9a-f])[0-9a-f]{20,}(?![0-9a-f])/i],
  ['hyphenated-hex-id', /(?<![0-9a-z])[0-9a-f]{4,}(?:-[0-9a-f]{2,}){2,}(?![0-9a-z])/i],
  ['base64-blob', /[A-Za-z0-9+/]{40,}={0,2}/],
  ['ipv4', /\b(?:\d{1,3}\.){3}\d{1,3}\b/],
  ['mac-address', /\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/i],
  ['phone-number', /(?<![\w.])\+?\d[\d ()-]{8,}\d(?![\w.])/],
  [
    'internal-host',
    /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:local|internal|lan|corp|home|intranet|svc|cluster|ts\.net)\b/i,
  ],
  ['remote-url', /\.git\b|ssh:|git:/],
];

/** Every static rule `scanForLeaks` can report (the user, home and host name rules are added at run time). */
export const LEAK_RULES: readonly string[] = [
  'absolute-path',
  'path-field',
  'uuid',
  'timestamp',
  'enum-value',
  'id-shape',
  'cursor-shape',
  'token-shape',
  'unapproved-free-text',
  ...DENIED.map(([rule]) => rule),
];

/** Free text as it is compared to the approved set: placeholder UUIDs are numbered, the set is not. */
export function normalizeFreeText(text: string): string {
  return text.replace(PLACEHOLDER_UUID_ANYWHERE, '<uuid>');
}

/** The free-text strings of parsed frames, normalized and sorted, for review. */
export function freeTextOf(frames: unknown[]): string[] {
  const found = new Set<string>();
  for (const frame of frames) {
    walk(frame, '', (key, value) => {
      if (typeof value === 'string' && FREE_TEXT_KEYS.has(key) && value !== '') {
        found.add(normalizeFreeText(value));
      }
    });
  }
  return [...found].sort();
}

function walk(
  value: unknown,
  key: string,
  visit: (key: string, value: unknown, parentKey: string) => void,
  parentKey = '',
): void {
  visit(key, value, parentKey);
  if (Array.isArray(value)) {
    for (const element of value) walk(element, key, visit, parentKey);
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) walk(v, k, visit, key);
  }
}

const GENERIC_NAMES = new Set([
  'unknown',
  'root',
  'user',
  'admin',
  'test',
  'tests',
  'runner',
  'builder',
  'ubuntu',
  'node',
  'nobody',
  'guest',
  'default',
  'work',
  'project',
  'local',
  'localhost',
  'home',
]);

function readIdentity(): ScanIdentity {
  const read = <T>(fn: () => T): T | undefined => {
    try {
      return fn();
    } catch {
      return undefined;
    }
  };
  return {
    username: read(() => userInfo().username),
    homeName: read(() => basename(homedir())),
    host: read(() => hostname().split('.')[0]),
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The names of the machine as whole-word patterns. A name that is generic (`unknown` under
 * `env -i`, `root`, `runner`) is skipped: it would match legitimate words and tells nothing.
 */
function identityRules(identity: ScanIdentity): ReadonlyArray<readonly [string, RegExp]> {
  const out: Array<readonly [string, RegExp]> = [];
  for (const [rule, name] of [
    ['username', identity.username],
    ['home-name', identity.homeName],
    ['hostname', identity.host],
  ] as const) {
    if (!name || name.length < 3 || GENERIC_NAMES.has(name.toLowerCase())) continue;
    out.push([rule, new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(name)}(?![A-Za-z0-9])`, 'i')]);
  }
  return out;
}

/** The rules that fire on one string (or key), after placeholder UUIDs are masked out. */
function scanString(s: string, extra: ReadonlyArray<readonly [string, RegExp]>): LeakFinding[] {
  const findings: LeakFinding[] = [];
  for (const match of s.matchAll(UUID)) {
    if (!PLACEHOLDER_UUID.test(match[0])) findings.push({ rule: 'uuid', match: match[0] });
  }
  const masked = s.replace(PLACEHOLDER_UUID_ANYWHERE, '<uuid>');
  for (const match of masked.matchAll(PATH_TOKEN)) {
    if (!isAllowedPath(match[0])) findings.push({ rule: 'absolute-path', match: match[0] });
  }
  for (const [rule, pattern] of [...DENIED, ...extra]) {
    const hit = pattern.exec(masked);
    if (hit) findings.push({ rule, match: hit[0] });
  }
  return findings;
}

/** The 64 hex characters of a SHA-256 in the index: provenance of a raw file, not a leak. */
const SHA256 = /^[0-9a-f]{64}$/;
/** A fixture file name in the index. */
const FIXTURE_FILE_NAME = /^[A-Za-z0-9-]+\.(?:jsonl|json)$/;

/** What a field of a given key may hold, beyond the universal string rules. */
function checkField(
  key: string,
  value: unknown,
  options: ScanOptions,
  parentKey: string,
): LeakFinding[] {
  const flag = (rule: string, match: unknown): LeakFinding[] => [
    { rule, match: `${key}: ${typeof match === 'string' ? match.slice(0, 40) : String(match)}` },
  ];
  if (key === 'gitInfo') return value === null ? [] : flag('enum-value', 'a gitInfo object');
  if (key === 'instructionSources') {
    return Array.isArray(value) && value.length === 0
      ? []
      : flag('enum-value', 'instructionSources');
  }
  if (key === 'serviceTier') return value === null ? [] : flag('enum-value', 'serviceTier');
  if (typeof value === 'number') {
    const secs = value >= FICTIONAL_SECONDS[0] && value <= FICTIONAL_SECONDS[1];
    const ms = value >= FICTIONAL_MS[0] && value <= FICTIONAL_MS[1];
    return value >= 1_000_000_000 && !secs && !ms ? flag('timestamp', value) : [];
  }
  if (typeof value !== 'string') return [];
  if (key === 'sourceSha256') return SHA256.test(value) ? [] : flag('enum-value', value);
  if (key === 'file') return FIXTURE_FILE_NAME.test(value) ? [] : flag('token-shape', value);
  const allowed = ENUM_VALUES[`${parentKey}.${key}`] ?? ENUM_VALUES[key];
  if (allowed) return allowed.includes(value) ? [] : flag('enum-value', value);
  if (PATH_KEY.test(key)) return isAllowedPath(value) ? [] : flag('path-field', value);
  if (CURSOR_KEY.test(key)) return CURSOR.test(value) ? [] : flag('cursor-shape', value);
  if (FREE_TEXT_KEYS.has(key)) {
    if (value === '' || !options.approvedFreeText) return [];
    return options.approvedFreeText.has(normalizeFreeText(value))
      ? []
      : flag('unapproved-free-text', 'not in approved-free-text.json');
  }
  if (ID_KEY.test(key)) return PLACEHOLDER_ID.test(value) ? [] : flag('id-shape', value);
  // Any other string must be a plain token or a method name, never prose, a path or a URL.
  if (value.includes('/')) return METHOD.test(value) ? [] : flag('token-shape', value);
  return TOKEN.test(value) || value === '' ? [] : flag('token-shape', value);
}

/** Parse a fixture file's text: one JSON document, or one per line. Null when it is neither. */
function parseFixtureText(text: string): unknown[] | null {
  try {
    return [JSON.parse(text)];
  } catch {
    // Not one document; try one per line.
  }
  const lines = text.split('\n').filter((l) => l.length > 0);
  try {
    return lines.map((l) => JSON.parse(l) as unknown);
  } catch {
    return null;
  }
}

/**
 * Everything in `text` that breaks the fixture redaction contract; empty means clean. `text` is a
 * fixture file (JSON, or one frame per line). Text that is not JSON is checked as one string.
 */
export function scanForLeaks(text: string, options: ScanOptions = {}): LeakFinding[] {
  const extra = [
    ...identityRules(options.identity ?? readIdentity()),
    ...(options.extraDenied ?? []),
  ];
  const frames = parseFixtureText(text);
  if (!frames) return scanString(text, extra);
  const findings: LeakFinding[] = [];
  for (const frame of frames) {
    walk(frame, '', (key, value, parentKey) => {
      if (key !== '') {
        findings.push(...scanString(key, extra));
        if (!(value !== null && typeof value === 'object' && !Array.isArray(value))) {
          findings.push(...checkField(key, value, options, parentKey));
        }
      }
      // The index's raw-file digests are checked by shape above; they are long hex on purpose.
      if (typeof value === 'string' && !(key === 'sourceSha256' && SHA256.test(value))) {
        findings.push(...scanString(value, extra));
      }
      // `gitInfo` and `instructionSources` are checked as a whole, whatever they hold.
      if ((key === 'gitInfo' || key === 'instructionSources') && typeof value === 'object') {
        findings.push(...checkField(key, value, options, parentKey));
      }
    });
  }
  return findings;
}
