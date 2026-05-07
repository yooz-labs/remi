/**
 * Wrapper-mode state for the PTY pass-through path.
 *
 * When remi runs in wrapper mode (parent terminal attached), raw PTY bytes
 * are written directly to stdout via `ptyStdoutFd`. On SIGHUP (terminal
 * closed) or explicit detach (Ctrl+B d), `wrapperDetached` flips and stdout
 * writes stop. The PTY keeps running, waiting for a remote client to attach.
 *
 * Both values are `let` inside this module so they can flip after the PTY
 * callbacks close over them. Callers (cli.ts main-flow, PTY-setup phase,
 * SIGHUP handler) read/write through the getters/setters rather than binding
 * to a captured snapshot.
 */

let ptyStdoutFd: number | null = null;
let wrapperDetached = false;

export function getPtyStdoutFd(): number | null {
  return ptyStdoutFd;
}

export function setPtyStdoutFd(fd: number | null): void {
  ptyStdoutFd = fd;
}

export function isWrapperDetached(): boolean {
  return wrapperDetached;
}

export function setWrapperDetached(value: boolean): void {
  wrapperDetached = value;
}

/** Test-only: reset module state between test cases. */
export function __resetWrapperStateForTests(): void {
  ptyStdoutFd = null;
  wrapperDetached = false;
}
