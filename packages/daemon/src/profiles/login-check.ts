import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { canonicalPath } from './resolve-profile.ts';

type Source =
  | 'ANTHROPIC_API_KEY'
  | 'apiKeyHelper'
  | '/login managed key'
  | 'configDirectory'
  | 'other';
type Login = 'signed_in' | 'signed_out' | 'not_own_login' | 'unknown';
type Reason = 'harness_missing' | 'timeout' | 'not_checked' | 'error';
type Method = 'claude.ai' | 'api_key' | 'api_key_helper' | 'none' | 'other';
type Provider = 'firstParty' | 'bedrock' | 'vertex' | 'foundry' | 'gateway' | 'other';
export interface LoginResult {
  readonly login: Login;
  readonly source?: Source;
  readonly reason?: Reason;
  readonly facts?: {
    readonly authMethod: Method;
    readonly apiProvider: Provider;
    readonly apiKeySource?: Source;
  };
  readonly noDirectory?: boolean;
}

function source(value: unknown): Source {
  return value === 'ANTHROPIC_API_KEY' || value === 'apiKeyHelper' || value === '/login managed key'
    ? value
    : 'other';
}
function method(value: unknown): Method {
  return value === 'claude.ai' ||
    value === 'api_key' ||
    value === 'api_key_helper' ||
    value === 'none'
    ? value
    : 'other';
}
function provider(value: unknown): Provider {
  return value === 'firstParty' ||
    value === 'bedrock' ||
    value === 'vertex' ||
    value === 'foundry' ||
    value === 'gateway'
    ? value
    : 'other';
}
/** A missing or malformed file is not evidence of an isolated Codex store. */
export function codexUsesFileStore(dir: string): boolean {
  try {
    return (
      parseToml(fs.readFileSync(path.join(dir, 'config.toml'), 'utf8'))[
        'cli_auth_credentials_store'
      ] === 'file'
    );
  } catch {
    return false;
  }
}

export async function checkLogin(options: {
  harness: 'claude' | 'codex';
  expects: string;
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  timeoutMs?: number;
  command?: string;
  log?: (line: string) => void;
}): Promise<LoginResult> {
  const { harness, expects, env, cwd } = options;
  const dir = env[harness === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'];
  if (!dir || !fs.existsSync(dir)) return { login: 'signed_out', noDirectory: true };
  if (expects !== 'subscription' && expects !== 'api_key')
    return { login: 'unknown', reason: 'not_checked' };
  if (harness === 'codex' && !codexUsesFileStore(dir))
    return { login: 'unknown', reason: 'not_checked' };
  const command = options.command ?? Bun.which(harness, { PATH: env['PATH'] ?? '' });
  if (!command || !path.isAbsolute(command)) return { login: 'unknown', reason: 'harness_missing' };
  const outcome = await new Promise<{ code: number | null; output: Buffer; error?: Reason }>(
    (resolve) => {
      const child = spawn(
        command,
        harness === 'claude' ? ['auth', 'status', '--json'] : ['login', 'status'],
        {
          cwd,
          env,
          shell: false,
          stdio: ['ignore', harness === 'claude' ? 'pipe' : 'ignore', 'ignore'],
        },
      );
      const chunks: Buffer[] = [];
      let length = 0;
      let failure: Reason | undefined;
      const timer = setTimeout(() => {
        failure = 'timeout';
        child.kill('SIGKILL');
      }, options.timeoutMs ?? 10000);
      child.stdout?.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length > 65536) {
          failure = 'error';
          child.kill('SIGKILL');
        } else chunks.push(chunk);
      });
      child.on('error', (err: NodeJS.ErrnoException) => {
        failure = err.code === 'ENOENT' ? 'harness_missing' : 'error';
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, output: Buffer.concat(chunks), ...(failure ? { error: failure } : {}) });
      });
    },
  );
  if (outcome.error) return { login: 'unknown', reason: outcome.error };
  if (harness === 'codex')
    return outcome.code === 0
      ? { login: 'signed_in' }
      : outcome.code === 1
        ? { login: 'signed_out' }
        : { login: 'unknown', reason: 'error' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(outcome.output.toString('utf8'));
  } catch {
    options.log?.(`unparsable status output (${outcome.output.length} bytes)`);
    return { login: 'unknown', reason: 'error' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return { login: 'unknown', reason: 'error' };
  const data = parsed as Record<string, unknown>;
  const authMethod = method(data['authMethod']);
  const apiProvider = provider(data['apiProvider']);
  const hasSource = Object.hasOwn(data, 'apiKeySource') && data['apiKeySource'] !== undefined;
  const apiKeySource = hasSource ? source(data['apiKeySource']) : undefined;
  const facts = { authMethod, apiProvider, ...(apiKeySource ? { apiKeySource } : {}) };
  if (
    typeof data['configDirectory'] === 'string' &&
    canonicalPath(data['configDirectory']) !== canonicalPath(dir)
  )
    return { login: 'not_own_login', source: 'configDirectory', facts };
  if (data['loggedIn'] !== true) return { login: 'signed_out', facts };
  if (expects === 'subscription') {
    if (apiKeySource) return { login: 'not_own_login', source: apiKeySource, facts };
    return authMethod === 'claude.ai' && apiProvider === 'firstParty'
      ? { login: 'signed_in', facts }
      : { login: 'not_own_login', source: 'other', facts };
  }
  return (authMethod === 'api_key' || authMethod === 'api_key_helper') &&
    hasSource &&
    typeof data['apiKeySource'] === 'string'
    ? { login: 'signed_in', facts }
    : { login: 'not_own_login', source: 'other', facts };
}
