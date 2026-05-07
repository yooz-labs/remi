/**
 * Unified logging facade for the daemon CLI.
 *
 * In wrapper mode (terminal attached) messages go to the shared log file so
 * they don't clobber Claude's TUI. In daemon-mode (--daemon) they go to the
 * standard console streams because launchd/systemd capture those.
 *
 * The wrapper flag defaults to true; arg parsing in cli.ts flips it to false
 * via `setWrapperMode(false)` when --daemon is set.
 */

type LogWriter = (msg: string) => void;

let wrapperMode = true;
let writer: LogWriter = () => {};
let consoleLog: (...args: unknown[]) => void = console.log.bind(console);
let consoleError: (...args: unknown[]) => void = console.error.bind(console);

export interface LoggerConfig {
  writeLog: LogWriter;
  consoleLog?: (...args: unknown[]) => void;
  consoleError?: (...args: unknown[]) => void;
}

/** Inject the file writer (production wires this to writeToLog). */
export function configureLogger(config: LoggerConfig): void {
  writer = config.writeLog;
  if (config.consoleLog) consoleLog = config.consoleLog;
  if (config.consoleError) consoleError = config.consoleError;
}

export function setWrapperMode(value: boolean): void {
  wrapperMode = value;
}

export function isWrapperMode(): boolean {
  return wrapperMode;
}

export function log(...args: unknown[]): void {
  if (wrapperMode) {
    writer(args.map(String).join(' '));
  } else {
    consoleLog(...args);
  }
}

export function logError(...args: unknown[]): void {
  if (wrapperMode) {
    writer(`[error] ${args.map(String).join(' ')}`);
  } else {
    consoleError(...args);
  }
}

/** Test-only: reset module state between test cases. */
export function __resetLoggerForTests(): void {
  wrapperMode = true;
  writer = () => {};
  consoleLog = console.log.bind(console);
  consoleError = console.error.bind(console);
}
