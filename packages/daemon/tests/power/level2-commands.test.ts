import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  BOOT_DAEMON_LABEL,
  BOOT_DAEMON_PLIST,
  DISABLESLEEP_OFF,
  DISABLESLEEP_ON,
  IOREG_PATH,
  LAUNCHCTL_PATH,
  PLUTIL_PATH,
  PMSET_PATH,
  SETUP_STAGING_TEMPLATE,
  SH_PATH,
  SUDOERS_FILE,
  SUDO_PATH,
  WATCHDOG_LABEL,
  bootDaemonPlist,
  isSafeShortName,
  removalText,
  setupText,
  sudoArgv,
  sudoListArgv,
  sudoersLine,
  watchdogAgentPlistPath,
  watchdogLogPath,
  watchdogPlist,
  watchdogScriptPath,
} from '../../src/power/level2-commands.ts';
import { buildWatchdogScript, defaultRevertArgv } from '../../src/power/watchdog-script.ts';

const SRC = join(import.meta.dir, '..', '..', 'src');

/** Every `.ts` file under `dir`, recursively. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

/** The single-quoted words of one generated `sh` line. */
function quotedWords(line: string): string[] {
  return [...line.matchAll(/'([^']*)'/g)].map((match) => match[1] ?? '');
}

describe('one constant for each root-boundary command', () => {
  test('the sudoers line allows exactly the enable and the revert built from the constants', () => {
    const line = sudoersLine('owner');
    const prefix = 'owner ALL=(root) NOPASSWD: ';
    expect(line.startsWith(prefix)).toBe(true);
    const commands = line.slice(prefix.length).split(', ');
    expect(commands).toEqual([
      [PMSET_PATH, ...DISABLESLEEP_ON].join(' '),
      [PMSET_PATH, ...DISABLESLEEP_OFF].join(' '),
    ]);
    // ADR 0050 line 49, the exact line the owner installs.
    expect(line).toBe(
      'owner ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 1, /usr/bin/pmset -a disablesleep 0',
    );
  });

  test('the constants are frozen and the argument builders put pmset after sudo -n', () => {
    expect(Object.isFrozen(DISABLESLEEP_ON)).toBe(true);
    expect(Object.isFrozen(DISABLESLEEP_OFF)).toBe(true);
    expect(SUDO_PATH).toBe('/usr/bin/sudo');
    expect(PMSET_PATH).toBe('/usr/bin/pmset');
    expect(sudoArgv(DISABLESLEEP_OFF)).toEqual(['-n', '/usr/bin/pmset', '-a', 'disablesleep', '0']);
    expect(sudoArgv(DISABLESLEEP_ON)).toEqual(['-n', '/usr/bin/pmset', '-a', 'disablesleep', '1']);
    expect(sudoListArgv(DISABLESLEEP_ON)).toEqual([
      '-n',
      '-l',
      '/usr/bin/pmset',
      '-a',
      'disablesleep',
      '1',
    ]);
  });

  test("the boot daemon's program arguments are exactly pmset with the revert", () => {
    const plist = bootDaemonPlist();
    const programArguments = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(
      plist,
    )?.[1];
    expect(programArguments).toBeDefined();
    const strings = [...(programArguments ?? '').matchAll(/<string>([^<]*)<\/string>/g)].map(
      (match) => match[1],
    );
    expect(strings).toEqual([PMSET_PATH, ...DISABLESLEEP_OFF]);
    expect(plist).toContain(`<key>Label</key>\n\t<string>${BOOT_DAEMON_LABEL}</string>`);
    expect(plist).toContain('<key>RunAtLoad</key>\n\t<true/>');
    expect(plist).not.toContain('KeepAlive');
  });

  test("the production watchdog script's revert line runs exactly sudo -n pmset clearing the flag", () => {
    const script = buildWatchdogScript({ remiHome: '/private/tmp/remi-scan/home' });
    const lines = script.split('\n');
    const withSudo = lines.filter((line) => line.includes(SUDO_PATH));
    expect(withSudo).toHaveLength(1);
    const revertLine = withSudo[0] ?? '';
    expect(revertLine.trim().startsWith('run_bounded /dev/null ')).toBe(true);
    expect(lines[lines.indexOf(revertLine) - 1]).toBe('revert_action() {');
    expect(quotedWords(revertLine)).toEqual([
      SUDO_PATH,
      '-n',
      PMSET_PATH,
      '-a',
      'disablesleep',
      '0',
    ]);
    expect(quotedWords(revertLine)).toEqual(defaultRevertArgv());
    // The revert action is the only place the script names pmset, apart from the reader.
    expect(lines.filter((line) => line.includes(PMSET_PATH))).toEqual([
      `PMSET='${PMSET_PATH}'`,
      revertLine,
    ]);
  });

  test('only level2-commands.ts names sudo or the disablesleep keyword in the daemon source', () => {
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(100);
    for (const literal of ['/usr/bin/sudo', 'disablesleep']) {
      const holders = files
        .filter((file) => readFileSync(file, 'utf8').includes(literal))
        .map((file) => relative(SRC, file));
      expect({ literal, holders }).toEqual({ literal, holders: ['power/level2-commands.ts'] });
    }
  });
});

