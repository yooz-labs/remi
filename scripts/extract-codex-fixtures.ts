#!/usr/bin/env bun
/**
 * Extract redacted Codex app-server fixtures from the spike's raw frame logs
 * (epic #1175, phase 1 #1181). A dev tool, never run by CI.
 *
 *   bun scripts/extract-codex-fixtures.ts <raw-log-dir> [--out <dir>]
 *   CODEX_SPIKE_DIR=<raw-log-dir> bun scripts/extract-codex-fixtures.ts
 *
 * The raw logs hold local paths, thread ids and account metadata, so they are
 * read here and never copied: only frames on the method allowlist survive, each
 * rewritten to placeholders (`/work/project`, `/work/codex-home`, sequential
 * UUID-shaped ids, `test-model`). The result is checked with the same
 * `scanForLeaks` the test suite runs (fields checked by key, free text only from the reviewed
 * `approved-free-text.json`), and nothing is written when it finds a
 * leak. Output is deterministic for the same inputs, and `index.json` records
 * each source file's sha256 so a later run can tell whether its inputs changed.
 *
 * No path or name from the raw logs is written in this file: roots are
 * discovered from the data (`codexHome`, the threads' `cwd`).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  APPROVED_FREE_TEXT_FILE,
  FIXTURE_DIR,
  type FixtureFrame,
  type FixtureIndex,
  type FixtureIndexFile,
  placeholderUuid,
  readApprovedFreeText,
} from '../packages/daemon/tests/helpers/codex-fixtures.ts';
import { freeTextOf, scanForLeaks } from '../packages/daemon/tests/helpers/fixture-scan.ts';

const EXTRACTOR_VERSION = 1;
const CLI_VERSION = '0.160.0';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = { [key: string]: Json };

interface RawRecord {
  client: string;
  dir: string;
  frame: Obj;
}

interface Source {
  file: string;
  /** When set, keep only these 1-based source lines (still subject to the method allowlist). */
  lines?: readonly number[];
}

/** Raw captures in output order. `expFlags` is kept for one frame: a bare TUI's `thread/started`. */
const SOURCES: readonly Source[] = [
  { file: 'expA-accept.jsonl' },
  { file: 'expA-decline.jsonl' },
  { file: 'expB.jsonl' },
  { file: 'expB3.jsonl' },
  { file: 'expC.jsonl' },
  { file: 'expFlags.jsonl', lines: [11] },
];

/** Notifications and server requests kept as received. */
const KEEP_IN_METHODS = new Set([
  'thread/started',
  'thread/status/changed',
  'thread/closed',
  'item/commandExecution/requestApproval',
  'item/tool/requestUserInput',
  'serverRequest/resolved',
  'turn/started',
  'turn/completed',
]);
/** Item types kept inside `item/started` and `item/completed` (reasoning items are dropped). */
const KEEP_ITEM_TYPES = new Set(['userMessage', 'agentMessage', 'commandExecution']);
/** Client requests kept (the prompts and thread-creation requests are dropped). */
const KEEP_OUT_METHODS = new Set(['initialized', 'thread/resume', 'thread/unsubscribe']);
/** Responses kept when they answer one of these client requests. */
const KEEP_RESPONSE_TO = new Set(['initialize', 'thread/resume', 'thread/unsubscribe']);

/** Keys removed wherever they appear. */
const DROP_KEYS = new Set(['installationId', 'serverName', 'planType', 'rateLimits']);
/** Replacement for a field by key, or undefined to keep recursing. Applied only to populated fields. */
function replacementFor(key: string, value: Json): Json | undefined {
  switch (key) {
    case 'model':
      return typeof value === 'string' ? 'test-model' : undefined;
    case 'userAgent':
      return typeof value === 'string' ? `remi/${CLI_VERSION} (test)` : undefined;
    case 'developer_instructions':
      return typeof value === 'string' ? 'developer instructions omitted' : undefined;
    case 'instructionSources':
      return Array.isArray(value) ? [] : undefined;
    case 'serviceTier':
    case 'gitInfo':
      return null;
    case 'processId':
      return typeof value === 'string' ? '4242' : undefined;
    default:
      return undefined;
  }
}

const TIME_BASE_SECONDS = 1_700_000_000;
const TIME_BASE_MS = TIME_BASE_SECONDS * 1000;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const OPAQUE_ID = /\b(rs|msg|call)_[A-Za-z0-9]{6,}/g;

