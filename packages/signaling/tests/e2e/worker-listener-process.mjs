import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
/** Owned Node TCP fixture: Bun 1.3's net half-close behavior cannot preserve this boundary. */
import { createConnection, createServer } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

if (process.versions.bun || Number(process.versions.node.split('.')[0]) < 20)
  throw new Error('Node 20 or newer required for Worker test listener');
const write = (path, value) => {
  writeFileSync(`${path}.next`, JSON.stringify(value));
  renameSync(`${path}.next`, path);
};
if (process.argv[2] === '--half-close-proof') {
  const home = process.argv[3];
  const bytes = randomBytes(128 * 1024);
  const backend = createServer({ allowHalfOpen: true }, (socket) => {
    socket.on('error', () => {});
    socket.on('data', () => {});
    socket.on('end', () => socket.end(bytes));
  });
  backend.listen(0, '127.0.0.1', () =>
    write(join(home, 'backend.json'), { port: backend.address().port }),
  );
  const timer = setInterval(() => {
    const path = join(home, 'target.json');
    if (!existsSync(path)) return;
    clearInterval(timer);
    const { port } = JSON.parse(readFileSync(path, 'utf8'));
    const client = createConnection({ host: '127.0.0.1', port });
    const chunks = [];
    client.on('data', (chunk) => chunks.push(chunk));
    client.on('error', (error) => {
      throw error;
    });
    client.on('end', () => {
      const received = Buffer.concat(chunks);
      write(join(home, 'result.json'), {
        bytes: received.length,
        actual: createHash('sha256').update(received).digest('hex'),
        expected: createHash('sha256').update(bytes).digest('hex'),
      });
      client.destroy();
      backend.close();
    });
    client.end('owned request');
  }, 2);
} else {
  const port = Number(process.argv[2]);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
    throw new Error('Invalid owned listener port');
  let target = null;
  const sockets = new Set();
  const listener = createServer({ allowHalfOpen: true }, (client) => {
    const selected = target;
    if (selected === null) {
      client.destroy();
      return;
    }
    const upstream = createConnection({ host: '127.0.0.1', port: selected, allowHalfOpen: true });
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    sockets.add(client);
    sockets.add(upstream);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.on('close', () => {
      sockets.delete(client);
      upstream.destroy();
    });
    upstream.on('close', () => {
      sockets.delete(upstream);
      if (!upstream.readableEnded) client.destroy();
    });
    client.pipe(upstream);
    upstream.pipe(client);
  });
  let closing = false;
  const close = (id) => {
    if (closing) return;
    closing = true;
    target = null;
    for (const socket of sockets) socket.destroy();
    listener.close(() =>
      process.stdout.write(`${JSON.stringify({ id, ok: true })}\n`, () => process.exit(0)),
    );
  };
  listener.listen(port, '127.0.0.1', () =>
    process.stdout.write(
      `${JSON.stringify({ ready: listener.address().port, pid: process.pid })}\n`,
    ),
  );
  const input = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  input.on('line', (line) => {
    if (line.length > 1024) throw new Error('Invalid listener control');
    const command = JSON.parse(line);
    if (!Number.isSafeInteger(command.id) || command.id < 1)
      throw new Error('Invalid listener control id');
    if (command.action === 'close') {
      close(command.id);
      return;
    }
    if (command.action === 'pause') target = null;
    else if (
      command.action === 'target' &&
      Number.isSafeInteger(command.port) &&
      command.port > 0 &&
      command.port <= 65535
    )
      target = command.port;
    else throw new Error('Invalid listener control action');
    process.stdout.write(`${JSON.stringify({ id: command.id, ok: true })}\n`);
  });
  input.on('close', () => close(0));
  process.on('SIGTERM', () => close(0));
}
