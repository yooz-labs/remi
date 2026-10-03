/**
 * Harness boundary ratchet (epic #1161, phase 3 #1164).
 *
 * The harness seam only holds while the harness-neutral modules stay free of
 * Claude's. This walks the neutral modules, parses each with the TypeScript
 * compiler (so comments and string literals can never match, the same scan as
 * `license-boundary.test.ts`), and fails when one imports a Claude-specific
 * module: anything under `hooks/`, `auto-approve/`, `transcript/` or
 * `cli/session-phases/`, the Claude side of the harness (`harness/index`,
 * `harness/claude`, `harness/claude-session`,
 * `harness/claude-transcript-path`), the Claude session binding
 * (`cli/claude-binding`), the three Claude screen parsers
 * (`parser/output-processor`, `parser/question-parser`,
 * `parser/status-parser`), or a barrel that re-exports them (`parser/index`,
 * and `index`, the package root). `@remi/daemon` and its `exports` subpaths
 * are resolved to those files, so the package name is no way around it.
 * Neutral code takes the contract from `harness/types` and `harness/decision`.
 *
 * A second rule keeps the harness runtime modules from becoming a cycle: only
 * `cli.ts` and `harness/` itself may import `harness/index`, `harness/claude`
 * or `harness/claude-session` other than as a type. `cli/transcript-fallback.ts`
 * did, through `ClaudeHarness`, and that closed a loop through
 * `harness/claude-session.ts` and `hook-bridge-setup.ts` (#1164).
 *
 * Neutral modules: the harness contract (`harness/types.ts`,
 * `harness/decision.ts`), the client-message handlers (`cli/handlers/`), the
 * current-session resolver (`cli/current-session.ts`, which asks the harness for
 * a transcript path), the message API (`api/`) and the session store and
 * registry (`session/`).
 * `harness/claude.ts`, `harness/claude-session.ts`,
 * `harness/claude-transcript-path.ts` and `harness/index.ts` are deliberately
 * not neutral: they are Claude's side of the seam.
 *
 * It is a ratchet, not a clean bill. `DEBT` lists the imports that exist
 * today and are documented as chat-seam debt: three handlers still take
 * Claude's transcript types because the chat path is not behind the seam yet.
 * A new offender fails the test, and so does a debt entry whose import has
 * been removed, so the list can only shrink.
 *
 * Known limits, by design: a specifier computed at runtime (a variable, or a
 * template with substitutions) is not checked, nor is a path built by hand for
 * `fs` or `new URL(..., import.meta.url)`; and a neutral module that reaches a
 * Claude module only through another neutral file's re-export is not caught
 * (the re-exporting file is itself scanned, so the first hop is).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { moduleSpecifiers } from '../helpers/module-specifiers.ts';

const SRC = resolve(import.meta.dir, '..', '..', 'src');

/** Directories whose every `.ts` file is harness-neutral. */
const NEUTRAL_DIRS = ['cli/handlers', 'api', 'session'] as const;
/** Individual harness-neutral files. */
const NEUTRAL_FILES = [
  'harness/types.ts',
  'harness/decision.ts',
  'cli/current-session.ts',
  // The PTY spawn takes its command, environment and output sink as
  // parameters (#1176), so a second harness can use it without Claude's parser.
  'cli/session-phases/pty-session-setup.ts',
] as const;

/** Claude-specific directories, as paths relative to `src`. */
const FORBIDDEN_DIRS = ['hooks', 'auto-approve', 'transcript', 'cli/session-phases'] as const;
/** Claude-specific files, as paths relative to `src`, without extension. */
const FORBIDDEN_FILES = [
  'harness/index',
  'harness/claude',
  'harness/claude-session',
  'harness/claude-transcript-path',
  'parser/output-processor',
  'parser/question-parser',
  'parser/status-parser',
  'parser/index',
  'cli/claude-binding',
  'index',
] as const;

