/**
 * The root boundary of keep-awake level 2 (ADR 0050 option A, #1773): every
 * command remi will run or print to change the machine-wide sleep flag, and the
 * texts that tell the owner how to install and remove the one sudoers rule and
 * the boot LaunchDaemon.
 *
 * This is the only module that names `sudo` or the `pmset` keyword for the
 * flag (a source-scan test keeps it that way). The printed texts and what remi
 * runs are built from the same constants, so they cannot drift apart.
 *
 * Nothing calls this module yet: no code runs `sudo`, installs a file, or
 * prints these texts. remi never installs the sudoers rule or the boot
 * LaunchDaemon; the owner does, from `setupText`.
 */

import * as path from 'node:path';
import { shellQuote } from '../session/shell-quote.ts';

export const SUDO_PATH = '/usr/bin/sudo';
export const PMSET_PATH = '/usr/bin/pmset';
export const IOREG_PATH = '/usr/sbin/ioreg';
export const PLUTIL_PATH = '/usr/bin/plutil';
export const PS_PATH = '/bin/ps';
export const DATE_PATH = '/bin/date';
export const LAUNCHCTL_PATH = '/bin/launchctl';
/** The shell the watchdog LaunchAgent runs its script with. */
export const SH_PATH = '/bin/sh';

/** `pmset` arguments that set the machine-wide sleep-disabled flag. */
export const DISABLESLEEP_ON = Object.freeze(['-a', 'disablesleep', '1'] as const);
/** `pmset` arguments that clear it: the revert every rail runs. */
export const DISABLESLEEP_OFF = Object.freeze(['-a', 'disablesleep', '0'] as const);

/** The `sudo` arguments that run `pmset` with `pmsetArgs`; `-n` fails instead of prompting. */
export function sudoArgv(pmsetArgs: readonly string[]): string[] {
  return ['-n', PMSET_PATH, ...pmsetArgs];
}

/**
 * The `sudo` arguments that only list whether the rule allows exactly that
 * `pmset` command; nothing runs as root.
 */
export function sudoListArgv(pmsetArgs: readonly string[]): string[] {
  return ['-n', '-l', PMSET_PATH, ...pmsetArgs];
}

export const SUDOERS_FILE = '/etc/sudoers.d/remi-keep-awake';
export const BOOT_DAEMON_LABEL = 'com.yooz.remi.keep-awake-boot';
export const BOOT_DAEMON_PLIST = '/Library/LaunchDaemons/com.yooz.remi.keep-awake-boot.plist';
export const WATCHDOG_LABEL = 'com.yooz.remi.keep-awake-watchdog';

/**
 * The template of the staging directory in the printed setup. Root creates it
 * (mode 0700) inside the sticky `/private/tmp`, where no other user, the owner
 * included, can rename or replace an entry root owns. A bare `mktemp -d` would
 * use `TMPDIR` if sudo kept it, whose parent the owner can write.
 */
export const SETUP_STAGING_TEMPLATE = '/private/tmp/remi-keep-awake.XXXXXX';

/** The keep-awake state directory of a remi home: the lease, the watchdog script and its log. */
export function keepAwakeDir(remiHome: string): string {
  return path.join(remiHome, 'keep-awake');
}

/** Where the watchdog script lives; the watchdog LaunchAgent runs it with `SH_PATH`. */
export function watchdogScriptPath(remiHome: string): string {
  return path.join(keepAwakeDir(remiHome), 'watchdog.sh');
}

/** Where the watchdog LaunchAgent sends the script's output. */
export function watchdogLogPath(remiHome: string): string {
  return path.join(keepAwakeDir(remiHome), 'watchdog.log');
}

/** Where the watchdog LaunchAgent's property list lives for the user whose home is `home`. */
export function watchdogAgentPlistPath(home: string): string {
  return path.join(home, 'Library', 'LaunchAgents', `${WATCHDOG_LABEL}.plist`);
}

/**
 * `value` when it is a positive integer, `fallback` when it is undefined;
 * throws otherwise. Every number in the level 2 modules is an option with an
 * exported default (owner rule); none has a maximum.
 */
