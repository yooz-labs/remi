import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PROFILE_USAGE } from '../cli/help.ts';
import { CONFIG_PATH, parseConfigText } from '../config/config.ts';
import { remiHome } from '../config/remi-home.ts';
import { configWarnings } from './config-warnings.ts';
import { checkLogin } from './login-check.ts';
import { type Profile, type Profiles, parseProfiles } from './profile-config.ts';
import { profileEnvironment } from './profile-env.ts';

interface IO {
  out: (line: string) => void;
  err: (line: string) => void;
  isTerminal: () => boolean;
}
const defaultIO: IO = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  isTerminal: () => !!process.stdin.isTTY && !!process.stdout.isTTY,
};
type Harness = 'claude' | 'codex';
function statusText(result: Awaited<ReturnType<typeof checkLogin>>): string {
  switch (result.login) {
    case 'signed_in':
      return 'signed in';
    case 'signed_out':
      return result.noDirectory ? 'signed out (no directory yet)' : 'signed out';
    case 'not_own_login':
      return `not its own sign-in (${result.source ?? 'other'})`;
    case 'unknown':
      return `unknown (${result.reason ?? 'error'})`;
  }
}
async function statuses(profile: Profile, cwd: string): Promise<string[]> {
  const env = profileEnvironment(process.env, profile);
  return Promise.all(
    (['claude', 'codex'] as const)
      .filter((name) => profile[name])
      .map(
        async (name) =>
          `${name}: ${statusText(await checkLogin({ harness: name, expects: profile[name]?.expects ?? '', env, cwd }))}`,
      ),
  );
}
function argsOptions(
  args: readonly string[],
): { positional: string[]; values: Record<string, string>; switches: Set<string> } | undefined {
  const positional: string[] = [];
  const values: Record<string, string> = Object.create(null);
  const switches = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--claude' || arg === '--codex') {
      if (switches.has(arg)) return undefined;
      switches.add(arg);
    } else if (['--label', '--expects', '--claude-dir', '--codex-dir', '--harness'].includes(arg)) {
      if (values[arg] !== undefined || args[i + 1] === undefined || args[i + 1]?.startsWith('--'))
        return undefined;
      values[arg] = args[++i] as string;
    } else if (arg.startsWith('-')) return undefined;
    else positional.push(arg);
  }
  return { positional, values, switches };
}

