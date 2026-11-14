# Keep the Mac awake (level 1, #1773)

On macOS, each session daemon uses `/usr/bin/caffeinate -i -w <daemon-pid> -t <ttl-seconds>` while that session has real work. The assertion prevents idle system sleep; the screen can still sleep. The `-w` process binding lets macOS release the assertion when that session daemon exits. The hub is session-less and does not hold an assertion. Other platforms do nothing.

Real work is an open Claude turn, a busy status (`thinking`, `executing`, or `waiting`), or a pending question. UserPromptSubmit opens a turn even when Claude only reasons and emits no tool call. Hook events, PTY output, and Codex app-server notifications refresh the stuck-state clock. Idle sessions release after the configured grace period. Busy or open-turn state with no activity releases at the stuck bound. A pending question holds for at most its configured cap. When work continues, remi starts the next `caffeinate` process before stopping the previous one so the TTL can be renewed without a gap.

The `[awake]` defaults are `level1 = true`, `question_hold_minutes = 30`, `idle_grace_seconds = 120`, `stuck_busy_minutes = 15`, and `ttl_minutes = 20`. Set `level1 = false` to disable the feature. Question, grace, stale-state, and holder-TTL values are positive integers with bounds documented in the generated default config. The settings apply after restart.

The assertion is system-wide. macOS does not scope idle sleep to remi's process tree, so other running apps continue to run while the assertion is held. This slice never requests a display assertion, uses `sudo`, or changes power settings. `pmset -g assertions` is the system's view of active assertions; the remi holder appears as `PreventUserIdleSystemSleep` with `Created for PID: <session-daemon-pid>`.

Level 1 does not implement lid-closed mode and cannot override lid-close or emergency low-battery sleep. A MacBook on battery, lid-closed behavior, and behavior across an actual system sleep have not been verified by this slice.