export function positiveIntegerOption(
  name: string,
  value: number | undefined,
  fallback: number,
): number {
  const chosen = value ?? fallback;
  if (!Number.isSafeInteger(chosen) || chosen < 1) {
    throw new Error(`${name} must be a positive integer: ${chosen}`);
  }
  return chosen;
}

/** `isSafeShortName` `maxLength`: the longest user name written into the sudoers line. */
export const DEFAULT_SUDOERS_USER_MAX_LENGTH = 32;

/**
 * A macOS short user name that is safe to write into a sudoers line: the fixed
 * character class `^[a-z_][a-z0-9_-]*$` (which keeps spaces, commas, `ALL` and
 * every other sudoers syntax out at any length) and from 1 to `maxLength`
 * characters. Throws for a non-positive `maxLength`.
 */
export function isSafeShortName(
  user: string,
  options: { maxLength?: number | undefined } = {},
): boolean {
  const maxLength = positiveIntegerOption(
    'maxLength',
    options.maxLength,
    DEFAULT_SUDOERS_USER_MAX_LENGTH,
  );
  return user.length <= maxLength && /^[a-z_][a-z0-9_-]*$/.test(user);
}

/** The one sudoers line, for `user`; it allows exactly the enable and the revert. */
export function sudoersLine(
  user: string,
  options: { maxLength?: number | undefined } = {},
): string {
  if (!isSafeShortName(user, options)) {
    throw new Error(`not a safe user name for a sudoers line: ${JSON.stringify(user)}`);
  }
  const enable = [PMSET_PATH, ...DISABLESLEEP_ON].join(' ');
  const revert = [PMSET_PATH, ...DISABLESLEEP_OFF].join(' ');
  return `${user} ALL=(root) NOPASSWD: ${enable}, ${revert}`;
}

type PlistValue = string | number | boolean | readonly string[];

function xmlEscape(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** Throws unless `text` has no control character (XML 1.0 cannot carry most of them). */
function assertNoControlCharacters(what: string, text: string): void {
  if (/[\u0000-\u001f\u007f]/.test(text)) {
    throw new Error(`${what} contains a control character`);
  }
}

function assertAbsolutePath(what: string, value: string): void {
  if (!path.isAbsolute(value)) throw new Error(`${what} must be an absolute path: ${value}`);
  assertNoControlCharacters(what, value);
}

function plistValue(value: PlistValue, indent: string): string[] {
  if (typeof value === 'string') return [`${indent}<string>${xmlEscape(value)}</string>`];
  if (typeof value === 'boolean') return [`${indent}<${value ? 'true' : 'false'}/>`];
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`not an integer: ${value}`);
    return [`${indent}<integer>${value}</integer>`];
  }
  return [
    `${indent}<array>`,
    ...value.map((item) => `${indent}\t<string>${xmlEscape(item)}</string>`),
    `${indent}</array>`,
  ];
}

function renderPlist(entries: ReadonlyArray<readonly [string, PlistValue]>): string {
  const body = entries.flatMap(([key, value]) => [
    `\t<key>${xmlEscape(key)}</key>`,
    ...plistValue(value, '\t'),
  ]);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    ...body,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/**
 * The boot LaunchDaemon (owner decision 1): Apple's `pmset` clearing the flag
 * once at boot, before any login. No input, no remi code as root, no
 * `KeepAlive`.
 */
export function bootDaemonPlist(): string {
  return renderPlist([
    ['Label', BOOT_DAEMON_LABEL],
    ['ProgramArguments', [PMSET_PATH, ...DISABLESLEEP_OFF]],
    ['RunAtLoad', true],
  ]);
}

/** The watchdog's user LaunchAgent: runs the generated script every `intervalSeconds`. */
export function watchdogPlist(options: {
  scriptPath: string;
  intervalSeconds: number;
  logPath: string;
}): string {
  const { scriptPath, intervalSeconds, logPath } = options;
  assertAbsolutePath('the watchdog script path', scriptPath);
  assertAbsolutePath('the watchdog log path', logPath);
  if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds < 1) {
    throw new Error(`the watchdog interval must be a positive integer: ${intervalSeconds}`);
  }
  return renderPlist([
    ['Label', WATCHDOG_LABEL],
    ['ProgramArguments', [SH_PATH, scriptPath]],
    ['StartInterval', intervalSeconds],
    ['RunAtLoad', true],
    ['StandardOutPath', logPath],
    ['StandardErrorPath', logPath],
  ]);
}