/** The harness modules only `cli.ts` and `harness/` may import at runtime. */
const HARNESS_RUNTIME = ['harness/index', 'harness/claude', 'harness/claude-session'] as const;
const HARNESS_RUNTIME_IMPORTERS = ['cli.ts'] as const;

const DAEMON_PACKAGE = JSON.parse(readFileSync(join(SRC, '..', 'package.json'), 'utf8')) as {
  exports: Record<string, string>;
};

/**
 * Today's offenders, as `<file> -> <imported module>` (both relative to `src`,
 * the module as resolved, with its `.ts` extension). Chat-seam debt: these
 * handlers type Claude's transcript files and discovery. Pay one down by
 * deleting its line.
 */
const DEBT: readonly string[] = [
  'cli/handlers/session-events.ts -> transcript/index.ts',
  'cli/handlers/resume-session-events.ts -> transcript/index.ts',
  'cli/handlers/transcript-events.ts -> transcript/index.ts',
];

function stripExtension(p: string): string {
  return p.replace(/\.(ts|tsx|mts|cts)$/, '');
}

/**
 * Where `specifier`, written in `fromFile`, lands under `src`, or null when it
 * is not a daemon module. `@remi/daemon` and its `exports` subpaths are mapped
 * through the package's own `exports` table, the way `license-boundary.test.ts`
 * maps `@remi/*`.
 */
function daemonTarget(specifier: string, fromFile: string): string | null {
  if (specifier.startsWith('.')) return relative(SRC, resolve(dirname(fromFile), specifier));
  const named = /^@remi\/daemon(\/.*)?$/.exec(specifier);
  if (!named) return null;
  const exported = DAEMON_PACKAGE.exports[`.${named[1] ?? ''}`];
  return exported ? relative(SRC, resolve(SRC, '..', exported)) : null;
}

/** The Claude-specific module `specifier` (written in `fromFile`) reaches; null if none. */
function forbiddenTarget(specifier: string, fromFile: string): string | null {
  const target = daemonTarget(specifier, fromFile);
  if (target === null) return null;
  const bare = stripExtension(target);
  const hit =
    FORBIDDEN_DIRS.some((dir) => bare === dir || bare.startsWith(`${dir}/`)) ||
    FORBIDDEN_FILES.some((file) => bare === file);
  if (!hit) return null;
  // `../hooks` means the directory's index; name what it resolves to.
  return FORBIDDEN_DIRS.some((dir) => bare === dir) ? `${bare}/index.ts` : target;
}

/** The distinct Claude-specific modules `source` imports. */
function offendersIn(fileName: string, source: string): string[] {
  const out = new Set<string>();
  for (const { text } of moduleSpecifiers(fileName, source)) {
    const target = forbiddenTarget(text, fileName);
    if (target) out.add(target);
  }
  return [...out];
}

/** The harness runtime modules `source` imports other than as a type. */
function harnessRuntimeImports(fileName: string, source: string): string[] {
  const out = new Set<string>();
  for (const { text, typeOnly } of moduleSpecifiers(fileName, source)) {
    if (typeOnly) continue;
    const target = daemonTarget(text, fileName);
    if (target === null) continue;
    const bare = stripExtension(target);
    if (HARNESS_RUNTIME.some((module) => bare === module)) out.add(`${bare}.ts`);
  }
  return [...out];
}

/** Every `.ts` file under `src`, as a path relative to it. */
function allSourceFiles(): string[] {
  return (readdirSync(SRC, { recursive: true }) as string[])
    .filter((entry) => /\.ts$/.test(entry))
    .map((entry) => entry.split(sep).join('/'));
}

function neutralFiles(): string[] {
  const fromDirs = NEUTRAL_DIRS.flatMap((dir) =>
    (readdirSync(join(SRC, dir), { recursive: true }) as string[])
      .filter((entry) => /\.ts$/.test(entry))
      .map((entry) => join(SRC, dir, entry)),
  );
  return [...fromDirs, ...NEUTRAL_FILES.map((file) => join(SRC, file))];
}

