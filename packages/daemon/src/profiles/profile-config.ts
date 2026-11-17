import { createHash } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { validateProfileLabel } from '@remi/shared';
import { remiHome } from '../config/remi-home.ts';
import { REMI_SECRET_ENV } from '../pty/child-env.ts';
import { PROFILE_CREDENTIAL_ENV } from './profile-env.ts';

export interface ProfileHarness {
  readonly dir: string;
  readonly expects: string;
}
export interface Profile {
  readonly label: string;
  readonly harness?: 'claude' | 'codex';
  readonly args: readonly string[];
  readonly folders: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly claude?: ProfileHarness;
  readonly codex?: ProfileHarness;
  readonly revision: string;
}
export type Profiles =
  | { readonly error: string }
  | {
      readonly entries: Readonly<Record<string, Profile>>;
      readonly default?: string;
      readonly notices: readonly string[];
    };

const LATER = new Set([
  'remote_visible',
  'remote_selectable',
  'warn_percent',
  'offer_percent',
  'continuation_target',
]);
const PROFILE_KEYS = new Set([
  'label',
  'harness',
  'args',
  'folders',
  'env',
  'claude',
  'codex',
  ...LATER,
]);
const CREDENTIAL_NAME = /(API_KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE|CREDENTIAL|PRIVATE_KEY)/i;
export function isCredentialName(name: string): boolean {
  return CREDENTIAL_NAME.test(name);
}

function table(value: unknown, key: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || value instanceof Date)
    throw new Error(`${key}: expected a table`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: ReadonlySet<string>, key: string): void {
  for (const k of Object.keys(value))
    if (!allowed.has(k)) throw new Error(`${key}.${k}: unknown key`);
}
function strings(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || value.some((x) => typeof x !== 'string'))
    throw new Error(`${key}: expected an array of strings`);
  return value as string[];
}
function absolute(value: unknown, key: string): string {
  if (typeof value !== 'string') throw new Error(`${key}: expected an absolute or ~/ path`);
  const expanded = value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
  if (!path.isAbsolute(expanded)) throw new Error(`${key}: expected an absolute or ~/ path`);
  return path.resolve(expanded);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .filter((k) => obj[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
export function profileRevision(profile: Omit<Profile, 'revision'>): string {
  return createHash('sha256')
    .update(
      canonical({
        harness: profile.harness,
        args: profile.args,
        env: profile.env,
        claude: profile.claude,
        codex: profile.codex,
      }),
    )
    .digest('hex');
}

export function parseProfiles(raw: unknown): Profiles {
  try {
    if (raw === undefined) return { entries: {}, notices: [] };
    const root = table(raw, 'profiles');
    const ids = Object.keys(root).filter((key) => key !== 'default');
    if (ids.length > 32) throw new Error('profiles: at most 32 profiles');
    const entries: Record<string, Profile> = Object.create(null);
    const folders = new Set<string>();
    const notices: string[] = [];
    for (const id of ids) {
      if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) throw new Error('profiles: invalid profile id');
      const prefix = `profiles.${id}`;
      const p = table(root[id], prefix);
      keys(p, PROFILE_KEYS, prefix);
      for (const key of LATER)
        if (key in p) notices.push(`${prefix}.${key}: not used by this remi version`);
      const labelError = validateProfileLabel(p['label']);
      if (labelError) throw new Error(`${prefix}.label: ${labelError}`);
      const harness = p['harness'];
      if (harness !== undefined && harness !== 'claude' && harness !== 'codex')
        throw new Error(`${prefix}.harness: expected claude or codex`);
      const args = p['args'] === undefined ? [] : strings(p['args'], `${prefix}.args`);
      const dirs =
        p['folders'] === undefined
          ? []
          : strings(p['folders'], `${prefix}.folders`).map((dir) =>
              absolute(dir, `${prefix}.folders`),
            );
      for (const dir of dirs) {
        if (folders.has(dir))
          throw new Error(`${prefix}.folders: folder appears in more than one profile`);
        folders.add(dir);
      }
      const envRaw = p['env'] === undefined ? {} : table(p['env'], `${prefix}.env`);
      const env: Record<string, string> = Object.create(null);
      for (const [name, value] of Object.entries(envRaw)) {
        const key = `${prefix}.env.${name}`;
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`${prefix}.env: invalid name`);
        if (['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'HOME', 'XDG_CONFIG_HOME'].includes(name))
          throw new Error(`${key}: set the profile's directory with \`dir\`, not \`env\``);
        if (REMI_SECRET_ENV.includes(name))
          throw new Error(`${key}: remi does not store credentials; use the harness's own sign-in`);
        if (PROFILE_CREDENTIAL_ENV.includes(name))
          throw new Error(`${key}: not supported in this build`);
        if (isCredentialName(name))
          throw new Error(`${key}: remi does not store credentials; use the harness's own sign-in`);
        if (typeof value !== 'string') throw new Error(`${key}: expected a string`);
        env[name] = value;
      }
      const readHarness = (name: 'claude' | 'codex'): ProfileHarness | undefined => {
        if (p[name] === undefined) return undefined;
        const h = table(p[name], `${prefix}.${name}`);
        keys(h, new Set(['dir', 'expects']), `${prefix}.${name}`);
        if (typeof h['expects'] !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(h['expects']))
          throw new Error(`${prefix}.${name}.expects: expected a safe token`);
        return {
          dir:
            h['dir'] === undefined
              ? path.join(remiHome(), 'p', id, name)
              : absolute(h['dir'], `${prefix}.${name}.dir`),
          expects: h['expects'],
        };
      };
      const claude = readHarness('claude');
      const codex = readHarness('codex');
      if (!claude && !codex) throw new Error(`${prefix}: configure claude or codex`);
      if (
        claude &&
        args.some((arg) => /^--(?:settings|managed-settings|setting-sources)(?:=|$)/.test(arg))
      )
        throw new Error(
          `${prefix}.args: these change which settings, and so which credential, Claude Code uses`,
        );
      if (
        codex &&
        args.some((arg) => /^-(?:p|c)/.test(arg) || /^--(?:profile|config)(?:=|$)/.test(arg))
      )
        throw new Error(`${prefix}.args: Codex profile and config flags are not supported`);
      const withoutRevision: Omit<Profile, 'revision'> = {
        label: p['label'] as string,
        ...(harness ? { harness } : {}),
        args,
        folders: dirs,
        env,
        ...(claude ? { claude } : {}),
        ...(codex ? { codex } : {}),
      };
      entries[id] = { ...withoutRevision, revision: profileRevision(withoutRevision) };
    }
    if (
      root['default'] !== undefined &&
      (typeof root['default'] !== 'string' || !Object.hasOwn(entries, root['default']))
    )
      throw new Error('profiles.default: must name a configured profile');
    return {
      entries,
      ...(typeof root['default'] === 'string' ? { default: root['default'] } : {}),
      notices,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'profiles: invalid configuration' };
  }
}