const SUDOERS_STAGED = path.basename(SUDOERS_FILE);
const BOOT_STAGED = 'boot.plist';

function assertRemiHome(remiHome: string): void {
  assertAbsolutePath('the remi home', remiHome);
}

/**
 * What the owner runs, by hand, to install the boot LaunchDaemon and then the
 * sudoers rule. Printing it runs nothing. Root content is written only into a
 * directory root creates (mode 0700), and each file is checked and installed
 * from there in one `&&` chain, so a failed check installs nothing and no
 * process of the owner's account can swap a file between the check and the
 * install. Throws for an unsafe user name (with `userMaxLength`, default
 * `DEFAULT_SUDOERS_USER_MAX_LENGTH`) or a remi home that is not an absolute path.
 */
export function setupText(options: {
  user: string;
  remiHome: string;
  userMaxLength?: number | undefined;
}): string {
  const { user, remiHome } = options;
  assertRemiHome(remiHome);
  const rule = sudoersLine(user, { maxLength: options.userMaxLength });
  const bootPlist = bootDaemonPlist().trimEnd();
  // `${D:?}` stops the command when D is empty (a failed mktemp line), so a
  // staged path never falls back to the root directory.
  const staged = (name: string) => `"\${D:?}/${name}"`;
  const enable = [PMSET_PATH, ...DISABLESLEEP_ON].join(' ');
  const revert = [PMSET_PATH, ...DISABLESLEEP_OFF].join(' ');
  return [
    `Keep-awake level 2 setup for the user ${JSON.stringify(user)} (remi home ${JSON.stringify(remiHome)}).`,
    'None of these commands is run by remi. Run them yourself in Terminal, in this order; sudo asks for your password.',
    'Root content is written only into a directory that root creates and only root can write, and each file is checked and installed from there in one chained command, so a failed check installs nothing.',
    'If any step fails or prints something other than what it says to expect, stop and run the removal steps at the end of this text.',
    '',
    SETUP_EXPOSURE_TEXT,
    '',
    '1. Create the staging directory (owned by root, mode 0700):',
    '',
    `D="$(sudo mktemp -d ${SETUP_STAGING_TEMPLATE})"`,
    '',
    '2. Install the boot LaunchDaemon first: it clears the flag at every boot, so it is in place before the rule that lets anything set the flag.',
    'Write it there. On a re-run, unload the old one (on a first install the bootout line reports that the service is not loaded, which is expected). Then check, install and load it in one chained command; loading runs it once, which only clears the flag:',
    '',
    `sudo tee ${staged(BOOT_STAGED)} >/dev/null <<'REMI_PLIST'`,
    bootPlist,
    'REMI_PLIST',
    `sudo ${LAUNCHCTL_PATH} bootout system/${BOOT_DAEMON_LABEL}`,
    `sudo ${PLUTIL_PATH} -lint ${staged(BOOT_STAGED)} && sudo install -m 0644 -o root -g wheel ${staged(BOOT_STAGED)} ${BOOT_DAEMON_PLIST} && sudo ${LAUNCHCTL_PATH} bootstrap system ${BOOT_DAEMON_PLIST}`,
    '',
    '3. Write the sudoers rule there, then check and install it in one chained command, which installs nothing unless the boot daemon of step 2 is loaded. visudo must print "parsed OK"; if it prints anything else, stop and run the removal steps:',
    '',
    `sudo tee ${staged(SUDOERS_STAGED)} >/dev/null <<'REMI_SUDOERS'`,
    rule,
    'REMI_SUDOERS',
    `sudo ${LAUNCHCTL_PATH} print system/${BOOT_DAEMON_LABEL} >/dev/null && sudo visudo -cf ${staged(SUDOERS_STAGED)} && sudo install -m 0440 -o root -g wheel ${staged(SUDOERS_STAGED)} ${SUDOERS_FILE}`,
    '',
    '4. Remove the staging directory:',
    '',
    'sudo rm -rf "${D:?}"',
    '',
    `5. Check the rule. sudo -k makes sudo forget your password, so the commands after it cannot reuse it. sudo -n -l must list "(root) NOPASSWD: ${enable}, ${revert}" (next to any rules you already had), and each of the next two must print the pmset command it names. The last command runs the revert, which only clears the flag, and must finish without asking for a password: that shows the rule needs none. These checks do not run the enable (it would set the flag) and show nothing about the lid or the battery. A rule that allows the enable but not the revert must never stay in place: if any check fails, run the removal steps.`,
    '',
    'sudo -k',
    'sudo -n -l',
    `sudo ${sudoListArgv(DISABLESLEEP_ON).join(' ')}`,
    `sudo ${sudoListArgv(DISABLESLEEP_OFF).join(' ')}`,
    'sudo -k',
    `sudo ${sudoArgv(DISABLESLEEP_OFF).join(' ')}`,
    '',
    '6. Show the installed files and the loaded boot daemon, and compare them with docs/agent-reference/keep-awake.md:',
    '',
    `sudo cat ${SUDOERS_FILE}`,
    `sudo ${PLUTIL_PATH} -p ${BOOT_DAEMON_PLIST}`,
    `sudo ${LAUNCHCTL_PATH} print system/${BOOT_DAEMON_LABEL}`,
    '',
    `Do not widen the rule. sudoers matches listed arguments exactly, so the line above allows only these two commands; a rule naming ${PMSET_PATH} with no arguments would let any process of your account run pmset as root with any arguments, among them hibernatefile (which points hibernation at a chosen file), tcpkeepalive 0 (which breaks Find My Mac), schedule, autorestart and restoredefaults.`,
    '',
    SETUP_REMOVAL_HEADING,
    '',
    removalText({ remiHome }),
    '',
  ].join('\n');
}

