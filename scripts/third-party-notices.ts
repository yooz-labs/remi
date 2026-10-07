#!/usr/bin/env bun
/**
 * Third-party notices for what the `remi` binary bundles (#1131).
 *
 * The compiled binary bundles MIT and BSD-licensed packages whose licenses
 * require their notice to travel with redistributed copies. This builds the
 * daemon's bundle with a metafile, maps every input under node_modules to its
 * package, and writes each package's name, version, declared license and full
 * license file. The list is never hand-kept: it is whatever the bundle pulls
 * in. Generation fails, naming the package, when a bundled package has no
 * license file, so a new dependency cannot ship without its notice.
 *
 * Usage:
 *   bun scripts/third-party-notices.ts --out THIRD_PARTY_NOTICES [--version 1.2.3]
 *   bun scripts/third-party-notices.ts --check   (generate, write nothing; CI)
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DEFAULT_ENTRY = 'packages/daemon/src/cli.ts';
const LICENSE_FILE = /^(licen[cs]e|copying)(\.|$)/i;

export interface BundledPackage {
  readonly name: string;
  readonly version: string;
  /** The `license` field of its package.json, as declared. */
  readonly license: string;
  readonly licenseText: string;
}

/** The package an input path belongs to: the segment after its last `node_modules/`. */
export function packageRootOf(input: string): { name: string; root: string } | null {
  const marker = 'node_modules/';
  const at = input.lastIndexOf(marker);
  if (at < 0) return null;
  const rest = input.slice(at + marker.length).split('/');
  const first = rest[0] ?? '';
  if (first === '') return null;
  const name = first.startsWith('@') ? `${first}/${rest[1] ?? ''}` : first;
  return { name, root: input.slice(0, at + marker.length) + name };
}

function declaredLicense(pkg: Record<string, unknown>): string {
  const license = pkg['license'];
  if (typeof license === 'string') return license;
  if (
    license &&
    typeof license === 'object' &&
    typeof (license as { type?: unknown }).type === 'string'
  ) {
    return (license as { type: string }).type;
  }
  const licenses = pkg['licenses'];
  if (Array.isArray(licenses)) {
    return licenses
      .map((l) => (l && typeof l === 'object' ? String((l as { type?: unknown }).type ?? '') : ''))
      .filter(Boolean)
      .join(' OR ');
  }
  return 'UNKNOWN';
}

/**
 * The packages a bundle of `entry` (relative to `cwd`) pulls from
 * node_modules, sorted by name. Throws, naming every offender, when one has no
 * license file.
 */
export async function bundledPackages(
  entry: string = DEFAULT_ENTRY,
  cwd: string = process.cwd(),
): Promise<BundledPackage[]> {
  const out = mkdtempSync(join(tmpdir(), 'remi-notices-'));
  try {
    const metafile = join(out, 'meta.json');
    const proc = Bun.spawn(
      [
        process.execPath,
        'build',
        entry,
        '--target=bun',
        `--outdir=${join(out, 'bundle')}`,
        `--metafile=${metafile}`,
      ],
      { cwd, stdout: 'pipe', stderr: 'pipe' },
    );
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (code !== 0) throw new Error(`bun build ${entry} failed (exit ${code}): ${stderr.trim()}`);
    const meta = JSON.parse(readFileSync(metafile, 'utf8')) as { inputs: Record<string, unknown> };

    const roots = new Map<string, string>();
    for (const input of Object.keys(meta.inputs)) {
      const found = packageRootOf(input);
      if (found) roots.set(found.name, resolve(cwd, found.root));
    }

    const packages: BundledPackage[] = [];
    const missing: string[] = [];
    for (const [name, root] of roots) {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<
        string,
        unknown
      >;
      const version = typeof pkg['version'] === 'string' ? pkg['version'] : '0.0.0';
      const file = readdirSync(root).find((f) => LICENSE_FILE.test(f));
      if (file === undefined) {
        missing.push(`${name}@${version}`);
        continue;
      }
      packages.push({
        name,
        version,
        license: declaredLicense(pkg),
        licenseText: readFileSync(join(root, file), 'utf8').trim(),
      });
    }
    if (missing.length > 0) {
      throw new Error(
        `Bundled packages with no license file (their notice cannot be shipped): ${missing.sort().join(', ')}`,
      );
    }
    return packages.sort((a, b) => a.name.localeCompare(b.name));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** The THIRD_PARTY_NOTICES text for `packages`, shipped with remi `version`. */
export function renderNotices(packages: readonly BundledPackage[], version: string): string {
  const lines = [
    `Third-party notices for remi ${version}`,
    '',
    'The remi binary bundles the following packages. Each is listed with the',
    'license it declares and the full text of its license file.',
    '',
  ];
  for (const pkg of packages) {
    lines.push('-'.repeat(78), `${pkg.name}@${pkg.version}`, `License: ${pkg.license}`, '');
    lines.push(pkg.licenseText, '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const value = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const root = resolve(import.meta.dir, '..');
  const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    version: string;
  };
  try {
    const packages = await bundledPackages(value('--entry') ?? DEFAULT_ENTRY, root);
    const text = renderNotices(packages, value('--version') ?? rootPkg.version);
    if (args.includes('--check')) {
      console.log(
        `third-party notices: ${packages.length} bundled packages, every one with a license file`,
      );
    } else {
      const outFile = value('--out') ?? 'THIRD_PARTY_NOTICES';
      writeFileSync(outFile, text);
      console.log(`wrote ${outFile}: ${packages.length} bundled packages`);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
