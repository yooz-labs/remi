# Wrapper suspend and resume check (#375)

`packages/daemon/tests/cli/wrapper-suspend.test.ts` starts the real `cli.ts` wrapper
under an interactive shell in an OS pseudo-terminal. macOS uses zsh; Linux
uses bash. An inert Python executable occupies `claude` on the owned PATH and
records its actual PTY input. No Claude or Codex account, turn, or model is
used. HOME, REMI_HOME, the working directory, and the daemon port are isolated.

The check sends three genuine Ctrl-Z bytes through the outer terminal and
runs the shell's `fg` after each stop. It then checks an external SIGTSTP and
one input chunk containing ordinary bytes around Ctrl-Z. Every cycle must:

- Stop the wrapper and return the terminal's foreground group to the shell.
- Keep the PTY child's distinct process group running.
- Return the foreground group to the wrapper on `fg`, without another stop
  during the quiet interval before the next input.
- Forward subsequent input exactly once, consume Ctrl-Z, and record exactly
  one SIGTSTP followed by one SIGCONT in the wrapper's log.

Ctrl-B d must exit the wrapper, end its child, and return the shell to the
foreground. Cleanup also continues and terminates owned stopped processes on
failure; the runner has a 25-second scenario deadline and a 30-second test
budget. Cleanup targets are the probe's owned descendants; the tests do not
intentionally signal the Bun test runner, its parent, or a live hub.
Once a process is observed exiting, cleanup never signals its saved PID.
Remaining numeric cleanup targets must still match their captured kernel
start time and owned ancestry immediately before each signal; Linux uses a
pidfd bound to the captured incarnation when available. The success check
asserts no wrapper/child cleanup signals.
A second control keeps an actual inert child before its ready marker and
checks that the startup timeout terminates the live owned processes.
Unavailable or denied pidfd acquisition is recorded and uses the same
identity-revalidated numeric fallback as macOS. That fallback has a narrow,
non-atomic check-to-signal race; Linux start ticks also have finite granularity.
An available pidfd binds the signal to its captured process incarnation.
Darwin inspection errors or short records are reported as unknown, not as
confirmed exits. They fail the check and do not bypass descriptor closing or
the independently owned shell's bounded reap. Actual disappearance after the
shell's reap is checked in both controls. Kernel/seccomp pidfd denial and
Darwin inspection failures have not been induced in the measured environment;
no simulated syscall failures stand in for execution of those paths.

Run the source check with the Bun version being evaluated:

```sh
bun test packages/daemon/tests/cli/wrapper-suspend.test.ts
```

The Python runner also accepts a compiled wrapper when `--cli` is omitted:

```sh
bun build --compile --outfile="$TMPDIR/remi-suspend-check" packages/daemon/src/cli.ts
python3 packages/daemon/tests/cli/fixtures/wrapper-suspend-pty.py \
  --root "$(mktemp -d "$TMPDIR/remi-suspend-receipt.XXXXXX")" \
  --bun "$TMPDIR/remi-suspend-check"
```

Set TMPDIR to an owned artifact directory first. Direct runner invocations
retain `result.json`, `transcript.bin`, and `input.hex` for inspection. The
isolated home also contains a generated private identity: keep that directory
private and do not upload its contents. The Bun test removes its temporary
directory after completion.

## Current evidence and remaining report

On 2026-10-10, unchanged source at `3add80b6` passed three Ctrl-Z/fg cycles in
each of six macOS ARM64 executions: an actual scanner/handler/PTYSession
integration, the full source wrapper, and the full compiled wrapper, each on
Bun 1.3.11 and 1.4.2. Child input contained only the expected markers, and
every `fg` returned the wrapper to the foreground. The full-wrapper logs
contained no SIGTSTP between SIGCONT and the next genuine Ctrl-Z. Source and
compiled forms agreed.

This does not reproduce or resolve #375's older compiled `2840382` report
with real Claude Code 2.1.128 in Apple Terminal or iTerm. Its buffered-stdin
replay theory remains unproven. The regression check covers the current
wrapper's real listener and shell job control with an inert child; it does
not cover a real harness's terminal modes or terminal emulator integration.
Runtime listeners, scanner lifecycle, and signal handling remain unchanged.