describe('the sudoers user name', () => {
  test('unsafe names are refused and sudoersLine throws for each', () => {
    const unsafe = [
      'root ALL',
      'a,b',
      'a b',
      'ALL',
      '',
      'a'.repeat(33),
      'owner\n',
      'own\ner',
      '1owner',
    ];
    for (const user of unsafe) {
      expect({ user, safe: isSafeShortName(user) }).toEqual({ user, safe: false });
      expect(() => sudoersLine(user)).toThrow();
    }
  });

  test('ordinary short names pass', () => {
    for (const user of ['owner', '_test-user', 'a'.repeat(32)]) {
      expect(isSafeShortName(user)).toBe(true);
      expect(sudoersLine(user).startsWith(`${user} ALL=(root) NOPASSWD: `)).toBe(true);
    }
  });
});

describe('the watchdog property list', () => {
  test('escapes every string and carries the label, the shell, the interval and the log', () => {
    const remiHome = '/private/tmp/a&b<c"d\'e>f';
    const plist = watchdogPlist({
      scriptPath: watchdogScriptPath(remiHome),
      intervalSeconds: 60,
      logPath: watchdogLogPath(remiHome),
    });
    expect(plist).toContain(`<string>${WATCHDOG_LABEL}</string>`);
    expect(plist).toContain(`<string>${SH_PATH}</string>`);
    expect(plist).toContain(
      '<string>/private/tmp/a&amp;b&lt;c&quot;d&apos;e&gt;f/keep-awake/watchdog.sh</string>',
    );
    expect(plist).toContain('<key>StartInterval</key>\n\t<integer>60</integer>');
    expect(plist).not.toContain('a&b');
    expect(plist).not.toContain('b<c');
  });

  test('refuses a relative path, a control character and a non-positive or fractional interval', () => {
    const base = { scriptPath: '/x/watchdog.sh', intervalSeconds: 60, logPath: '/x/watchdog.log' };
    expect(() => watchdogPlist({ ...base, scriptPath: 'watchdog.sh' })).toThrow();
    expect(() => watchdogPlist({ ...base, logPath: '/x/log\nfile' })).toThrow();
    for (const intervalSeconds of [0, -60, 1.5, Number.NaN]) {
      expect(() => watchdogPlist({ ...base, intervalSeconds })).toThrow();
    }
  });

  test('the agent property list lives under the user LaunchAgents directory', () => {
    expect(watchdogAgentPlistPath('/Users/someone')).toBe(
      `/Users/someone/Library/LaunchAgents/${WATCHDOG_LABEL}.plist`,
    );
  });
});

describe('the watchdog script quoting', () => {
  test('a remi home with &, < or " is embedded inside single quotes', () => {
    const script = buildWatchdogScript({ remiHome: '/private/tmp/a&b<c"d' });
    expect(script).toContain(`LEASE='/private/tmp/a&b<c"d/keep-awake/lease.json'`);
  });

  test('a single quote, a newline, a control character or a relative path is refused', () => {
    for (const remiHome of [
      "/private/tmp/it's",
      '/private/tmp/a\nb',
      '/tmp/a\u0007b',
      'rel/home',
    ]) {
      expect(() => buildWatchdogScript({ remiHome })).toThrow();
    }
  });
});

