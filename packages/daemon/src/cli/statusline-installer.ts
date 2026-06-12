/**
 * Install the Claude Code statusline integration.
 *
 * Writes a bash script to `~/.remi/statusline.sh` that the Claude Code
 * `statusLine` hook invokes on every prompt. The script reads the per-port
 * `~/.remi/status-$REMI_PORT.json` file and formats a compact status string.
 *
 * Auto-wires itself into `~/.claude/settings.json` only if no `statusLine`
 * key exists, preserving any user customization.
 *
 * Extracted from cli.ts as part of the cleanup epic (see
 * `.context/cleanup-audit.md`). Pure with respect to module state — the only
 * input is the Remi home directory.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { errorToString } from '@remi/shared';

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
  IFS=\$'\\t' read -r S_PID S_CONNS S_STATUS S_REPO S_BRANCH AA_INFLIGHT AA_SINCE AA_LASTV AA_LASTAT < <(jq -r '[.pid // 0, .connections // 0, .sessionStatus // "unknown", .repo // "", .branch // "", .autoApprove.inFlight // 0, .autoApprove.sinceS // 0, .autoApprove.lastVerdict // "none", .autoApprove.lastVerdictAtS // 0] | @tsv' "\$REMI_STATUS_FILE" 2>/dev/null)
  if [ -n "\$S_PID" ] && kill -0 "\$S_PID" 2>/dev/null; then
    CLIENT_INFO="no clients"
    [ "\$S_CONNS" != "0" ] && CLIENT_INFO="\${S_CONNS} client(s)"
    # The status segment reflects auto-approve state when a permission is being
    # decided, otherwise Claude's agent status (#560). All arithmetic is guarded
    # (:-0) so a status file from an older daemon (no autoApprove key) renders
    # cleanly. The evaluating cap (600s) is leak-safety; "needs you" decays after
    # 60s so a stale escalate never sticks across sessions.
    NOW=\$(date +%s)
    AA_ELAPSED=\$((NOW - \${AA_SINCE:-0}))
    AA_AGE=\$((NOW - \${AA_LASTAT:-0}))
    STATE="\$S_STATUS"
    if [ "\${AA_INFLIGHT:-0}" -gt 0 ] 2>/dev/null && [ "\$AA_ELAPSED" -lt 600 ] 2>/dev/null; then
      STATE="evaluating \${AA_ELAPSED}s"
    elif [ "\$AA_LASTV" = "escalated" ] && [ "\$AA_AGE" -lt 60 ] 2>/dev/null; then
      STATE="needs you"
    elif [ "\$AA_LASTV" = "approved" ] && [ "\$AA_AGE" -lt 5 ] 2>/dev/null; then
      STATE="approved"
    fi
    REMI="remi:\$REMI_PORT \${S_REPO}:\${S_BRANCH} | \${CLIENT_INFO} | \${STATE}"
  fi
fi
IFS=\$'\\t' read -r C_PCT C_MODEL < <(echo "\$input" | jq -r '[(.context_window.used_percentage // 0 | floor), (.model.display_name // "?")] | @tsv' 2>/dev/null)
echo "\${REMI:+\$REMI | }[\${C_MODEL:-?}] \${C_PCT:-0}% context"
`;
}

/**
 * Install the statusline: write the script to `remiDir/statusline.sh` and
 * register it in `claudeSettingsPath` (defaults to `~/.claude/settings.json`)
 * if no `statusLine` key is set.
 *
 * Never throws — any failure is logged and swallowed. The statusline is a
 * convenience feature; if installation fails, Remi still functions.
 *
 * `claudeSettingsPath` is exposed for tests that need to run against an
 * isolated settings file. Production callers omit it.
 */
export function installStatusLine(
  remiDir: string,
  claudeSettingsPath: string = path.join(os.homedir(), '.claude', 'settings.json'),
): void {
  try {
    fs.mkdirSync(remiDir, { recursive: true });
    const scriptPath = path.join(remiDir, 'statusline.sh');
    fs.writeFileSync(scriptPath, buildStatuslineScript(remiDir), { mode: 0o755 });

    // Auto-configure Claude Code settings if no statusLine key exists.
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