/** Request methods by `client:id`, so a response can be matched to what it answers. */
class Correlator {
  private readonly out = new Map<string, string>();
  private readonly inbound = new Set<string>();
  noteOut(client: string, frame: Obj): void {
    if (typeof frame['method'] === 'string' && frame['id'] !== undefined) {
      this.out.set(`${client}:${String(frame['id'])}`, frame['method']);
    }
  }
  noteIn(client: string, frame: Obj): void {
    if (typeof frame['method'] === 'string' && frame['id'] !== undefined) {
      this.inbound.add(`${client}:${String(frame['id'])}`);
    }
  }
  answeredMethod(client: string, id: Json | undefined): string | undefined {
    return this.out.get(`${client}:${String(id)}`);
  }
  isServerRequestId(client: string, id: Json | undefined): boolean {
    return this.inbound.has(`${client}:${String(id)}`);
  }
}

function hasKey(o: Obj, key: string): boolean {
  return Object.hasOwn(o, key);
}

/** Whether a raw record belongs in the fixtures. */
function keep(rec: RawRecord, c: Correlator): boolean {
  const f = rec.frame;
  const method = typeof f['method'] === 'string' ? f['method'] : undefined;
  if (rec.dir === 'in') {
    if (method === 'item/started' || method === 'item/completed') {
      const item = (f['params'] as Obj | undefined)?.['item'] as Obj | undefined;
      return typeof item?.['type'] === 'string' && KEEP_ITEM_TYPES.has(item['type']);
    }
    if (method) return KEEP_IN_METHODS.has(method);
    // An error response to a kept request is kept too (the `-32600` the spike report describes).
    if (hasKey(f, 'result') || hasKey(f, 'error')) {
      const answered = c.answeredMethod(rec.client, f['id']);
      return answered !== undefined && KEEP_RESPONSE_TO.has(answered);
    }
    return false;
  }
  if (rec.dir === 'out') {
    if (method) return KEEP_OUT_METHODS.has(method);
    // An answer to a request the server sent.
    return hasKey(f, 'result') && c.isServerRequestId(rec.client, f['id']);
  }
  return false;
}

/** Placeholder state shared by every file in one run, so ids stay consistent across files. */
class Redactor {
  private readonly uuids = new Map<string, string>();
  private readonly opaque = new Map<string, string>();
  private readonly rollouts = new Map<string, number>();
  private readonly projectRoots: string[] = [];
  private readonly homeRoots: string[] = [];
  private minSeconds = Number.POSITIVE_INFINITY;
  private minMs = Number.POSITIVE_INFINITY;

  /** Learn the path roots from the data: `codexHome` values and thread `cwd` values. */
  learnRoots(frame: Json): void {
    walk(frame, (key, value) => {
      if (typeof value !== 'string' || !value.startsWith('/')) return;
      if (key === 'codexHome' && !this.homeRoots.includes(value)) this.homeRoots.push(value);
      if (
        (key === 'cwd' || key === 'runtimeWorkspaceRoots') &&
        !this.projectRoots.includes(value)
      ) {
        this.projectRoots.push(value);
      }
    });
  }

  /** Fix the per-file time anchors; call once per output file before `redact`. */
  anchorTimes(frames: Json[]): void {
    this.minSeconds = Number.POSITIVE_INFINITY;
    this.minMs = Number.POSITIVE_INFINITY;
    for (const frame of frames) {
      walk(frame, (key, value) => {
        if (typeof value !== 'number') return;
        if (key.endsWith('AtMs')) this.minMs = Math.min(this.minMs, value);
        else if (/At$/.test(key)) this.minSeconds = Math.min(this.minSeconds, value);
      });
    }
  }