/** `<file> -> <module>` for every offence in the neutral modules. */
function currentOffences(): string[] {
  const offences: string[] = [];
  for (const file of neutralFiles()) {
    for (const target of offendersIn(file, readFileSync(file, 'utf8'))) {
      offences.push(`${relative(SRC, file)} -> ${target}`);
    }
  }
  return offences.sort();
}

describe('harness boundary detector (parses real import syntax only)', () => {
  const FROM = join(SRC, 'cli', 'handlers', 'some-handler.ts');

  test('flags every import form that reaches a Claude-specific module', () => {
    const cases: Record<string, string> = {
      'static import of hooks': `import { x } from '../../hooks/index.ts';`,
      'type-only import of auto-approve': `import type { T } from '../../auto-approve/index.ts';`,
      'import of a transcript file': `import { x } from '../../transcript/transcript-binder.ts';`,
      'export from transcript': `export * from '../../transcript/index.ts';`,
      'output processor': `import { OutputProcessor } from '../../parser/output-processor.ts';`,
      'question parser': `import { parseQuestion } from '../../parser/question-parser.ts';`,
      'status parser': `import { parseStatus } from '../../parser/status-parser.ts';`,
      'extensionless specifier': `import { x } from '../../parser/status-parser';`,
      'dynamic import': `const m = await import('../../hooks/hook-server.ts');`,
      'require call': `const m = require('../../transcript/index.ts');`,
      'type-position import': `type T = import('../../auto-approve/index.ts').Foo;`,
      'the harness barrel': `import { Harness } from '../../harness/index.ts';`,
      ClaudeHarness: `import { ClaudeHarness } from '../../harness/claude.ts';`,
      'the Claude launch': `import { createClaudeSession } from '../../harness/claude-session.ts';`,
      'the Claude transcript path leaf': `import { claudeTranscriptPath } from '../../harness/claude-transcript-path.ts';`,
      'the parser barrel': `import { parseQuestion } from '../../parser/index.ts';`,
      'the Claude session binding': `import { resolveClaudeBinding } from '../claude-binding.ts';`,
      'a session phase': `import { setupHookBridge } from '../session-phases/hook-bridge-setup.ts';`,
      'the daemon package root': `import { x } from '@remi/daemon';`,
      'a daemon package subpath': `import { parseQuestion } from '@remi/daemon/parser';`,
    };
    for (const [name, source] of Object.entries(cases)) {
      expect(offendersIn(FROM, source), name).toHaveLength(1);
    }
  });

  test('a directory import names the index it resolves to', () => {
    expect(offendersIn(FROM, `import { x } from '../../hooks';`)).toEqual(['hooks/index.ts']);
  });

  test('does not flag comments, string literals, or neutral imports', () => {
    const source = [
      `// import { x } from '../../hooks/index.ts';`,
      `/* const w = require('../../transcript/index.ts'); */`,
      `const note = "import x from '../../auto-approve/index.ts'";`,
      'const tpl = `await import("../../hooks/index.ts")`;',
      `import { a } from '@remi/shared';`,
      `import { b } from '../logger.ts';`,
      `import { c } from '../../harness/decision.ts';`,
      `import { d } from '../../parser/screen-menu.ts';`,
      `import { e } from '../../hooks-adjacent/index.ts';`,
      `import { f } from '../../session/index.ts';`,
      `import type { Harness } from '../../harness/types.ts';`,
      `import { g } from '@remi/daemon/pty';`,
      `import { h } from '@remi/daemon/unknown-subpath';`,
    ].join('\n');
    expect(offendersIn(FROM, source)).toEqual([]);
  });

  test('names what a package specifier resolves to', () => {
    expect(offendersIn(FROM, `import { x } from '@remi/daemon/parser';`)).toEqual([
      'parser/index.ts',
    ]);
    expect(offendersIn(FROM, `import { x } from '@remi/daemon';`)).toEqual(['index.ts']);
  });
});

