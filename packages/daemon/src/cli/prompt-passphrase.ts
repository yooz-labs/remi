/**
 * Shared passphrase prompt for CLI operations.
 *
 * Reads a passphrase from stdin with masked echo (*).
 * Falls back to REMI_PASSPHRASE env var when stdin is not a TTY.
 */

export async function promptPassphrase(label = 'Passphrase'): Promise<string> {
  // Check env var first
  const envPassphrase = process.env['REMI_PASSPHRASE'];
  if (envPassphrase) return envPassphrase;

  if (!process.stdin.isTTY) {
    console.error('Cannot prompt for passphrase: stdin is not a terminal.');
    console.error('Set the REMI_PASSPHRASE environment variable instead.');
    process.exit(1);
  }

  process.stdout.write(`${label}: `);

  return new Promise((resolve, reject) => {
    let input = '';
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');

    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          process.stdin.setRawMode?.(false);
          process.stdin.pause();
          process.stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(input);
          return;
        }
        if (ch === '\x7f' || ch === '\b') {
          if (input.length > 0) {
            input = input.slice(0, -1);
            process.stdout.write('\b \b');
          }
        } else if (ch === '\x03') {
          process.stdout.write('\n');
          process.exit(130);
        } else if (ch >= ' ') {
          input += ch;
          process.stdout.write('*');
        }
      }
    };

    process.stdin.on('data', onData);
    process.stdin.on('error', (err: Error) => {
      process.stdin.setRawMode?.(false);
      reject(new Error(`Failed to read passphrase: ${err.message}`));
    });
  });
}