/** One parsed line of the setup text: a heredoc command carries its body. */
interface SetupCommand {
  line: string;
  heredoc?: string;
}

/**
 * Splits the setup text into prose, commands and here-document bodies. Prose
 * starts with a capital letter followed by a lower-case one, or with a step
 * number; every other non-blank line is a command.
 */
function parseSetup(text: string): SetupCommand[] {
  const lines = text.split('\n');
  const commands: SetupCommand[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    if (line === '' || /^(?:[A-Z][a-z]|\d+\. )/.test(line)) continue;
    const heredoc = /<<'([A-Z_]+)'$/.exec(line);
    if (!heredoc) {
      commands.push({ line });
      continue;
    }
    const end = lines.indexOf(heredoc[1] ?? '', index + 1);
    expect(end).toBeGreaterThan(index);
    commands.push({ line, heredoc: lines.slice(index + 1, end).join('\n') });
    index = end;
  }
  return commands;
}

describe('the printed setup', () => {
  const user = 'owner';
  const text = setupText({ user, remiHome: '/Users/owner/.remi' });
  const commands = parseSetup(text);

  test('contains the sudoers line verbatim', () => {
    expect(text).toContain(sudoersLine(user));
    expect(commands.find((command) => command.heredoc === sudoersLine(user))).toBeDefined();
    expect(
      commands.find((command) => command.heredoc === bootDaemonPlist().trimEnd()),
    ).toBeDefined();
  });

  test('stages every root file inside the root-made directory and installs only from there', () => {
    expect(commands[0]?.line).toBe(`D="$(sudo mktemp -d ${SETUP_STAGING_TEMPLATE})"`);
    const written = new Set<string>();
    const checked = new Set<string>();
    const installed: string[] = [];
    for (const { line } of commands.slice(1)) {
      const tee = /^sudo tee "\$D\/([^"/]+)" >\/dev\/null <<'[A-Z_]+'$/.exec(line);
      const check = /^sudo (?:visudo -cf|\/usr\/bin\/plutil -lint) "\$D\/([^"/]+)"$/.exec(line);
      const install = /^sudo install -m (?:0440|0644) -o root -g wheel "\$D\/([^"/]+)" (\S+)$/.exec(
        line,
      );
      if (tee) {
        written.add(tee[1] ?? '');
      } else if (check) {
        expect(written.has(check[1] ?? '')).toBe(true);
        checked.add(check[1] ?? '');
      } else if (install) {
        // Installed only after it was written there and checked there.
        expect(checked.has(install[1] ?? '')).toBe(true);
        installed.push(install[2] ?? '');
      } else {
        // Every other command writes no root content: it loads, removes the
        // staging directory, lists the rule, or prints an installed file.
        expect([
          `sudo ${LAUNCHCTL_PATH} bootstrap system ${BOOT_DAEMON_PLIST}`,
          'sudo rm -rf "$D"',
          `sudo ${sudoListArgv(DISABLESLEEP_ON).join(' ')}`,
          `sudo ${sudoListArgv(DISABLESLEEP_OFF).join(' ')}`,
          `sudo cat ${SUDOERS_FILE}`,
          `sudo ${PLUTIL_PATH} -p ${BOOT_DAEMON_PLIST}`,
        ]).toContain(line);
      }
    }
    expect(installed.sort()).toEqual([BOOT_DAEMON_PLIST, SUDOERS_FILE].sort());
    for (const { line } of commands) {
      // No redirection writes anywhere but /dev/null.
      expect(line.replaceAll('>/dev/null', '')).not.toContain('>');
    }
  });

  test('checks both the enable and the revert with sudo -n -l', () => {
    const lines = commands.map((command) => command.line);
    expect(lines).toContain('sudo -n -l /usr/bin/pmset -a disablesleep 1');
    expect(lines).toContain('sudo -n -l /usr/bin/pmset -a disablesleep 0');
  });

  test('explains why the rule must not be widened', () => {
    for (const word of ['hibernatefile', 'tcpkeepalive 0', 'schedule', 'autorestart']) {
      expect(text).toContain(word);
    }
    expect(text).toContain('restoredefaults');
  });

  test('refuses an unsafe user name and a relative remi home', () => {
    expect(() => setupText({ user: 'root ALL', remiHome: '/Users/owner/.remi' })).toThrow();
    expect(() => setupText({ user: 'owner', remiHome: '.remi' })).toThrow();
  });
});

