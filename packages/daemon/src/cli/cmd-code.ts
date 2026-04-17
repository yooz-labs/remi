/**
 * Handler for `remi code [--refresh]` — prints the persistent connection code
 * used for relay auth, optionally rotating it.
 *
 * Without `--refresh`: prints existing code, or generates one if none is set.
 * With `--refresh`: always generates a new code and prompts the user to
 * restart the daemon.
 */

export interface CodeCommandIO {
  readonly out: (msg: string) => void;
}

const defaultIO: CodeCommandIO = {
  out: (msg) => console.log(msg),
};

/** Minimal CodeStore interface the handler depends on. */
export interface CodeStoreLike {
  load(): string | null;
  refresh(): string;
}

export interface CodeCommandOptions {
  readonly refresh?: boolean;
}

export function runCodeCommand(
  store: CodeStoreLike,
  opts: CodeCommandOptions = {},
  io: CodeCommandIO = defaultIO,
): number {
  if (opts.refresh) {
    const newCode = store.refresh();
    io.out(`New permanent connection code: ${newCode}`);
    io.out('Restart the daemon for the new code to take effect.');
  } else {
    const code = store.load();
    if (code) {
      io.out(`Permanent connection code: ${code}`);
      io.out('Use --permanent-code flag when starting daemon to enable this code.');
    } else {
      const newCode = store.refresh();
      io.out(`Permanent connection code: ${newCode} (newly generated)`);
      io.out('Use --permanent-code flag when starting daemon to enable this code.');
    }
  }
  io.out('\nNote: By default, codes rotate on each reconnect. Use --permanent-code to');
  io.out('persist a fixed code (requires Ed25519 authentication for relay connections).');
  return 0;
}