describe('harness runtime import detector', () => {
  const FROM = join(SRC, 'cli', 'some-module.ts');

  test('flags a runtime import of each harness runtime module, and nothing else', () => {
    for (const module of ['index', 'claude', 'claude-session']) {
      expect(
        harnessRuntimeImports(FROM, `import { X } from '../harness/${module}.ts';`),
        module,
      ).toEqual([`harness/${module}.ts`]);
    }
    expect(harnessRuntimeImports(FROM, `const m = await import('../harness/index.ts');`)).toEqual([
      'harness/index.ts',
    ]);
    expect(harnessRuntimeImports(FROM, `import { X } from '@remi/daemon/pty';`)).toEqual([]);
  });

  test('type-only imports are erased, so they are not runtime imports', () => {
    const source = [
      `import type { Harness } from '../harness/index.ts';`,
      `export type { Harness } from '../harness/index.ts';`,
      `type T = import('../harness/claude.ts').ClaudeHarness;`,
      `import { Harness } from '../harness/types.ts';`,
    ].join('\n');
    expect(harnessRuntimeImports(FROM, source)).toEqual([]);
  });
});

describe('harness-neutral modules do not import Claude-specific modules', () => {
  test('the scan covers real files, so it is guarding something', () => {
    const files = neutralFiles();
    expect(files.length).toBeGreaterThan(30);
    for (const file of NEUTRAL_FILES) {
      expect(files).toContain(join(SRC, file));
    }
    for (const entry of DEBT) {
      const file = entry.split(' -> ')[0] as string;
      expect(files, entry).toContain(join(SRC, file));
    }
  });

  test('no neutral module imports a Claude-specific one beyond the documented debt', () => {
    const debt = new Set(DEBT);
    expect(currentOffences().filter((offence) => !debt.has(offence))).toEqual([]);
  });

  test('every debt entry is still an offence, so paying one down removes it', () => {
    const offences = new Set(currentOffences());
    expect(DEBT.filter((entry) => !offences.has(entry))).toEqual([]);
  });
});

describe('only cli.ts reaches the harness runtime modules at runtime', () => {
  test('no module outside harness/ imports harness/index, claude or claude-session except as a type', () => {
    const files = allSourceFiles();
    expect(files.length).toBeGreaterThan(150);
    // The rule is not vacuous: the one allowed importer really does import one.
    for (const importer of HARNESS_RUNTIME_IMPORTERS) {
      expect(
        harnessRuntimeImports(join(SRC, importer), readFileSync(join(SRC, importer), 'utf8')),
      ).not.toEqual([]);
    }
    const offences: string[] = [];
    for (const file of files) {
      if (
        file.startsWith('harness/') ||
        (HARNESS_RUNTIME_IMPORTERS as readonly string[]).includes(file)
      ) {
        continue;
      }
      for (const target of harnessRuntimeImports(
        join(SRC, file),
        readFileSync(join(SRC, file), 'utf8'),
      )) {
        offences.push(`${file} -> ${target}`);
      }
    }
    expect(offences).toEqual([]);
  });
});

/**
 * The one session phase a Codex file may reach (#1176): the neutral PTY spawn.
 * Everything else under `cli/session-phases/` (the hook bridge, the message-API
 * wiring) is Claude's or the shell's.
 */
const CODEX_ALLOWED_SESSION_PHASES = ['cli/session-phases/pty-session-setup.ts'] as const;

/** The modules under `cli/session-phases/` that `source` imports, as paths relative to `src`. */
function sessionPhaseImports(fileName: string, source: string): string[] {
  const out = new Set<string>();
  for (const { text } of moduleSpecifiers(fileName, source)) {
    const target = daemonTarget(text, fileName);
    if (target === null) continue;
    const bare = stripExtension(target);
    if (bare === 'cli/session-phases' || bare.startsWith('cli/session-phases/')) {
      out.add(bare === 'cli/session-phases' ? 'cli/session-phases/index.ts' : target);
    }
  }
  return [...out];
}

