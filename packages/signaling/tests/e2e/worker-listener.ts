/** A still-bound public test origin; an owned Node child preserves TCP half-closes. */
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WORKER_LISTENER_SCRIPT = fileURLToPath(
  new URL('./worker-listener-process.mjs', import.meta.url),
);
export function workerTestNode(): string {
  const selected = process.env['REMI_WORKER_TEST_NODE'] ?? Bun.which('node');
  const candidates = [selected, '/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'];
  for (const candidate of candidates) if (candidate && existsSync(candidate)) return candidate;
  throw new Error('Node 20+ required for pinned Worker tests; set REMI_WORKER_TEST_NODE');
}
export function workerNodeEnvironment(executable: string): Record<string, string> {
  return { PATH: `${dirname(executable)}:/usr/bin:/bin`, LANG: 'en_US.UTF-8', TMPDIR: tmpdir() };
}
export async function openWorkerListener(port: number) {
  const executable = workerTestNode();
  const proc = Bun.spawn([executable, WORKER_LISTENER_SCRIPT, String(port)], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: workerNodeEnvironment(executable),
  });
  const stderr = new Response(proc.stderr).text();
  let readyResolve!: (port: number) => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<number>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
  let sequence = 0;
  const output = (async () => {
    let buffer = '';
    for await (const data of proc.stdout) {
      buffer += Buffer.from(data).toString('utf8');
      if (buffer.length > 4096) throw new Error('Owned listener control overflow');
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end < 0) break;
        const row = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (
          Number.isSafeInteger(row.ready) &&
          row.ready > 0 &&
          row.ready <= 65535 &&
          row.pid === proc.pid
        )
          readyResolve(row.ready);
        else if (Number.isSafeInteger(row.id) && row.ok === true) {
          pending.get(row.id)?.resolve();
          pending.delete(row.id);
        } else throw new Error('Invalid owned listener control');
      }
    }
  })();
  void output.catch((error) => {
    readyReject(error);
    for (const wait of pending.values()) wait.reject(error);
  });
  void proc.exited.then(async (code) => {
    const detail = await stderr;
    if (code !== 0 || detail) {
      const error = new Error(`Owned test listener exited (${code}): ${detail.slice(0, 1024)}`);
      readyReject(error);
      for (const wait of pending.values()) wait.reject(error);
    }
  });
  const startupDeadline = setTimeout(
    () => readyReject(new Error('Owned listener startup deadline')),
    5000,
  );
  let selected: number;
  try {
    selected = await ready;
  } catch (error) {
    if (proc.exitCode === null) proc.kill('SIGKILL');
    await proc.exited;
    throw error;
  } finally {
    clearTimeout(startupDeadline);
  }
  const command = async (action: string, selectedPort?: number) => {
    if (proc.exitCode !== null) throw new Error('Owned listener unavailable');
    const id = ++sequence;
    const result = new Promise<void>((resolve, reject) => pending.set(id, { resolve, reject }));
    const timeout = setTimeout(() => {
      pending.get(id)?.reject(new Error('Owned listener control deadline'));
      pending.delete(id);
    }, 5000);
    try {
      proc.stdin.write(
        `${JSON.stringify({ id, action, ...(selectedPort === undefined ? {} : { port: selectedPort }) })}\n`,
      );
      await proc.stdin.flush();
      await result;
    } finally {
      clearTimeout(timeout);
    }
  };
  let closing: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${selected}`,
    async forwardTo(value: string) {
      const url = new URL(value);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1')
        throw new Error('Owned backend unavailable');
      await command('target', Number(url.port));
    },
    pause: () => command('pause'),
    close(): Promise<void> {
      closing ??= (async () => {
        try {
          await command('close');
        } finally {
          proc.stdin.end();
          const watchdog = setTimeout(() => {
            if (proc.exitCode === null) proc.kill('SIGKILL');
          }, 5000);
          try {
            await proc.exited;
            await output;
          } finally {
            clearTimeout(watchdog);
          }
        }
        if (proc.exitCode !== 0 || (await stderr))
          throw new Error('Owned listener shutdown failed');
        try {
          process.kill(proc.pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
          throw error;
        }
        throw new Error('Owned listener was not reaped');
      })();
      return closing;
    },
  };
}
