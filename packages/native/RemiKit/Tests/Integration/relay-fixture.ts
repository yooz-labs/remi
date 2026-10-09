/**
 * Owned source hub/child and actual workerd Durable Object for X2 (#1242).
 * The inert CLI process is the existing R6 test driver: it keeps a PTY alive;
 * the real HookServer, permission gate, registry, ChildProxy and answer core run.
 * Only pipe messages cross to the Swift test. No owner state or services are used.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const reference = resolve(process.argv[2] ?? '');
for (const base of ['8fb5b88b', '1d800273']) {
  const check = Bun.spawnSync(['git', 'merge-base', '--is-ancestor', base, 'HEAD'], {
    cwd: reference,
  });
  if (check.exitCode !== 0) throw new Error(`Expected source composite containing ${base}`);
}
const { startWorker } = await import(`${reference}/packages/signaling/tests/e2e/harness.ts`);
const { reserveRange } = await import(
  `${reference}/packages/daemon/tests/session/port-test-helpers.ts`
);
const { CAPABILITY_HEADER } = await import(
  `${reference}/packages/daemon/src/auth/capability-token.ts`
);
const own = mkdtempSync(join(tmpdir(), 'remi-swift-relay-'));
chmodSync(own, 0o700);
for (const name of ['bin', 'state', 'work', 'driver']) mkdirSync(join(own, name), { mode: 0o700 });
writeFileSync(
  join(own, 'bin/claude'),
  `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'owned-claude-fixture\\n'; exit 0; fi
d="$FAKE_CLAUDE_DIR"
echo $$ > "$d/pid"
project="$HOME/.claude/projects/$(pwd -P | sed 's#/#-#g')"
mkdir -p "$project"
: > "$project/$2.jsonl"
i=0
while [ ! -e "$d/release" ] && [ $i -lt 600 ]; do sleep 0.1; i=$((i + 1)); done
`,
  { mode: 0o700 },
);
const processes: ReturnType<typeof Bun.spawn>[] = [];
let control: WebSocket | undefined;
let hookAbort: AbortController | undefined;
let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
let ended = false;
let cleanupPromise: Promise<void> | undefined;
let admitted = false;
let receivedOffer: Record<string, unknown> | undefined;
let comparison: Record<string, unknown> | undefined;
const out = (message: object) => process.stdout.write(`${JSON.stringify(message)}\n`);
async function until(check: () => boolean, name: string, milliseconds = 20000) {
  const deadline = Date.now() + milliseconds;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Deadline: ${name}`);
    await Bun.sleep(20);
  }
}
function launch(args: string[]) {
  const child = Bun.spawn([process.execPath, `${reference}/packages/daemon/src/cli.ts`, ...args], {
    cwd: join(own, 'work'),
    env: {
      HOME: own,
      REMI_HOME: join(own, 'state'),
      PATH: `${join(own, 'bin')}:/usr/bin:/bin`,
      NODE_ENV: 'test',
      TERM: 'xterm-256color',
      FAKE_CLAUDE_DIR: join(own, 'driver'),
    },
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  processes.push(child);
  void (async () => {
    for await (const chunk of child.stderr) {
      const text = new TextDecoder().decode(chunk);
      if (text.includes('Relay control admitted')) admitted = true;
    }
  })();
  void new Response(child.stdout).text();
  return child;
}
function processDescription(pid: number): string {
  return new TextDecoder()
    .decode(Bun.spawnSync(['ps', '-p', String(pid), '-o', 'ppid=', '-o', 'command=']).stdout)
    .trim();
}
function ownedChildProcesses(): Map<number, string> {
  const children = new Map<number, string>();
  const folder = join(own, 'state/live-sessions');
  if (!existsSync(folder)) return children;
  for (const file of readdirSync(folder).filter((name) => name.endsWith('.json'))) {
    const entry = JSON.parse(readFileSync(join(folder, file), 'utf8')) as Record<string, unknown>;
    if (entry['projectPath'] !== join(own, 'work') || typeof entry['pid'] !== 'number') continue;
    const description = processDescription(entry['pid']);
    const parent = Number(description.split(/\s+/, 1)[0]);
    if (
      !processes.some((hub) => hub.pid === parent) ||
      !description.includes(`${reference}/packages/daemon/src/cli.ts`)
    )
      continue;
    children.set(entry['pid'], description);
    if (typeof entry['claudeChildPid'] === 'number') {
      const childDescription = processDescription(entry['claudeChildPid']);
      if (childDescription.includes(join(own, 'bin/claude')))
        children.set(entry['claudeChildPid'], childDescription);
    }
  }
  return children;
}
function cleanup(): Promise<void> {
  cleanupPromise ??= (async () => {
    ended = true;
    hookAbort?.abort();
    control?.close();
    const children = ownedChildProcesses();
    writeFileSync(join(own, 'driver/release'), '');
    // Stop only the child daemons whose registry, project path, command and parent belong here.
    for (const [pid, description] of children) {
      if (
        description.includes(`${reference}/packages/daemon/src/cli.ts`) &&
        processDescription(pid) === description
      ) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
    }
    for (const child of processes) {
      if (child.exitCode === null) child.kill('SIGTERM');
      await until(() => child.exitCode !== null, 'owned hub cleanup', 5000);
      await child.exited;
    }
    await until(
      () =>
        [...children].every(
          ([pid, description]) =>
            processDescription(pid).replace(/^\d+\s+/, '') !== description.replace(/^\d+\s+/, ''),
        ),
      'owned child cleanup',
      5000,
    );
    await worker?.stop();
    rmSync(own, { recursive: true, force: true });
  })();
  return cleanupPromise;
}
const deadline = setTimeout(() => {
  void cleanup().then(() => process.exit(1));
}, 180000);
process.on('SIGTERM', () => {
  void cleanup().then(() => process.exit(1));
});
try {
  worker = await startWorker();
  const port = await reserveRange(1, 50, '127.0.0.1');
  const hubArguments = [
    'serve',
    '--relay',
    '--signaling-url',
    worker.wsUrl,
    '--port',
    String(port),
    '--no-mdns',
    '--no-telegram',
  ];
  let hub = launch(hubArguments);
  await until(() => {
    if (hub.exitCode !== null) throw new Error('Source hub exited');
    return admitted;
  }, 'source hub admission');
  const capability = readFileSync(join(own, 'state/capability.key'), 'utf8').trim();
  control = new WebSocket(`ws://127.0.0.1:${port}/relay-control`, {
    headers: { [CAPABILITY_HEADER]: capability },
  } as never);
  control.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as Record<string, unknown>;
    if (message['t'] === 'offer') {
      receivedOffer = message;
      out({ kind: 'offer', token: message['token'], directory: join(own, 'work') });
    } else if (message['t'] === 'compare') {
      comparison = message;
      out({ kind: 'compare', fingerprint: message['fingerprint'] });
    }
  };
  await new Promise<void>((done, reject) => {
    if (!control) return reject(new Error('Missing local control'));
    control.onopen = () => done();
    control.onerror = () => reject(new Error('Local control refused'));
  });
  control.send(JSON.stringify({ t: 'pair', id: 'swift-pair' }));
  let pending = '';
  for await (const chunk of Bun.stdin.stream()) {
    pending += new TextDecoder().decode(chunk);
    let newline = pending.indexOf('\n');
    while (newline >= 0) {
      const command = JSON.parse(pending.slice(0, newline)) as Record<string, unknown>;
      pending = pending.slice(newline + 1);
      if (command['kind'] === 'confirm') {
        if (!receivedOffer || !comparison || command['fingerprint'] !== comparison['fingerprint']) {
          throw new Error('Swift and source hub fingerprints differ');
        }
        control.send(
          JSON.stringify({
            t: 'confirm',
            id: 'swift-pair',
            offerId: receivedOffer['offerId'],
            connectionId: comparison['connectionId'],
            fingerprint: comparison['fingerprint'],
            accept: true,
          }),
        );
      } else if (command['kind'] === 'question') {
        let entry: Record<string, unknown> | undefined;
        await until(() => {
          const folder = join(own, 'state/live-sessions');
          const files = readdirSync(folder).filter((name) => name.endsWith('.json'));
          if (files.length !== 1) return false;
          entry = JSON.parse(readFileSync(join(folder, files[0] ?? ''), 'utf8')) as Record<
            string,
            unknown
          >;
          return typeof entry['claudeChildPid'] === 'number' && existsSync(join(own, 'driver/pid'));
        }, 'actual child session');
        const store = JSON.parse(readFileSync(join(own, 'state/sessions.json'), 'utf8')) as {
          sessions: { remiSessionId: string; claudeSessionId: string }[];
        };
        const record = store.sessions.find((item) => item.remiSessionId === entry?.['sessionId']);
        if (!record || !entry) throw new Error('Missing source binding');
        hookAbort = new AbortController();
        void fetch(`http://127.0.0.1:${entry['hookPort']}/hooks`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: hookAbort.signal,
          body: JSON.stringify({
            hook_event_name: 'PermissionRequest',
            session_id: record.claudeSessionId,
            cwd: join(own, 'work'),
            permission_mode: 'default',
            tool_name: 'Bash',
            tool_input: { command: 'printf OWNED_SWIFT_RELAY' },
            permission_suggestions: [],
          }),
        })
          .then((response) => response.json())
          .then((body) => out({ kind: 'effect', body }))
          .catch(() => {
            if (!ended) out({ kind: 'hook-aborted' });
          });
      } else if (command['kind'] === 'restart') {
        control?.close();
        control = undefined;
        hub.kill('SIGTERM');
        await hub.exited;
        admitted = false;
        hub = launch(hubArguments);
        await until(() => admitted, 'restarted source hub admission');
        out({ kind: 'restarted' });
      } else if (command['kind'] === 'stop') {
        await cleanup();
        process.exit(0);
      }
      newline = pending.indexOf('\n');
    }
  }
} finally {
  clearTimeout(deadline);
  await cleanup();
}
