/**
 * Harness boundary ratchet (epic #1161, phase 3 #1164).
 *
 * The harness seam only holds while the harness-neutral modules stay free of
 * Claude's. This walks the neutral modules, parses each with the TypeScript
 * compiler (so comments and string literals can never match, the same scan as
 * `license-boundary.test.ts`), and fails when one imports a Claude-specific
 * module: anything under `hooks/`, `auto-approve/` or `transcript/`, or the
 * three Claude screen parsers (`parser/output-processor`,
 * `parser/question-parser`, `parser/status-parser`).
 *
 * Neutral modules: the harness contract (`harness/types.ts`,
 * `harness/decision.ts`), the client-message handlers (`cli/handlers/`), the
 * message API (`api/`) and the session store and registry (`session/`).
 * `harness/claude.ts`, `harness/claude-session.ts` and `harness/index.ts` are
 * deliberately not neutral: they are Claude's side of the seam.
 *
 * It is a ratchet, not a clean bill. `DEBT` lists the imports that exist
 * today and are documented as chat-seam debt: three handlers still take
 * Claude's transcript types because the chat path is not behind the seam yet.
 * A new offender fails the test, and so does a debt entry whose import has
 * been removed, so the list can only shrink.
 *
 * Known limit: a specifier computed at runtime is not checked, and neither is
 * a module that reaches a Claude module only through another neutral file's
 * re-export.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

const SRC = resolve(import.meta.dir, '..', '..', 'src');

/** Directories whose every `.ts` file is harness-neutral. */
const NEUTRAL_DIRS = ['cli/handlers', 'api', 'session'] as const;
/** Individual harness-neutral files. */
const NEUTRAL_FILES = ['harness/types.ts', 'harness/decision.ts'] as const;

/** Claude-specific directories, as paths relative to `src`. */
const FORBIDDEN_DIRS = ['hooks', 'auto-approve', 'transcript'] as const;
/** Claude-specific files, as paths relative to `src`, without extension. */
const FORBIDDEN_FILES = [
  'parser/output-processor',
  'parser/question-parser',
  'parser/status-parser',
] as const;

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

/** The Claude-specific module `specifier` (written in `fromFile`) reaches; null if none. */
function forbiddenTarget(specifier: string, fromFile: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const target = relative(SRC, resolve(dirname(fromFile), specifier));
  const bare = stripExtension(target);
  const hit =
    FORBIDDEN_DIRS.some((dir) => bare === dir || bare.startsWith(`${dir}/`)) ||
    FORBIDDEN_FILES.some((file) => bare === file);
  if (!hit) return null;
  // `../hooks` means the directory's index; name what it resolves to.
  return FORBIDDEN_DIRS.some((dir) => bare === dir) ? `${bare}/index.ts` : target;
}

function literalText(node: ts.Node | undefined): string | null {
  if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
    return node.text;
  }
  return null;
}

/** Every statically known module specifier in `source`, from real syntax only. */
function moduleSpecifiers(fileName: string, source: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const found: string[] = [];
  const add = (node: ts.Node | undefined) => {
    const text = literalText(node);
    if (text !== null) found.push(text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      add(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node)) {
      if (ts.isLiteralTypeNode(node.argument)) add(node.argument.literal);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      if (isDynamicImport || isRequire) add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** The distinct Claude-specific modules `source` imports. */
function offendersIn(fileName: string, source: string): string[] {
  const out = new Set<string>();
  for (const specifier of moduleSpecifiers(fileName, source)) {
    const target = forbiddenTarget(specifier, fileName);
    if (target) out.add(target);
  }
  return [...out];
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
    ].join('\n');
    expect(offendersIn(FROM, source)).toEqual([]);
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
