import { withoutRemiSecrets } from '../pty/child-env.ts';
import type { Profile } from './profile-config.ts';

/** Removed by name before any profile-specific environment is applied. */
export const PROFILE_CREDENTIAL_ENV: readonly string[] = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_PROFILE',
  'ANTHROPIC_FEDERATION_RULE_ID',
  'ANTHROPIC_ORGANIZATION_ID',
  'ANTHROPIC_IDENTITY_TOKEN_FILE',
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
  for (const name of ['ANTHROPIC_BASE_URL']) delete result[name];
  Object.assign(result, profile.env);
  if (profile.claude) result['CLAUDE_CONFIG_DIR'] = profile.claude.dir;
  if (profile.codex) result['CODEX_HOME'] = profile.codex.dir;
  return withoutRemiSecrets(result);
}