  redact(value: Json, key = ''): Json {
    if (typeof value === 'string') return this.string(value);
    if (typeof value === 'number') return this.number(key, value);
    if (value === null || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.map((v) => this.redact(v, key));
    const out: Obj = {};
    for (const [k, v] of Object.entries(value)) {
      if (DROP_KEYS.has(k)) continue;
      const replaced = replacementFor(k, v);
      out[k] = replaced === undefined ? this.redact(v, k) : replaced;
    }
    return out;
  }

  private number(key: string, value: number): number {
    if (key.endsWith('AtMs')) return TIME_BASE_MS + (value - this.minMs);
    if (/At$/.test(key)) return TIME_BASE_SECONDS + (value - this.minSeconds);
    return value;
  }

  private string(raw: string): string {
    let s = this.rolloutPath(raw) ?? raw;
    const roots: Array<[string, string]> = [
      ...this.homeRoots.map((r): [string, string] => [r, '/work/codex-home']),
      ...this.projectRoots.map((r, i): [string, string] => [
        r,
        i === 0 ? '/work/project' : `/work/project-${i + 1}`,
      ]),
    ].sort((a, b) => b[0].length - a[0].length);
    for (const [root, placeholder] of roots) s = s.split(root).join(placeholder);
    s = s.replace(OPAQUE_ID, (id, prefix: string) => this.opaqueId(prefix, id));
    return s.replace(UUID, (id) => this.uuid(id));
  }

  /** `<home>/sessions/<date>/rollout-<stamp>-<uuid>.jsonl` becomes `rollout-T<n>.jsonl`. */
  private rolloutPath(s: string): string | undefined {
    const m =
      /\/sessions\/(?:.*\/)?rollout-.*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(
        s,
      );
    if (!m || !this.homeRoots.some((r) => s.startsWith(`${r}/`))) return undefined;
    const id = (m[1] as string).toLowerCase();
    if (!this.rollouts.has(id)) this.rollouts.set(id, this.rollouts.size + 1);
    return `/work/codex-home/sessions/rollout-T${this.rollouts.get(id)}.jsonl`;
  }

  uuid(id: string): string {
    const key = id.toLowerCase();
    let hit = this.uuids.get(key);
    if (!hit) {
      hit = placeholderUuid(this.uuids.size + 1);
      this.uuids.set(key, hit);
    }
    return hit;
  }

  private opaqueId(prefix: string, id: string): string {
    let hit = this.opaque.get(id);
    if (!hit) {
      hit = `${prefix}-id-${this.opaque.size + 1}`;
      this.opaque.set(id, hit);
    }
    return hit;
  }
}

function walk(value: Json, visit: (key: string, value: Json) => void, key = ''): void {
  visit(key, value);
  if (Array.isArray(value)) {
    for (const v of value) walk(v, visit, key);
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) walk(v, visit, k);
  }
}

function sha256(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

function readRaw(path: string): RawRecord[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as RawRecord);
}

/** One `-32600` error for `thread/resume` before the first user message: from the spike report, not a log. */
function reportDerived(r: Redactor): FixtureFrame[] {
  const id = r.uuid('report-derived-thread-without-rollout');
  return [
    {
      client: 'X',
      dir: 'in',
      frame: { id: 2, error: { code: -32600, message: `no rollout found for thread id ${id}` } },
    },
  ];
}

/**
 * Frames built from the generated TypeScript schema for the server requests the spike never provoked.
 * Tests assert only that they do not crash, are `terminalOnly` and dismiss.
 */
function syntheticFromSchema(r: Redactor): FixtureFrame[] {
  const threadId = r.uuid('synthetic-thread');
  const turnId = r.uuid('synthetic-turn');
  const request = (id: number, method: string, params: Obj): FixtureFrame => ({
    client: 'S',
    dir: 'in',
    frame: { method, id, params },
  });
  return [
    request(101, 'item/fileChange/requestApproval', {
      threadId,
      turnId,
      itemId: r.uuid('synthetic-file-item'),
      startedAtMs: TIME_BASE_MS,
      reason: 'synthetic file change',
      grantRoot: null,
    }),
    request(102, 'item/permissions/requestApproval', {
      threadId,
      turnId,
      itemId: r.uuid('synthetic-permissions-item'),
      environmentId: 'local',
      startedAtMs: TIME_BASE_MS,
      cwd: '/work/project',
      reason: 'synthetic permissions',
      permissions: { network: { enabled: true }, fileSystem: null },
    }),
    request(103, 'mcpServer/elicitation/request', {
      threadId,
      turnId: null,
      serverName: 'test-server',
      mode: 'form',
      _meta: null,
      message: 'synthetic elicitation',
      requestedSchema: { type: 'object', properties: {} },
    }),
  ];
}

const toLine = (f: FixtureFrame): string => `${JSON.stringify(f)}\n`;

/** `<raw-log-dir>` (or CODEX_SPIKE_DIR) and an optional `--out <dir>` (default: the committed fixture directory). */
function parseArgs(argv: string[]): {
  rawDir: string;
  outDir: string;
  approvedFile: string;
  showUnapproved: boolean;
} {
  const args = [...argv];
  const take = (name: string): string | undefined => {
    const flag = args.indexOf(name);
    if (flag < 0) return undefined;
    const value = args[flag + 1];
    args.splice(flag, 2);
    return value;
  };
  const outDir = resolve(take('--out') ?? FIXTURE_DIR);
  const approvedFile = resolve(take('--approved') ?? APPROVED_FREE_TEXT_FILE);
  const showFlag = args.indexOf('--show-unapproved');
  if (showFlag >= 0) args.splice(showFlag, 1);
  const raw = args[0] ?? process.env['CODEX_SPIKE_DIR'];
  if (!raw) {
    console.error(
      'usage: bun scripts/extract-codex-fixtures.ts <raw-log-dir> [--out <dir>] [--approved <file>] [--show-unapproved] (or CODEX_SPIKE_DIR)',
    );
    process.exit(2);
  }
  return { rawDir: resolve(raw), outDir, approvedFile, showUnapproved: showFlag >= 0 };
}

