#!/usr/bin/env bun
/**
 * Sync the iOS app's version into the Xcode project from the app's OWN version
 * line (config/app-release.json), decoupled from the daemon/npm version (#658).
 *
 * The iOS Info.plist reads $(MARKETING_VERSION) / $(CURRENT_PROJECT_VERSION), so
 * only the pbxproj build settings need writing (both Debug + Release configs).
 *
 * Usage:
 *   bun scripts/sync-app-version.mjs                  # from config
 *   bun scripts/sync-app-version.mjs --build 42       # override build number (Xcode Cloud CI_BUILD_NUMBER)
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
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
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

if (!/MARKETING_VERSION = /.test(before) || !/CURRENT_PROJECT_VERSION = /.test(before)) {
  console.error('sync-app-version: MARKETING_VERSION/CURRENT_PROJECT_VERSION not found in pbxproj');
  process.exit(1);
}

if (after !== before) writeFileSync(PBXPROJ_PATH, after);
console.log(`sync-app-version: iOS app set to ${marketing} (build ${build})`);