/** The session phases `source` imports other than the allowed neutral PTY spawn. */
function disallowedSessionPhases(fileName: string, source: string): string[] {
  const allowed: readonly string[] = CODEX_ALLOWED_SESSION_PHASES;
  return sessionPhaseImports(fileName, source).filter((target) => !allowed.includes(target));
}

describe('Codex files reach only the neutral PTY spawn under cli/session-phases', () => {
  const FROM = join(SRC, 'harness', 'codex', 'some-codex-file.ts');

  test('the detector names every session phase a file imports, in any import form', () => {
    expect(
      sessionPhaseImports(
        FROM,
        `import { s } from '../../cli/session-phases/pty-session-setup.ts';`,
      ),
    ).toEqual(['cli/session-phases/pty-session-setup.ts']);
    expect(
      sessionPhaseImports(
        FROM,
        `import { h } from '../../cli/session-phases/hook-bridge-setup.ts';`,
      ),
    ).toEqual(['cli/session-phases/hook-bridge-setup.ts']);
    expect(
      sessionPhaseImports(FROM, `import { m } from '../../cli/session-phases/message-api-setup';`),
    ).toEqual(['cli/session-phases/message-api-setup']);
    expect(sessionPhaseImports(FROM, `import { x } from '../../cli/session-phases';`)).toEqual([
      'cli/session-phases/index.ts',
    ]);
    expect(
      sessionPhaseImports(
        FROM,
        `const m = await import('../../cli/session-phases/hook-bridge-setup.ts');`,
      ),
    ).toEqual(['cli/session-phases/hook-bridge-setup.ts']);
  });

  test('the detector ignores everything that is not a session phase', () => {
    const source = [
      `// import { h } from '../../cli/session-phases/hook-bridge-setup.ts';`,
      `import { a } from '../../cli/logger.ts';`,
      `import { b } from '../../cli/session-phases-extra/x.ts';`,
      `import { c } from '@remi/shared';`,
    ].join('\n');
    expect(sessionPhaseImports(FROM, source)).toEqual([]);
  });

  test('the allowlist lets the PTY spawn through and flags every other session phase', () => {
    // The scan below finds nothing today, so it cannot tell a rule that
    // allows the right module from one that allows the wrong one; this can.
    expect(
      disallowedSessionPhases(
        FROM,
        `import { s } from '../../cli/session-phases/pty-session-setup.ts';`,
      ),
    ).toEqual([]);
    expect(
      disallowedSessionPhases(
        FROM,
        [
          `import { s } from '../../cli/session-phases/pty-session-setup.ts';`,
          `import { h } from '../../cli/session-phases/hook-bridge-setup.ts';`,
          `import { m } from '../../cli/session-phases/message-api-setup.ts';`,
        ].join('\n'),
      ),
    ).toEqual([
      'cli/session-phases/hook-bridge-setup.ts',
      'cli/session-phases/message-api-setup.ts',
    ]);
    expect(disallowedSessionPhases(FROM, `import { x } from '../../cli/session-phases';`)).toEqual([
      'cli/session-phases/index.ts',
    ]);
  });

  test('no file under harness/codex imports a session phase other than the allowed one', () => {
    const files = allSourceFiles().filter((file) => file.startsWith('harness/codex/'));
    // Not vacuous: there is at least one Codex file to hold to the rule.
    expect(files.length).toBeGreaterThan(0);
    const offences: string[] = [];
    for (const file of files) {
      for (const target of disallowedSessionPhases(
        join(SRC, file),
        readFileSync(join(SRC, file), 'utf8'),
      )) {
        offences.push(`${file} -> ${target}`);
      }
    }
    expect(offences).toEqual([]);
  });
});
