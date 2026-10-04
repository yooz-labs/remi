/**
 * Fake `codex` and `claude` executables for the black-box wire tests (#1179).
 *
 * Both are real processes on a PATH of fakes plus `/usr/bin:/bin` only, so no
 * real `claude` or `codex` can ever resolve (a stand-in login shell reports that
 * same PATH, so `resolveShellPath` adds nothing). Each records its argv, cwd and
 * pid under `$FAKE_AGENT_DIR/<name>/` and waits until `release` exists there (60 s
 * at most, so a failed run cannot leave it looping).
 *
 * `FAKE_CODEX_DIR` and `FAKE_CLAUDE_DIR` are passed through the environment, which
 * a hub hands on to the session daemons it spawns, so one fake serves a whole
 * hub-and-child run and records what the CHILD's agent saw.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// The record is written under temporary names and RENAMED into place, `argv` last, so a reader that
// sees a file sees all of it, and one that sees `argv` sees `cwd` and `pid` too. A shell redirect
// creates its file empty and fills it as the loop runs, so waiting for `argv` to EXIST used to return a
// partial list (#1204 round 2, P11). `FAKE_AGENT_RECORD_DELAY` (seconds) puts a pause after each
// argument written, which is how the helper's own test makes the old race certain instead of rare.
const RECORD = `d="$FAKE_AGENT_DIR"
{
  for a in "$@"; do
    printf '%s\\n' "$a"
    if [ -n "$FAKE_AGENT_RECORD_DELAY" ]; then sleep "$FAKE_AGENT_RECORD_DELAY"; fi
  done
} > "$d/argv.tmp"
pwd -P > "$d/cwd.tmp"
echo $$ > "$d/pid.tmp"
mv "$d/cwd.tmp" "$d/cwd"
mv "$d/pid.tmp" "$d/pid"
mv "$d/argv.tmp" "$d/argv"
i=0
while [ ! -e "$d/release" ] && [ $i -lt 600 ]; do
  sleep 0.1
  i=$((i + 1))
done
`;

/** `codex`: records, then waits. It reads no stdin, so a typed byte would stay in the pipe unseen; the Codex launch tests count stdin separately. */
export const FAKE_CODEX = `#!/bin/sh\nFAKE_AGENT_DIR="$FAKE_CODEX_DIR"\n${RECORD}`;

/** `claude`: records, writes the (empty) transcript Claude would write for its `--session-id`, then waits. */
export const FAKE_CLAUDE = `#!/bin/sh
FAKE_AGENT_DIR="$FAKE_CLAUDE_DIR"
d="$FAKE_AGENT_DIR"
project="$HOME/.claude/projects/$(pwd -P | sed 's#/#-#g')"
mkdir -p "$project"
for a in "$@"; do
  case "$a" in
    --session-id) next=1 ;;
    *) if [ "$next" = 1 ]; then : > "$project/$a.jsonl"; next=0; fi ;;
  esac
done
${RECORD}`;

/** A login shell that reports the PATH it is given, so `resolveShellPath` adds nothing. */
export const FAKE_SHELL = '#!/bin/sh\necho "$PATH"\n';

export interface FakeAgents {
  /** What `codex` records: `argv` (one argument per line), `cwd`, `pid`; `release` ends it. */
  readonly codexDir: string;
  readonly claudeDir: string;
  /** The environment overrides that put the fakes first on PATH. */
  readonly env: Record<string, string>;
}

/**
 * Install the fakes under `home`. `codex` and `claude` are each installed only when asked
 * for, so a test can also run with one of them missing from PATH.
 */
export function installFakeAgents(
  home: string,
  which: { codex?: boolean; claude?: boolean } = { codex: true, claude: true },
): FakeAgents {
  const codexDir = path.join(home, 'fake-codex');
  const claudeDir = path.join(home, 'fake-claude');
  const bin = path.join(home, 'fake-bin');
  for (const dir of [codexDir, claudeDir, bin]) fs.mkdirSync(dir, { recursive: true });
  const install = (name: string, text: string): void => {
    fs.writeFileSync(path.join(bin, name), text);
    fs.chmodSync(path.join(bin, name), 0o755);
  };
  // The hub starts its children as `bun cli.ts ...` through PATH, and PATH holds only the fakes
  // and the system directories: put the runtime under test in with them.
  fs.symlinkSync(process.execPath, path.join(bin, 'bun'));
  if (which.codex) install('codex', FAKE_CODEX);
  if (which.claude) install('claude', FAKE_CLAUDE);
  install('sh-path', FAKE_SHELL);
  return {
    codexDir,
    claudeDir,
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      SHELL: path.join(bin, 'sh-path'),
      FAKE_CODEX_DIR: codexDir,
      FAKE_CLAUDE_DIR: claudeDir,
    },
  };
}

/**
 * Wait until a fake agent has recorded its start, and return its arguments. Existence of `argv` is the
 * signal: the fake renames it into place complete, after `cwd` and `pid` (see RECORD), so it is never
 * read half written. `stillRunning` ends the wait early with a clear error when the process that was
 * to start the agent has died.
 */
export async function waitForRecordedArgv(
  dir: string,
  options: { timeoutMs?: number; stillRunning?: () => boolean } = {},
): Promise<string[]> {
  const { timeoutMs = 20_000, stillRunning = () => true } = options;
  const argv = path.join(dir, 'argv');
  const start = Date.now();
  while (!fs.existsSync(argv)) {
    if (!stillRunning()) throw new Error('The process that starts the fake agent exited early');
    if (Date.now() - start > timeoutMs)
      throw new Error('Timed out waiting for the fake agent to start');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return recordedArgv(dir);
}

/** One argument per line, as the fakes record them. */
export function recordedArgv(dir: string): string[] {
  return fs
    .readFileSync(path.join(dir, 'argv'), 'utf-8')
    .split('\n')
    .filter((line, i, lines) => !(i === lines.length - 1 && line === ''));
}

/** Collect a process stream into `sink` as it is written. */
export function collect(stream: ReadableStream<Uint8Array>, sink: { text: string }): void {
  const decoder = new TextDecoder();
  void (async () => {
    for await (const chunk of stream) sink.text += decoder.decode(chunk, { stream: true });
  })().catch(() => {});
}