/** The heading in front of the removal steps at the end of the setup text. */
export const SETUP_REMOVAL_HEADING = 'If any step failed, run these removal steps:';

/** What the installed rule exposes, said in the setup text and in keep-awake.md. */
export const SETUP_EXPOSURE_TEXT =
  "Once the rule is installed, any process running as you, including coding agents started by remi, can keep this Mac awake with the lid closed, without a lease or a battery limit; remi's lease and watchdog are crash safety, not a barrier. The rule grants no root access beyond these two pmset commands.";

/**
 * How the owner removes everything level 2 installed. It starts by stopping
 * level 2 and checking that the flag reads No, and it ends with the owner's own
 * revert, which only clears the flag.
 */
export function removalText(options: { remiHome: string }): string {
  const { remiHome } = options;
  assertRemiHome(remiHome);
  const userDomain = '"gui/$(id -u)/';
  return [
    `REMI_HOME=${shellQuote(remiHome)} remi keep-awake stop`,
    `${IOREG_PATH} -r -c IOPMrootDomain -d 1 | grep '"SleepDisabled"'`,
    '',
    'The second command must print "SleepDisabled" = No. If it prints Yes, level 2 is still on: the last command below clears the flag.',
    '',
    'Remove the sudoers rule, then the boot LaunchDaemon:',
    '',
    `sudo rm -f ${SUDOERS_FILE}`,
    `sudo ${LAUNCHCTL_PATH} bootout system/${BOOT_DAEMON_LABEL}`,
    `sudo rm -f ${BOOT_DAEMON_PLIST}`,
    '',
    'Remove the watchdog agent and its script:',
    '',
    `${LAUNCHCTL_PATH} bootout ${userDomain}${WATCHDOG_LABEL}"`,
    `rm -f "$HOME/Library/LaunchAgents/${WATCHDOG_LABEL}.plist" ${shellQuote(watchdogScriptPath(remiHome))}`,
    '',
    'Last, clear the flag yourself (the rule is gone, so sudo asks for your password; this only clears the flag):',
    '',
    `sudo ${[PMSET_PATH, ...DISABLESLEEP_OFF].join(' ')}`,
  ].join('\n');
}