describe('the printed removal', () => {
  test('starts with the stop and the flag check and ends with the owner clearing the flag', () => {
    const remiHome = '/Users/owner/my remi';
    const lines = removalText({ remiHome }).split('\n');
    expect(lines[0]).toBe("REMI_HOME='/Users/owner/my remi' remi keep-awake stop");
    expect(lines[1]).toBe(`${IOREG_PATH} -r -c IOPMrootDomain -d 1 | grep '"SleepDisabled"'`);
    expect(lines.at(-1)).toBe('sudo /usr/bin/pmset -a disablesleep 0');
    const order = [
      `sudo rm -f ${SUDOERS_FILE}`,
      `sudo ${LAUNCHCTL_PATH} bootout system/${BOOT_DAEMON_LABEL}`,
      `sudo rm -f ${BOOT_DAEMON_PLIST}`,
      `${LAUNCHCTL_PATH} bootout "gui/$(id -u)/${WATCHDOG_LABEL}"`,
      `rm -f "$HOME/Library/LaunchAgents/${WATCHDOG_LABEL}.plist" '/Users/owner/my remi/keep-awake/watchdog.sh'`,
    ].map((line) => lines.indexOf(line));
    expect(order.every((index) => index > 1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

if (process.platform !== 'darwin') {
  test.skip('macOS-only: plutil -lint of the generated property lists', () => {});
} else {
  describe('plutil accepts the generated property lists', () => {
    function plutil(args: string[]): { status: number | null; stdout: string } {
      const result = spawnSync(PLUTIL_PATH, args, { encoding: 'utf8', timeout: 10_000 });
      return { status: result.status, stdout: result.stdout };
    }

    test('both lint, and they read back with the exact values', () => {
      const dir = mkdtempSync(join(tmpdir(), 'remi-level2-plist-'));
      try {
        const remiHome = join(dir, 'a&b<c"d');
        const boot = join(dir, 'boot.plist');
        const agent = join(dir, 'watchdog.plist');
        writeFileSync(boot, bootDaemonPlist());
        writeFileSync(
          agent,
          watchdogPlist({
            scriptPath: watchdogScriptPath(remiHome),
            intervalSeconds: 60,
            logPath: watchdogLogPath(remiHome),
          }),
        );
        expect(statSync(boot).isFile()).toBe(true);
        for (const file of [boot, agent]) {
          const lint = plutil(['-lint', file]);
          expect(lint).toEqual({ status: 0, stdout: `${file}: OK\n` });
        }
        const bootJson = plutil(['-convert', 'json', '-o', '-', boot]);
        expect(bootJson.status).toBe(0);
        expect(JSON.parse(bootJson.stdout)).toEqual({
          Label: BOOT_DAEMON_LABEL,
          ProgramArguments: [PMSET_PATH, ...DISABLESLEEP_OFF],
          RunAtLoad: true,
        });
        const agentJson = plutil(['-convert', 'json', '-o', '-', agent]);
        expect(agentJson.status).toBe(0);
        expect(JSON.parse(agentJson.stdout)).toEqual({
          Label: WATCHDOG_LABEL,
          ProgramArguments: [SH_PATH, `${remiHome}/keep-awake/watchdog.sh`],
          StartInterval: 60,
          RunAtLoad: true,
          StandardOutPath: `${remiHome}/keep-awake/watchdog.log`,
          StandardErrorPath: `${remiHome}/keep-awake/watchdog.log`,
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}
