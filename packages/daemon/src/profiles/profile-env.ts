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
];

export function profileEnvironment(
  inherited: Readonly<Record<string, string | undefined>>,
  profile: Profile,
): Record<string, string | undefined> {
  const result = { ...inherited };
  for (const name of PROFILE_CREDENTIAL_ENV) delete result[name];
  // An explicit profile setting may restore this after inherited values are removed.
  // biome-ignore lint/performance/noDelete: the inherited variable must be absent
  delete result['ANTHROPIC_BASE_URL'];
  Object.assign(result, profile.env);
  if (profile.claude) result['CLAUDE_CONFIG_DIR'] = profile.claude.dir;
  if (profile.codex) result['CODEX_HOME'] = profile.codex.dir;
  return withoutRemiSecrets(result);
}
