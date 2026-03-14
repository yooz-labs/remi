/**
 * Directory Picker - Interactive numbered list for selecting a recent directory.
 *
 * Shows a numbered list and reads one line from stdin.
 * Must cleanly release stdin before wrapper mode re-opens it in raw mode.
 */

import * as os from 'node:os';
import * as readline from 'node:readline';
import type { RecentDirectory } from '@remi/shared';
import { formatAge } from './ls-client.ts';

/**
 * Display a numbered list of directories and prompt the user to pick one.
 * Returns the selected directory path. Empty input defaults to the first item.
 * Returns null if the user enters an invalid number or EOF/SIGINT occurs.
 */
export async function pickDirectory(
  directories: readonly RecentDirectory[],
): Promise<string | null> {
  if (directories.length === 0) return null;

  const home = os.homedir();
  const shortPath = (p: string): string => (p.startsWith(home) ? `~${p.slice(home.length)}` : p);

  console.log('');
  for (let i = 0; i < directories.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: index within bounds
    const d = directories[i]!;
    const num = `${i + 1}`.padStart(3);
    const dir = shortPath(d.directory);
    const age = formatAge(d.lastUsed);
    console.log(`  ${num}  ${dir}  (${age})`);
  }
  console.log('');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: process.stdin.isTTY ?? false,
  });

  try {
    const answer = await new Promise<string>((resolve, reject) => {
      rl.question('Select directory [1]: ', (ans) => {
        resolve(ans.trim());
      });
      // Handle EOF (Ctrl+D) or SIGINT (Ctrl+C) closing the interface
      process.stdin.once('end', () => {
        reject(new Error('EOF'));
      });
    }).catch(() => null);

    if (answer === null) {
      return null;
    }

    if (answer === '') {
      return directories[0]?.directory ?? null;
    }

    const num = Number.parseInt(answer, 10);
    if (Number.isNaN(num) || num < 1 || num > directories.length) {
      console.error(`Invalid selection: ${answer}`);
      return null;
    }
    return directories[num - 1]?.directory ?? null;
  } finally {
    rl.close();
  }
}