function add(args: readonly string[], configPath: string, io: IO): number {
  const opts = argsOptions(args);
  if (!opts || opts.positional.length !== 1 || Object.hasOwn(opts.values, '--harness')) {
    io.err('Usage: remi profile add <id> --label <text> [--claude] [--codex]');
    return 1;
  }
  const id = opts.positional[0] as string;
  const label = opts.values['--label'];
  const expects = opts.values['--expects'] ?? 'subscription';
  const harnesses = (['claude', 'codex'] as const).filter(
    (name) => opts.switches.has(`--${name}`) || opts.values[`--${name}-dir`] !== undefined,
  );
  if (!label || !harnesses.length || !['subscription', 'api_key'].includes(expects)) {
    io.err(
      !label
        ? 'The --label option is required.'
        : !harnesses.length
          ? 'Select --claude or --codex.'
          : 'The --expects option must be subscription or api_key.',
    );
    return 1;
  }
  // Validate the id before interpolating it into TOML.
  const idCheck = parseProfiles({ [id]: { label, claude: { expects } } });
  if ('error' in idCheck) {
    io.err(idCheck.error);
    return 1;
  }
  let lock: string | undefined;
  let lockFd: number | undefined;
  let temporary: string | undefined;
  const created: string[] = [];
  let createdParent: string | undefined;
  let parent: string | undefined;
  try {
    const destination = fs.existsSync(configPath) ? fs.realpathSync(configPath) : configPath;
    parent = path.dirname(destination);
    createdParent = fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    lock = `${destination}.lock`;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        lockFd = fs.openSync(lock, 'wx', 0o600);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
    if (lockFd === undefined) {
      io.err('Another profile add is in progress. Try again.');
      return 1;
    }
    const existing = fs.existsSync(destination) ? fs.readFileSync(destination, 'utf8') : '';
    const current = parseConfigText(existing, destination).config.profiles;
    if ('error' in current) {
      io.err(current.error);
      return 1;
    }
    if (Object.hasOwn(current.entries, id)) {
      io.err(`Profile ${id} already exists.`);
      return 1;
    }
    let block = `\n${existing.endsWith('\n') || existing === '' ? '' : '\n'}[profiles.${id}]\nlabel = ${JSON.stringify(label)}\n`;
    for (const name of harnesses)
      block += `\n[profiles.${id}.${name}]\n${opts.values[`--${name}-dir`] !== undefined ? `dir = ${JSON.stringify(opts.values[`--${name}-dir`])}\n` : ''}expects = ${JSON.stringify(expects)}\n`;
    const checked = parseConfigText(existing + block, configPath).config.profiles;
    if ('error' in checked) {
      io.err(checked.error);
      return 1;
    }
    const profile = checked.entries[id];
    if (!profile) {
      io.err('Invalid profile.');
      return 1;
    }
    for (const name of harnesses) {
      const dir = profile[name]?.dir as string;
      if (opts.values[`--${name}-dir`] !== undefined) {
        try {
          if (!fs.statSync(dir).isDirectory()) {
            io.err(`The --${name}-dir path is not a directory.`);
            return 1;
          }
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          io.err(
            code === 'EACCES'
              ? `Cannot access --${name}-dir.`
              : `The --${name}-dir path does not exist or is not a directory.`,
          );
          return 1;
        }
      } else if (fs.existsSync(dir) && fs.readdirSync(dir).length) {
        io.err(
          `The directory ${dir} already exists and is not empty. Adopt it with --claude-dir or --codex-dir, or delete it.`,
        );
        return 1;
      }
    }
    temporary = path.join(parent, `.config-${randomUUID()}.tmp`);
    const mode = fs.existsSync(destination) ? fs.statSync(destination).mode & 0o777 : 0o600;
    const fd = fs.openSync(temporary, 'wx', mode);
    try {
      fs.fchmodSync(fd, mode);
      fs.writeFileSync(fd, existing + block);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    for (const name of harnesses) {
      if (opts.values[`--${name}-dir`] === undefined) {
        const dir = profile[name]?.dir as string;
        const first = fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        if (first) {
          let current = dir;
          while (current.startsWith(first)) {
            created.push(current);
            if (current === first) break;
            current = path.dirname(current);
          }
        }
      }
    }
    fs.renameSync(temporary, destination);
    temporary = undefined;
    created.length = 0;
    io.out(`Run remi profile login ${id}`);
    return 0;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    io.err(
      code === 'ENOENT'
        ? 'A requested directory does not exist.'
        : code === 'EACCES'
          ? 'Permission denied while adding the profile.'
          : code === 'ENOTDIR'
            ? 'A requested path is not a directory.'
            : 'Could not add profile; check the config and directories.',
    );
    return 1;
  } finally {
    if (temporary) {
      try {
        fs.unlinkSync(temporary);
      } catch {}
    }
    for (const dir of created) {
      try {
        fs.rmdirSync(dir);
      } catch {}
    }
    if (lockFd !== undefined && lock) {
      fs.closeSync(lockFd);
      fs.unlinkSync(lock);
    }
    if (createdParent && parent) {
      let current = parent;
      for (;;) {
        try {
          fs.rmdirSync(current);
        } catch {
          break;
        }
        if (current === createdParent) break;
        current = path.dirname(current);
      }
    }
  }
}

async function runLogin(
  id: string,
  profile: Profile,
  args: readonly string[],
  io: IO,
  cwd: string,
): Promise<number> {
  const opts = argsOptions(args);
  if (
    !opts ||
    opts.positional.length ||
    opts.switches.size ||
    Object.keys(opts.values).some((k) => k !== '--harness')
  ) {
    io.err('Usage: remi profile login <id> [--harness claude|codex]');
    return 1;
  }
  if (!io.isTerminal()) {
    io.err('Run this in your own terminal.');
    return 1;
  }
  const selected =
    opts.values['--harness'] ??
    (profile.claude && !profile.codex
      ? 'claude'
      : profile.codex && !profile.claude
        ? 'codex'
        : undefined);
  if (selected !== 'claude' && selected !== 'codex') {
    io.err('Choose a configured harness with --harness claude|codex.');
    return 1;
  }
  const harness: Harness = selected;
  const spec = profile[harness];
  if (!spec) {
    io.err('Choose a configured harness with --harness claude|codex.');
    return 1;
  }
  if (spec.expects !== 'subscription' && spec.expects !== 'api_key') {
    io.err(`Profile ${id} expects ${spec.expects}, which this build does not support.`);
    return 1;
  }
  try {
    if (spec.dir === path.join(remiHome(), 'p', id, harness))
      fs.mkdirSync(spec.dir, { recursive: true, mode: 0o700 });
    else if (!fs.statSync(spec.dir).isDirectory()) throw new Error('not a directory');
  } catch {
    io.err('Could not create the profile directory.');
    return 1;
  }
  if (harness === 'claude' && spec.expects === 'api_key')
    io.out(
      'A Console sign-in without an API key signs out every claude.ai sign-in on this machine and is not kept apart per profile.',
    );
  const env = profileEnvironment(process.env, profile);
  const command = Bun.which(harness, { PATH: env['PATH'] ?? '' });
  if (!command) {
    io.err(`${harness} is not installed.`);
    return 1;
  }
  return await new Promise((resolve) => {
    const child = spawn(
      command,
      harness === 'claude'
        ? ['auth', 'login', spec.expects === 'subscription' ? '--claudeai' : '--console']
        : ['login'],
      { cwd, env, stdio: 'inherit', shell: false },
    );
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

export async function runProfileCommand(
  args: readonly string[],
  profiles: Profiles,
  io: IO = defaultIO,
  paths: { configPath?: string; cwd?: string } = {},
): Promise<number> {
  if ('error' in profiles) {
    io.err(profiles.error);
    return 1;
  }
  const [verb, id, ...rest] = args;
  const cwd = paths.cwd ?? process.cwd();
  if (verb === 'add') return add(args.slice(1), paths.configPath ?? CONFIG_PATH, io);
  if (verb === 'ls' && args.length === 1) {
    io.out('default (built-in): your existing sign-ins; remi changes nothing');
    for (const [name, profile] of Object.entries(profiles.entries)) {
      io.out(`${name}  ${profile.label}${profiles.default === name ? ' (machine default)' : ''}`);
      for (const line of await statuses(profile, cwd)) io.out(`  ${line}`);
    }
    return 0;
  }
  if ((verb === 'show' || verb === 'login') && id && Object.hasOwn(profiles.entries, id)) {
    const profile = profiles.entries[id] as Profile;
    if (verb === 'login') return runLogin(id, profile, rest, io, cwd);
    if (rest.length) {
      io.err('Usage: remi profile show <id>');
      return 1;
    }
    io.out(
      `id: ${id}\nlabel: ${profile.label}\nmachine default: ${profiles.default === id ? 'yes' : 'no'}\ndefault harness: ${profile.harness ?? 'none'}\nargs: ${JSON.stringify(profile.args)}\nfolders: ${JSON.stringify(profile.folders)}\nenv: ${Object.keys(profile.env).join(', ')}`,
    );
    for (const name of ['claude', 'codex'] as const)
      if (profile[name])
        io.out(`${name}: dir = ${profile[name]?.dir}, expects = ${profile[name]?.expects}`);
    for (const line of await statuses(profile, cwd)) io.out(line);
    if (profile.claude) {
      for (const warning of configWarnings({
        claudeDir: profile.claude.dir,
        expects: profile.claude.expects,
        cwd,
      }))
        io.out(
          warning.key === 'unreadable'
            ? `could not read ${warning.source}`
            : `${warning.source}: ${warning.key}`,
        );
      io.out('macOS managed preferences are not inspected.');
    }
    return 0;
  }
  if ((verb === 'show' || verb === 'login') && id) {
    io.err(`Unknown profile ${id}. Run remi profile ls.`);
    return 1;
  }
  io.err(PROFILE_USAGE);
  return 1;
}
