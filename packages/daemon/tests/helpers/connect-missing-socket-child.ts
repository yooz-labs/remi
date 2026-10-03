/**
 * Child process for `unix-ws.test.ts` (epic #1175, #1181): the very first socket
 * operation of a fresh process is `connectUnixWebSocket` to a path nothing listens on.
 *
 * Bun 1.3.11 emits that connect error synchronously only early in a process's life, so a test
 * that runs after other connections cannot see it. A fresh process can. Exit code: 0 when the
 * promise rejected with a connect error, 3 for an uncaught exception, 4 if it connected.
 */
import { connectUnixWebSocket } from '../../src/harness/codex/unix-ws.ts';

const path = process.argv[2] ?? '';
process.on('uncaughtException', (error) => {
  console.log(`UNCAUGHT ${(error as NodeJS.ErrnoException).code ?? error.message}`);
  process.exit(3);
});
try {
  await connectUnixWebSocket(path, { onMessage() {}, onClose() {} });
  console.log('CONNECTED');
  process.exit(4);
} catch (error) {
  console.log(`REJECTED ${(error as NodeJS.ErrnoException).code ?? 'no-code'}`);
  // Leave time for a late, uncaught second error event before reporting success.
  await new Promise((resolve) => setTimeout(resolve, 100));
  process.exit(0);
}
