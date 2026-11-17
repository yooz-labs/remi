import { withoutRemiSecrets } from '../pty/child-env.ts';
import type { Profile } from './profile-config.ts';

/** Removed by name before any profile-specific environment is applied. */
export const PROFILE_CREDENTIAL_ENV: readonly string[] = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_GATEWAY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  'CLAUDE_CODE_USE_MANTLE',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_PROFILE',
  'ANTHROPIC_CONFIG_DIR',
  'ANTHROPIC_FEDERATION_RULE_ID',
  'ANTHROPIC_ORGANIZATION_ID',
  'ANTHROPIC_WORKSPACE_ID',
  'ANTHROPIC_SERVICE_ACCOUNT_ID',
  'ANTHROPIC_SCOPE',
  'ANTHROPIC_IDENTITY_TOKEN',
  'ANTHROPIC_IDENTITY_TOKEN_FILE',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
  'ANTHROPIC_AWS_API_KEY',
  'ANTHROPIC_ENVIRONMENT_KEY',
  'AWS_BEARER_TOKEN_BEDROCK',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
  'CLAUDE_CODE_OAUTH_SCOPES',
  'CLAUDE_CODE_OAUTH_CLIENT_ID',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_CODE_GATEWAY_TOKEN',
  'CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_SESSION_ACCESS_TOKEN',
  'CLAUDE_CODE_SESSIONS_OAUTH_TOKEN',
  'CLAUDE_CODE_CLIENT_CERT',
  'CLAUDE_CODE_CLIENT_KEY',
  'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE',
  'OPENAI_API_KEY',
  'CODEX_ACCESS_TOKEN',
  'CODEX_API_KEY',
  'ANTHROPIC_AWS_WORKSPACE_ID',
  'ANTHROPIC_GOOGLE_CLOUD_WORKSPACE_ID',
  'ANTHROPIC_GOOGLE_CLOUD_PROJECT',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'ANTHROPIC_FOUNDRY_RESOURCE',
  'ANTHROPIC_AWS_BASE_URL',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_BEDROCK_MANTLE_BASE_URL',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_GOOGLE_CLOUD_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH',
  'CLAUDE_CODE_SKIP_ANTHROPIC_GOOGLE_CLOUD_AUTH',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
  'CLAUDE_CODE_SKIP_MANTLE_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'OPENAI_FEDERATION_RULE_ID',
  'OPENAI_IDENTITY_TOKEN_FILE',
  'OPENAI_WORKLOAD_IDENTITY_CONTEXT',
  'CODEX_AUTHAPI_BASE_URL',
  'CODEX_REFRESH_TOKEN_URL_OVERRIDE',
  'CODEX_REVOKE_TOKEN_URL_OVERRIDE',
  'CODEX_APP_SERVER_LOGIN_CLIENT_ID',
  'OPENAI_BASE_URL',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_SECURITY_TOKEN',
  'AWS_PROFILE',
  'AWS_DEFAULT_PROFILE',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'ANTHROPIC_ENVIRONMENT_ID',
  'ANTHROPIC_SESSION_ID',
  'ANTHROPIC_WEBHOOK_SIGNING_KEY',
  'ANTHROPIC_WORK_ID',
  'ANTHROPIC_WORK_SECRET',
  'CLAUDE_CODE_CUSTOM_OAUTH_URL',
  'CLAUDE_CODE_DESIGN_OAUTH_CLIENT_ID',
  'CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH',
  'CLAUDE_CODE_SDK_HAS_SESSIONS_OAUTH_REFRESH',
];

export const PROFILE_CREDENTIAL_ENV_PREFIXES: readonly string[] = [
  'ANTHROPIC_SECRET_PLACEHOLDER_',
  'CLAUDE_CODE_OAUTH_',
];

export function profileEnvironment(
  inherited: Readonly<Record<string, string | undefined>>,
  profile: Profile,
): Record<string, string | undefined> {
  const result = { ...inherited };
  for (const name of PROFILE_CREDENTIAL_ENV) delete result[name];
  for (const name of Object.keys(result)) {
    if (PROFILE_CREDENTIAL_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)))
      Reflect.deleteProperty(result, name);
  }
  // An explicit profile setting may restore this after inherited values are removed.
  // biome-ignore lint/performance/noDelete: the inherited variable must be absent
  delete result['ANTHROPIC_BASE_URL'];
  Object.assign(result, profile.env);
  if (profile.claude) result['CLAUDE_CONFIG_DIR'] = profile.claude.dir;
  if (profile.codex) result['CODEX_HOME'] = profile.codex.dir;
  return withoutRemiSecrets(result);
}
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseToml } from 'smol-toml';

/** Read only the configured names of provider environment sources. */
export function codexProviderCredentialNames(id: string, dir: string): Set<string> {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dir, 'config.toml'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw new Error(`Could not read the Codex configuration of profile ${id} (config.toml).`);
  }
  let config: Record<string, unknown>;
  try {
    config = parseToml(raw);
  } catch {
    throw new Error(`Could not read the Codex configuration of profile ${id} (config.toml).`);
  }
  const names = new Set<string>();
  const providers = config['model_providers'];
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return names;
  for (const provider of Object.values(providers)) {
    if (!provider || typeof provider !== 'object' || Array.isArray(provider)) continue;
    const item = provider as Record<string, unknown>;
    if (typeof item['env_key'] === 'string') names.add(item['env_key']);
    const headers = item['env_http_headers'];
    if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
      for (const name of Object.values(headers)) if (typeof name === 'string') names.add(name);
    }
  }
  return names;
}

/** Apply dynamic Codex provider restrictions to both probes and launches. */
export function profileLaunchEnvironment(
  inherited: Readonly<Record<string, string | undefined>>,
  id: string,
  profile: Profile,
): Record<string, string | undefined> {
  const env = profileEnvironment(inherited, profile);
  if (!profile.codex) return env;
  for (const name of codexProviderCredentialNames(id, profile.codex.dir)) {
    if (Object.hasOwn(profile.env, name))
      throw new Error(
        `Profile ${id} sets ${name}, which its Codex configuration reads as a credential; remi does not store credentials.`,
      );
    Reflect.deleteProperty(env, name);
  }
  return env;
}
