#!/usr/bin/env bun
/**
 * Sync the iOS app's version into the Xcode project from the app's OWN version
 * line (config/app-release.json), decoupled from the daemon/npm version (#658).
 *
 * The iOS Info.plist reads $(MARKETING_VERSION) / $(CURRENT_PROJECT_VERSION), so
 * only the pbxproj build settings need writing (both Debug + Release configs).
 *
 * Usage:
 *   bun scripts/sync-app-version.mjs                  # stamp pbxproj from config
 *   bun scripts/sync-app-version.mjs --bump-build     # buildNumber++ in config, then stamp
 *   bun scripts/sync-app-version.mjs --build 42       # one-off build-number override
 *   bun scripts/sync-app-version.mjs --marketing 0.2.0
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = join(ROOT, 'config', 'app-release.json');
const PBXPROJ_PATH = join(
  ROOT,
  'packages',
  'web',
  'ios',
  'App',
  'App.xcodeproj',
  'project.pbxproj',
);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--build') out.build = argv[++i];
    else if (argv[i] === '--marketing') out.marketing = argv[++i];
    else if (argv[i] === '--bump-build') out.bumpBuild = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));

// --bump-build increments the source-of-truth build number and persists it, so
// every TestFlight upload gets a fresh CFBundleVersion (App Store Connect rejects
// duplicates). Done before stamping so the new value flows into the pbxproj.
if (args.bumpBuild) {
  config.buildNumber = Number(config.buildNumber) + 1;
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
  console.log(
    `sync-app-version: bumped buildNumber -> ${config.buildNumber} in config/app-release.json`,
  );
}

const marketing = String(args.marketing ?? config.marketingVersion);
const build = String(args.build ?? config.buildNumber);

if (!/^\d+\.\d+\.\d+$/.test(marketing)) {
  console.error(`sync-app-version: invalid marketingVersion "${marketing}" (want X.Y.Z)`);
  process.exit(1);
}
if (!/^\d+$/.test(build)) {
  console.error(`sync-app-version: invalid build number "${build}" (want an integer)`);
  process.exit(1);
}

const before = readFileSync(PBXPROJ_PATH, 'utf8');
const after = before
  .replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${marketing};`)
  .replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${build};`);

// Verify the target values actually landed, not just that the keys exist: if the
// pbxproj format ever drifts the replace could match nothing while a key-presence
// check still passes, silently shipping the wrong version. Idempotent (an
// already-stamped file still contains the targets).
if (
  !after.includes(`MARKETING_VERSION = ${marketing};`) ||
  !after.includes(`CURRENT_PROJECT_VERSION = ${build};`)
) {
  console.error(
    `sync-app-version: could not stamp ${marketing}/${build} into the pbxproj (MARKETING_VERSION/CURRENT_PROJECT_VERSION missing or unexpected format)`,
  );
  process.exit(1);
}

if (after !== before) {
  writeFileSync(PBXPROJ_PATH, after);
  console.log(`sync-app-version: stamped iOS app -> ${marketing} (build ${build})`);
} else {
  console.log(`sync-app-version: iOS app already at ${marketing} (build ${build}), no change`);
}
