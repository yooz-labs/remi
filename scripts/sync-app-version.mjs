#!/usr/bin/env bun
/**
 * Sync the app suite's version into the Xcode projects from the app's OWN
 * version line (config/app-release.json), decoupled from the daemon/npm
 * version (#658). ONE shared marketingVersion/buildNumber for iOS + macOS:
 * App Store Connect build trains are per-platform, so burning a number on
 * the other platform's train is harmless, and one line is simpler.
 *
 * Both Info.plists read $(MARKETING_VERSION) / $(CURRENT_PROJECT_VERSION), so
 * only pbxproj build settings need writing (both Debug + Release configs).
 *
 * NOTE (macOS): `scripts/generate-macos-project.sh` regenerates the macOS
 * pbxproj from project.yml, which resets these settings to the yml literals —
 * that script re-runs this one afterwards, so always regenerate through it.
 *
 * Usage:
 *   bun scripts/sync-app-version.mjs                  # stamp pbxprojs from config
 *   bun scripts/sync-app-version.mjs --bump-build     # buildNumber++ in config, then stamp
 *   bun scripts/sync-app-version.mjs --build 42       # one-off build-number override
 *   bun scripts/sync-app-version.mjs --marketing 0.2.0
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = join(ROOT, 'config', 'app-release.json');
const PBXPROJS = [
  {
    label: 'iOS app',
    path: join(ROOT, 'packages', 'web', 'ios', 'App', 'App.xcodeproj', 'project.pbxproj'),
  },
  {
    label: 'macOS app',
    path: join(ROOT, 'packages', 'macos', 'Remi.xcodeproj', 'project.pbxproj'),
  },
];

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

// Validate everything that can abort BEFORE mutating config on disk, so a bad
// input never leaves config/app-release.json corrupted or burns a build number.
const marketing = String(args.marketing ?? config.marketingVersion);
if (!/^\d+\.\d+\.\d+$/.test(marketing)) {
  console.error(`sync-app-version: invalid marketingVersion "${marketing}" (want X.Y.Z)`);
  process.exit(1);
}

// --bump-build increments the source-of-truth build number and persists it, so
// every TestFlight upload gets a fresh CFBundleVersion (App Store Connect rejects
// duplicates). Guard the existing value so Number(undefined)+1 = NaN can't write
// `"buildNumber": null` to the config.
if (args.bumpBuild) {
  const current = Number(config.buildNumber);
  if (!Number.isInteger(current) || current < 0) {
    console.error(
      `sync-app-version: config buildNumber is not a non-negative integer: ${JSON.stringify(config.buildNumber)}`,
    );
    process.exit(1);
  }
  config.buildNumber = current + 1;
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
  console.log(
    `sync-app-version: bumped buildNumber -> ${config.buildNumber} in config/app-release.json`,
  );
}

const build = String(args.build ?? config.buildNumber);
if (!/^\d+$/.test(build)) {
  console.error(`sync-app-version: invalid build number "${build}" (want an integer)`);
  process.exit(1);
}

for (const { label, path } of PBXPROJS) {
  const before = readFileSync(path, 'utf8');
  const after = before
    .replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${marketing};`)
    .replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${build};`);

  // Verify the target values actually landed, not just that the keys exist: if
  // the pbxproj format ever drifts the replace could match nothing while a
  // key-presence check still passes, silently shipping the wrong version.
  // Idempotent (an already-stamped file still contains the targets).
  if (
    !after.includes(`MARKETING_VERSION = ${marketing};`) ||
    !after.includes(`CURRENT_PROJECT_VERSION = ${build};`)
  ) {
    console.error(
      `sync-app-version: could not stamp ${marketing}/${build} into the ${label} pbxproj (MARKETING_VERSION/CURRENT_PROJECT_VERSION missing or unexpected format)`,
    );
    process.exit(1);
  }

  if (after !== before) {
    writeFileSync(path, after);
    console.log(`sync-app-version: stamped ${label} -> ${marketing} (build ${build})`);
  } else {
    console.log(`sync-app-version: ${label} already at ${marketing} (build ${build}), no change`);
  }
}
