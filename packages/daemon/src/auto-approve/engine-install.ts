/**
 * Obtaining the engine helper (#834).
 *
 * #818 taught remi to START a helper and #297 built one, but nothing put the
 * binary on a user's machine — so `engine_path` was unset by default and
 * auto-approve degraded to escalate-everything on a fresh install. This module
 * closes that: remi fetches the helper itself, once, and caches it.
 *
 * **Fetch rather than bundle**, for two reasons that both matter:
 *
 *   - remi releases on every merge; the engine changes rarely. Bundling would
 *     re-download an unchanged ~30 MB helper on every remi patch, and would put
 *     a macOS-only payload into the Linux and Intel artifacts as well.
 *   - The engine's release pipeline signs each `.app` and archives it with
 *     `ditto` specifically because `zip` corrupts the code signature on nested
 *     bundles. Fetching that artifact byte-for-byte preserves the signature and
 *     notarization; repacking it through npm or Homebrew is exactly how
 *     Gatekeeper breakage is introduced — and it surfaces to a user as "the
 *     engine never answered", which points nowhere near the cause.
 *
 * Everything here is best-effort and reversible. A failed install leaves
 * auto-approve escalating, which is the behavior without this module at all.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { errorToString } from '@remi/shared';

const REMI_DIR = path.join(os.homedir(), '.remi');

/** Where fetched helpers live, one directory per engine release. Versioned so
 *  an upgrade never overwrites a helper a running engine was launched from. */
export const ENGINE_INSTALL_ROOT = path.join(REMI_DIR, 'engine');

/**
 * The engine release remi fetches its helper from.
 *
 * Pinned rather than "latest" on purpose: a daemon that silently picks up a new
 * engine build is a daemon whose behavior changed without anyone choosing it,
 * and the model contract (the catalogue, the alias resolution) is a property of
 * a specific engine version. Bumping this is a deliberate, reviewable commit.
 *
 * 0.7.8 is the first release whose model listings report each model's
 * registered HuggingFace repo id (yooz-engine#308). remi degrades honestly
 * against an older one — it says it cannot correlate rather than guessing —
 * but only from 0.7.8 can it name models the way a user recognizes them.
 */
export const ENGINE_RELEASE = {
  repo: 'yooz-labs/yooz-engine',
  /** Release tag carrying `YoozEngineLLM.app.zip` (yooz-engine#311). */
  tag: 'v0.7.8',
  asset: 'YoozEngineLLM.app.zip',
  /** Bundle directory inside the archive, and the executable within it. */
  appDir: 'YoozEngineLLM.app',
  binary: 'Yooz Engine (LLM)',
} as const;

/** The pinned engine version, without the tag's leading `v`. */
export const PINNED_ENGINE_VERSION = ENGINE_RELEASE.tag.replace(/^v/, '');

/** `[major, minor, patch]`, or undefined when the string is not a semver core.
 *  Any prerelease suffix is dropped: `0.7.8-dev.1` compares as `0.7.8`, which
 *  is what "does this build have the 0.7.8 features?" actually asks. */
function semverParts(version: string): [number, number, number] | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version.replace(/^v/, ''));
  if (m === null) return undefined;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Is `version` older than the helper remi pins?
 *
 * Three-way on purpose. `undefined` means "cannot tell" — an unparsable or
 * absent version must not be reported as either current or stale, because both
 * are claims about the user's machine that we would be making up.
 */
export function isOlderThanPinned(version: string | undefined): boolean | undefined {
  if (version === undefined) return undefined;
  const running = semverParts(version);
  const pinned = semverParts(PINNED_ENGINE_VERSION);
  if (running === undefined || pinned === undefined) return undefined;
  // Destructured rather than indexed in a loop: under `noUncheckedIndexedAccess`
  // a variable index widens each element to `number | undefined`, which this
  // comparison must not have to reason about.
  const [rMajor, rMinor, rPatch] = running;
  const [pMajor, pMinor, pPatch] = pinned;
  if (rMajor !== pMajor) return rMajor < pMajor;
  if (rMinor !== pMinor) return rMinor < pMinor;
  return rPatch < pPatch;
}