function main(): void {
  const { rawDir, outDir, approvedFile, showUnapproved } = parseArgs(process.argv.slice(2));
  const redactor = new Redactor();
  const files: FixtureIndexFile[] = [];
  const outputs = new Map<string, string>();

  // Pass 1: read every source and learn the path roots from all of it.
  const loaded = SOURCES.map((s) => {
    const bytes = readFileSync(join(rawDir, s.file));
    return { source: s, sha: sha256(bytes), records: readRaw(join(rawDir, s.file)) };
  });
  for (const { records } of loaded) for (const rec of records) redactor.learnRoots(rec.frame);

  // Pass 2: select, redact, serialize.
  for (const { source, sha, records } of loaded) {
    const c = new Correlator();
    const kept: Array<{ rec: RawRecord; line: number }> = [];
    records.forEach((rec, i) => {
      const line = i + 1;
      // Correlation sees every frame, kept or not, so a dropped request still pairs its response.
      const wanted = !source.lines || source.lines.includes(line);
      if (rec.dir === 'out') c.noteOut(rec.client, rec.frame);
      if (rec.dir === 'in') c.noteIn(rec.client, rec.frame);
      if (wanted && keep(rec, c)) kept.push({ rec, line });
    });
    redactor.anchorTimes(kept.map((k) => k.rec.frame));
    const frames: FixtureFrame[] = kept.map(({ rec, line }) => ({
      client: rec.client,
      dir: rec.dir as 'in' | 'out',
      line,
      frame: redactor.redact(rec.frame) as Record<string, unknown>,
    }));
    outputs.set(source.file, frames.map(toLine).join(''));
    files.push({
      file: source.file,
      label: 'real',
      source: source.file,
      sourceSha256: sha,
      frames: frames.length,
    });
  }

  const derived: Array<[string, string, FixtureFrame[]]> = [
    ['report-derived.jsonl', 'report-derived', reportDerived(redactor)],
    ['synthetic-from-schema.jsonl', 'synthetic-from-schema', syntheticFromSchema(redactor)],
  ];
  for (const [file, label, frames] of derived) {
    outputs.set(file, frames.map(toLine).join(''));
    files.push({ file, label, frames: frames.length });
  }

  const index: FixtureIndex = {
    extractorVersion: EXTRACTOR_VERSION,
    cliVersion: CLI_VERSION,
    files,
  };
  outputs.set('index.json', `${JSON.stringify(index, null, 2)}\n`);

  // Gate: never write a leak. Free text fails closed: only strings in the reviewed approved set pass,
  // so a real session's prose cannot ride through. Findings print the rule and file, never the value.
  const approvedFreeText = readApprovedFreeText(approvedFile);
  let leaks = 0;
  for (const [file, text] of outputs) {
    for (const finding of scanForLeaks(text, { approvedFreeText })) {
      leaks += 1;
      console.error(`LEAK ${file}: ${finding.rule}`);
    }
    if (showUnapproved && file.endsWith('.jsonl')) {
      const frames = text
        .split('\n')
        .filter(Boolean)
        .map((l) => (JSON.parse(l) as { frame: unknown }).frame);
      // Only on request: this prints text that came from a real session, for a person to review.
      for (const s of freeTextOf(frames).filter((t) => !approvedFreeText.has(t))) {
        console.error(`UNAPPROVED ${file}: ${JSON.stringify(s)}`);
      }
    }
  }
  if (leaks > 0) {
    console.error(
      `${leaks} finding(s); nothing written. Extend the redaction rules, or review the free text and add it to the approved set.`,
    );
    process.exit(1);
  }

  mkdirSync(outDir, { recursive: true });
  for (const name of readdirSync(outDir)) {
    if (name.endsWith('.jsonl') || name === 'index.json') rmSync(join(outDir, name));
  }
  for (const [file, text] of outputs) writeFileSync(join(outDir, file), text);
  console.log(`wrote ${outputs.size} files to ${outDir}`);
  for (const f of files) console.log(`  ${f.file}: ${f.frames} frames (${f.label})`);
}

try {
  main();
} catch (error) {
  console.error(`extraction failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
