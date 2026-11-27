/**
 * Install the Claude status line script under the selected Remi home.
 * statusLineTarget selects the default or profile settings path and whether
 * registration is allowed. Existing truthy statusLine settings are preserved.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { errorToString } from '@remi/shared';
import { canonicalPath } from '../profiles/resolve-profile.ts';

/** Resolve existing ancestors too, so a missing directory beneath a symlink stays outside. */
function canonicalWithMissing(value: string): string {
  let current = path.resolve(value);
  const missing: string[] = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    missing.unshift(path.basename(current));
    current = parent;
  }
  return path.join(canonicalPath(current), ...missing);
}

export function statusLineTarget(input: {
  profileClaudeDir?: string | undefined;
  remiHomeOverridden: boolean;
  remiHome: string;
}): { settingsPath?: string; register: boolean } {
  if (input.profileClaudeDir === undefined) return { register: !input.remiHomeOverridden };
  const settingsPath = path.join(input.profileClaudeDir, 'settings.json');
  if (!input.remiHomeOverridden) return { settingsPath, register: true };
  const home = canonicalWithMissing(input.remiHome);
  const relative = path.relative(home, canonicalWithMissing(input.profileClaudeDir));
  let settingsInside = true;
  try {
    const stat = fs.lstatSync(settingsPath);
    if (stat.isSymbolicLink()) {
      try {
        const target = path.relative(home, fs.realpathSync(settingsPath));
        settingsInside =
          target !== '..' && !target.startsWith(`..${path.sep}`) && !path.isAbsolute(target);
      } catch {
        settingsInside = false;
      }
      if (!settingsInside) console.error('[warn] Skipping unsafe profile status line settings');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      settingsInside = false;
      console.error('[warn] Skipping unsafe profile status line settings');
    }
  }

  return {
    settingsPath,
    register:
      settingsInside &&
      (relative === '' ||
        (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))),
  };
}

/**
 * Build the statusline shell script. Takes `remiDir` as input so the script
 * references the correct status-file location.
 *
 * The generated script requires `jq` on the host system.
 */
export function buildStatuslineScript(remiDir: string): string {
  return `#!/bin/bash
input=\$(cat)
REMI=""
# REMI_PORT is set by remi when spawning Claude; status file is per-port.
# REMI_STATUS_BAR=1 means remi draws its own reserved-row status bar (#565), so
# the native statusLine drops the remi prefix and shows only model/context to
# avoid duplicating the remi fields just above the bar.
REMI_STATUS_FILE="${remiDir}/status-\$REMI_PORT.json"
if [ "\$REMI_STATUS_BAR" != "1" ] && [ -n "\$REMI_PORT" ] && [ -f "\$REMI_STATUS_FILE" ]; then
  IFS=\$'\\t' read -r S_PID S_CONNS S_STATUS S_REPO S_BRANCH S_ATTACHED S_QUEUED < <(jq -r '[.pid // 0, .connections // 0, .sessionStatus // "unknown", .repo // "", .branch // "", (.attached | if . == null then "unset" else tostring end), .queuedCount // 0] | @tsv' "\$REMI_STATUS_FILE" 2>/dev/null)
  if [ -n "\$S_PID" ] && kill -0 "\$S_PID" 2>/dev/null; then
    # #755: label from the real attach state (exclusive PTY slot + queue), not
    # the raw connection counter (which also counts remi ls / kill / phone
    # list polls). "unset" = status file from an older daemon -> old label.
    CLIENT_INFO="no clients"
    if [ "\$S_ATTACHED" = "unset" ]; then
      [ "\$S_CONNS" != "0" ] && CLIENT_INFO="\${S_CONNS} client(s)"
    elif [ "\$S_ATTACHED" = "true" ]; then
      CLIENT_INFO="attached"
      [ "\${S_QUEUED:-0}" != "0" ] && CLIENT_INFO="attached (+\${S_QUEUED} waiting)"
    else
      [ "\${S_QUEUED:-0}" != "0" ] && CLIENT_INFO="\${S_QUEUED} waiting"
    fi
    # The status segment is Claude's agent status. The auto-approve cue that
    # used to replace it (#560) was removed with the evaluator (#1125).
    STATE="\$S_STATUS"
    REMI="remi:\$REMI_PORT \${S_REPO}:\${S_BRANCH} | \${CLIENT_INFO} | \${STATE}"
  fi
fi
IFS=\$'\\t' read -r C_PCT C_MODEL < <(echo "\$input" | jq -r '[(.context_window.used_percentage // 0 | floor), (.model.display_name // "?")] | @tsv' 2>/dev/null)
echo "\${REMI:+\$REMI | }[\${C_MODEL:-?}] \${C_PCT:-0}% context"
`;
}

/**
 * Write the script and, when registration is allowed, register it at the given
 * settings path (the default is ~/.claude/settings.json). Production passes a
 * profile settings path selected by statusLineTarget for profile launches.
 * A truthy statusLine is preserved; a falsy one is replaced. Never throws.
 */
export function installStatusLine(
  remiDir: string,
  claudeSettingsPath: string = path.join(os.homedir(), '.claude', 'settings.json'),
  registerInClaudeSettings = true,
): void {
  try {
    fs.mkdirSync(remiDir, { recursive: true });
    const scriptPath = path.join(remiDir, 'statusline.sh');
    fs.writeFileSync(scriptPath, buildStatuslineScript(remiDir), { mode: 0o755 });
    if (!registerInClaudeSettings) return;

    // Auto-configure Claude Code settings if statusLine is falsy.
    // Preserves all other settings but rewrites the file.
    let settings: Record<string, unknown> = {};
    if (fs.existsSync(claudeSettingsPath)) {
      try {
        settings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf-8'));
      } catch {
        console.error(`[warn] Claude settings file is corrupted: ${claudeSettingsPath}`);
        return;
      }
    }
    if (!settings['statusLine']) {
      fs.mkdirSync(path.dirname(claudeSettingsPath), { recursive: true });
      settings['statusLine'] = { type: 'command', command: scriptPath };
      fs.writeFileSync(claudeSettingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    }
  } catch (err) {
    console.error(`[warn] Failed to install status line: ${errorToString(err)}`);
  }
}

/** Install using the selected launch profile and its registration policy. */
export function installStatusLineForLaunch(
  profile: { readonly claude?: { readonly dir: string } } | undefined,
  remiHome: string,
  remiHomeOverridden: boolean,
): void {
  const target = statusLineTarget({
    profileClaudeDir: profile?.claude?.dir,
    remiHome,
    remiHomeOverridden,
  });
  installStatusLine(remiHome, target.settingsPath, target.register);
}