/** Absolute path the pinned release installs to. */
export function installedHelperPath(root: string = ENGINE_INSTALL_ROOT): string {
  return path.join(
    root,
    ENGINE_RELEASE.tag,
    ENGINE_RELEASE.appDir,
    'Contents',
    'MacOS',
    ENGINE_RELEASE.binary,
  );
}

/**
 * The helper remi should launch, or undefined when there is none yet.
 *
 * Explicit config wins: someone pointing `engine_path` at their own build is
 * making a deliberate choice and must not be second-guessed by a download.
 */
export function resolveHelperPath(
  configuredPath: string,
  root: string = ENGINE_INSTALL_ROOT,
): string | undefined {
  if (configuredPath.length > 0) return configuredPath;
  const installed = installedHelperPath(root);
  return fs.existsSync(installed) ? installed : undefined;
}

/** Only Apple Silicon can run this helper — it is MLX. Anywhere else, fetching
 *  30 MB that cannot execute would be worse than doing nothing. */
export function canInstallHelper(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): boolean {
  return platform === 'darwin' && arch === 'arm64';
}

export interface InstallDeps {
  readonly log: (msg: string) => void;
  /** Seam for tests; the real one streams the release asset to disk. */
  readonly download?: (url: string, dest: string) => Promise<void>;
  readonly root?: string;
}

/**
 * Fetch and unpack the pinned helper, unless it is already there.
 *
 * Returns the executable path, or undefined when it could not be obtained —
 * never throws, because a missing helper must degrade to "auto-approve
 * escalates", not to a broken daemon.
 */
export async function ensureHelperInstalled(deps: InstallDeps): Promise<string | undefined> {
  const root = deps.root ?? ENGINE_INSTALL_ROOT;
  const target = installedHelperPath(root);
  // Already installed: this is the common path on every boot after the first,
  // and it must cost one `stat` rather than a network call.
  if (fs.existsSync(target)) return target;

  if (!canInstallHelper()) return undefined;

  const versionDir = path.join(root, ENGINE_RELEASE.tag);
  const url = `https://github.com/${ENGINE_RELEASE.repo}/releases/download/${ENGINE_RELEASE.tag}/${ENGINE_RELEASE.asset}`;
  const archive = path.join(versionDir, ENGINE_RELEASE.asset);

  try {
    fs.mkdirSync(versionDir, { recursive: true });
    deps.log(`[Engine] Fetching the engine helper (${ENGINE_RELEASE.tag}, ~30 MB)`);
    const download = deps.download ?? downloadFile;
    await download(url, archive);

    // `ditto -x -k` is the counterpart of the `ditto -c -k` the engine's
    // release pipeline archives with. Using `unzip` here would strip the code
    // signature from the nested bundles and the helper would fail Gatekeeper.
    const extract = spawnSync('/usr/bin/ditto', ['-x', '-k', archive, versionDir], {
      stdio: 'ignore',
    });
    if (extract.status !== 0) {
      throw new Error(`ditto exited ${extract.status ?? 'unknown'}`);
    }
    // The archive is disposable once expanded; keeping it doubles the footprint
    // of something a user did not ask to store.
    fs.rmSync(archive, { force: true });

    if (!fs.existsSync(target)) {
      throw new Error(`archive did not contain ${ENGINE_RELEASE.appDir}`);
    }
    deps.log(`[Engine] Installed the engine helper to ${versionDir}`);
    return target;
  } catch (err) {
    // Leave nothing half-unpacked: a partial bundle would be found by
    // `resolveHelperPath` on the next boot and launched as if it were whole.
    fs.rmSync(versionDir, { recursive: true, force: true });
    deps.log(
      `[Engine] Could not install the engine helper (auto-approve will escalate until it is present): ${errorToString(err)}`,
    );
    return undefined;
  }
}

/** Stream a release asset to disk. GitHub redirects release downloads, which
 *  `fetch` follows by default. */
async function downloadFile(url: string, dest: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} -> ${response.status}`);
  }
  const buffer = new Uint8Array(await response.arrayBuffer());
  // Written whole rather than streamed: 30 MB is small enough that the
  // simplicity is worth more than the memory, and a partial file on disk is a
  // worse failure than a brief allocation.
  fs.writeFileSync(dest, buffer);
}
