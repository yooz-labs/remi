/** Owned source hub and inert source session for native Bonjour acceptance (#1575). */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Bonjour } from '../../../../daemon/node_modules/bonjour-service';

if (Bun.version !== '1.3.11') throw new Error('pinned Bun required');

const repository = resolve(import.meta.dir, '../../../../..');
const tailMode = process.argv[2] === 'tail';
const bind = tailMode ? process.env['REMI_RECOVERY_SOURCE_BIND'] : '0.0.0.0';
if (!bind) throw new Error('Tail mode requires an explicitly owned existing address');
const owned = mkdtempSync(join(tmpdir(), 'remi-local-discovery-'));
chmodSync(owned, 0o700);
for (const folder of ['bin', 'home', 'state', 'work'])
  mkdirSync(join(owned, folder), { mode: 0o700 });
process.env['REMI_HOME'] = join(owned, 'state');
const { IdentityStore } = await import('../../../../daemon/src/auth/identity-store.ts');
const { reserveRange } = await import('../../../../daemon/tests/session/port-test-helpers.ts');
const inheritedPath = (process.env['PATH'] ?? '/usr/bin:/bin').split(delimiter).filter(isAbsolute);
const release = join(owned, 'release');
writeFileSync(
  join(owned, 'bin/claude'),
  `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'owned-inert-discovery-cli\\n'; exit 0; fi
while [ ! -e '${release}' ]; do sleep 0.1; done
`,
  { mode: 0o700 },
);
const processes: ReturnType<typeof Bun.spawn>[] = [];
let cleaning: Promise<void> | undefined;
const cleanup = () => {
  cleaning ??= (async () => {
    writeFileSync(release, '');
    for (const child of processes) if (child.exitCode === null) child.kill('SIGTERM');
    const settled = await Promise.race([
      Promise.all(processes.map((child) => child.exited)).then(() => true),
      Bun.sleep(5000).then(() => false),
    ]);
    if (!settled) {
      for (const child of processes) if (child.exitCode === null) child.kill('SIGKILL');
      await Promise.all(processes.map((child) => child.exited));
    }
    rmSync(owned, { recursive: true, force: true });
  })();
  return cleaning;
};
const until = async (condition: () => boolean, milliseconds = 20000) => {
  const deadline = Date.now() + milliseconds;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Owned discovery fixture deadline');
    await Bun.sleep(20);
  }
};
const deadline = setTimeout(() => {
  void cleanup().then(() => process.exit(1));
}, 60000);
process.on('SIGTERM', () => {
  void cleanup().then(() => process.exit(1));
});
try {
  const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
  const input = await lines.next();
  const client = JSON.parse(input.value ?? '') as { publicKey: string };
  const store = new IdentityStore(join(owned, 'state'));
  const machine = await store.generate(undefined, false);
  await store.addAuthorizedKey(client.publicKey, 'owned-native-discovery');
  const port = await reserveRange(22);
  let collisions = 0;
  const launch = (args: string[]) => {
    let advertised = false;
    const child = Bun.spawn(
      [
        process.execPath,
        join(repository, 'packages/daemon/src/cli.ts'),
        ...args,
        '--bind',
        bind,
        '--auth',
        '--no-relay',
        '--no-telegram',
      ],
      {
        cwd: join(owned, 'work'),
        env: {
          HOME: join(owned, 'home'),
          REMI_HOME: join(owned, 'state'),
          PATH: [
            ...new Set([join(owned, 'bin'), dirname(process.execPath), ...inheritedPath]),
          ].join(delimiter),
          NODE_ENV: 'test',
          TERM: 'xterm',
        },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    processes.push(child);
    void (async () => {
      for await (const chunk of child.stdout) {
        const text = new TextDecoder().decode(chunk);
        if (text.includes('[mDNS] Advertising')) advertised = true;
        if (text.includes('Service name is already in use on the network')) collisions += 1;
      }
    })();
    void new Response(child.stderr).text();
    return { process: child, advertised: () => advertised };
  };
  const hub = launch(['serve', '--port', String(port), ...(tailMode ? ['--no-mdns'] : [])]);
  const session = tailMode ? undefined : launch(['--daemon', '--port', String(port + 21)]);
  await until(() => {
    if (hub.process.exitCode !== null || (session && session.process.exitCode !== null))
      throw new Error('Owned source daemon exited');
    if (tailMode) return existsSync(join(owned, 'state/daemon-status.json'));
    return (
      hub.advertised() &&
      session?.advertised() &&
      existsSync(join(owned, 'state', `status-${port + 21}.json`))
    );
  });
  await Bun.sleep(1500);
  const observedTargets: string[] = [];
  if (!tailMode) {
    const observer = new Bonjour();
    const browser = observer.find({ type: 'remi' }, (service) => {
      if (service.txt?.['fingerprint'] === machine.fingerprint) observedTargets.push(service.host);
    });
    await Bun.sleep(1500);
    browser.stop();
    observer.destroy();
  }
  process.stdout.write(
    `${JSON.stringify({ publicKey: machine.publicKey, hubPort: port, sessionPort: port + 21, collisions, observedTargets })}\n`,
  );
  // Swift closes this pipe after stopping its real connection and browser.
  for await (const _ of lines) {
    /* No commands are accepted. */
  }
} finally {
  clearTimeout(deadline);
  await cleanup();
}
