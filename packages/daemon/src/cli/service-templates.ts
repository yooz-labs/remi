/**
 * Pure template builders for the login-service install paths (`remi
 * --install`): the macOS LaunchAgent plist and the Linux systemd user unit.
 *
 * Extracted from cli.ts so the generated content is unit-testable without
 * touching launchctl/systemctl (#542 review).
 */

/**
 * LaunchAgent plist running the session-less hub.
 *
 * The service runs `remi serve` (session-less hub, #542) — never a session
 * daemon: under launchd cwd is `/`, and the old `--daemon` form spawned a
 * junk Claude session there at every login.
 *
 * KeepAlive.SuccessfulExit=false (not a bare `true`): a clean exit
 * (`remi stop`, SIGTERM) must STAY stopped; only a crash exit(1) (process
 * guards, #534) gets restarted. A bare `true` resurrects a deliberately
 * stopped hub.
 */
export function buildLaunchAgentPlist(binaryPath: string, home: string): string {
  const template = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.yooz.remi</string>
    <key>ProgramArguments</key>
    <array>
        <string>__REMI_BINARY__</string>
        <string>serve</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>StandardOutPath</key>
    <string>__HOME__/.remi/remi-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>__HOME__/.remi/remi-stderr.log</string>
</dict>
</plist>`;
  return template.replace(/__REMI_BINARY__/g, binaryPath).replace(/__HOME__/g, home);
}

/**
 * systemd user unit running the session-less hub.
 *
 * `serve` (session-less hub), same rationale as the LaunchAgent.
 * Restart=on-failure already matches the crash-only restart policy.
 */
export function buildSystemdUnit(binaryPath: string): string {
  return `[Unit]
Description=Remi - Claude Code Monitor
After=network.target

[Service]
Type=simple
ExecStart=${binaryPath} serve
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target`;
}
