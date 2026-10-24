/** Inert owned PTY process for capture proofs; receives control through private fixture files. */
import * as fs from 'node:fs';

export function runOwnedTerminalOutputChild(prefix: string, initial: string): Promise<never> {
  Reflect.deleteProperty(process.env, 'NO_COLOR');
  const receipt = (suffix: string, value: unknown) => {
    fs.writeFileSync(`${prefix}.${suffix}.next`, JSON.stringify(value));
    fs.renameSync(`${prefix}.${suffix}.next`, `${prefix}.${suffix}`);
  };
  let inputBytes = 0;
  process.stdin.setRawMode(true);
  process.stdin.on('data', (data: Buffer) => {
    inputBytes += data.byteLength;
  });
  process.stdin.resume();
  const size = () => {
    // Bun 1.3.11 getWindowSize returns cached columns/rows. Query the actual
    // owned terminal descriptor so SIGWINCH delivery cannot race this oracle.
    const result = Bun.spawnSync(['/bin/stty', 'size'], {
      stdin: 0,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (result.exitCode !== 0) throw new Error('Owned terminal geometry query failed');
    const [rows, columns] = result.stdout.toString().trim().split(/\s+/u).map(Number);
    if (!rows || !columns) throw new Error('Owned terminal geometry is invalid');
    return [columns, rows];
  };
  let sequence = 0;
  const timer = setInterval(() => {
    if (!fs.existsSync(`${prefix}.command`)) return;
    const command = JSON.parse(fs.readFileSync(`${prefix}.command`, 'utf8')) as {
      sequence: number;
      kind: 'output' | 'size';
      output: string;
    };
    if (command.sequence <= sequence) return;
    sequence = command.sequence;
    const acknowledge = () => receipt('ack', { sequence, size: size() });
    if (command.kind === 'size') acknowledge();
    else process.stdout.write(Buffer.from(command.output, 'base64'), acknowledge);
  }, 5);
  process.on('SIGTERM', () => {
    clearInterval(timer);
    receipt('input', { inputBytes, pid: process.pid });
    process.exit(0);
  });
  process.stdout.write(initial, () => {
    receipt('ready', { size: size(), pid: process.pid });
  });
  return new Promise(() => {});
}

if (import.meta.main) {
  const index = process.argv.indexOf('--owned-output-child');
  const prefix = process.argv[index + 1];
  if (index < 0 || !prefix) throw new Error('Owned output child arguments absent');
  await runOwnedTerminalOutputChild(prefix, process.argv[index + 2] ?? 'FIRST');
}
