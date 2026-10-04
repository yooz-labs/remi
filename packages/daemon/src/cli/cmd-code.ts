/**
 * Handler for `remi code [--refresh]`: prints the permanent relay code, which
 * only `--auth --permanent-code` uses (#1193), optionally rotating it.
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
      io.out(
        'Use --auth --permanent-code when starting the daemon to use this code; the relay stays off without them.',
      );
    } else {
      const newCode = store.refresh();
      io.out(`Permanent connection code: ${newCode} (newly generated)`);
      io.out(
        'Use --auth --permanent-code when starting the daemon to use this code; the relay stays off without them.',
      );
    }
  }
  io.out(
    '\nThis code belongs to the relay. The relay is off by default, and no shipped client connects with a code yet.',
  );
  io.out('It is used only by --auth --permanent-code.');
  return 0;
}
