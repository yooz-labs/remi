/// <reference path="./native-assets.d.ts" />
// #1170 internal explicit native journal helper; no startup or active transfer caller.
import { FFIType, cc, dlopen, ptr } from 'bun:ffi';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RecoveryOps } from './recovery';
import source from './recovery-native.c' with { type: 'file' };

export async function recoveryNative() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-recovery-native-'));
  fs.chmodSync(temporary, 0o700);
  const fixed = await (async () => {
    try {
      const filename = path.join(temporary, 'fixed.c');
      fs.writeFileSync(filename, Buffer.from(await Bun.file(source).arrayBuffer()), {
        mode: 0o600,
        flag: 'wx',
      });
      return cc({
        source: filename,
        flags: ['-nostdlib'],
        symbols: {
          remi_recovery_open: {
            args: [
              FFIType.ptr,
              FFIType.ptr,
              FFIType.i32,
              FFIType.i32,
              FFIType.ptr,
              FFIType.i32,
              FFIType.i32,
            ],
            returns: FFIType.i32,
          },
          remi_recovery_lock: {
            args: [FFIType.ptr, FFIType.ptr, FFIType.i32],
            returns: FFIType.i32,
          },
          remi_recovery_cloexec: {
            args: [FFIType.ptr, FFIType.i32],
            returns: FFIType.i32,
          },
          remi_recovery_unlink: {
            args: [FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.ptr],
            returns: FFIType.i32,
          },
        },
      });
    } finally {
      fs.rmSync(temporary, { recursive: true });
    }
  })();
  const darwin = process.platform === 'darwin';
  const library = darwin ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
  let successful = false;
  const closeSetup: (() => void)[] = [() => fixed.close()];
  try {
    const loader = dlopen(darwin ? library : 'libdl.so.2', {
      dlopen: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.ptr },
      dlsym: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
      dlclose: { args: [FFIType.ptr], returns: FFIType.i32 },
    });
    closeSetup.push(() => loader.close());
    const name = (value: string) => Buffer.from(`${value}\0`);
    const encoded = name(library);
    const handle = loader.symbols.dlopen(ptr(encoded), 2);
    assert(handle !== null && handle > 0, 'owned recovery native library handle');
    closeSetup.push(() => {
      loader.symbols.dlclose(handle);
    });
    const symbol = (value: string) => {
      const encoded = name(value);
      const result = loader.symbols.dlsym(handle, ptr(encoded));
      assert(result !== null && result > 0, 'owned recovery native symbol');
      return result;
    };
    const open = symbol('openat');
    const errors = symbol(darwin ? '__error' : '__errno_location');
    const flock = symbol('flock');
    const fcntl = symbol('fcntl');
    const unlinkat = symbol('unlinkat');
    const lib = dlopen(library, {
      mkfifo: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    });
    closeSetup.push(() => lib.close());
    const ops: RecoveryOps = {
      openAt(fd, value, flags) {
        return this.create(fd, value, flags, 0);
      },
      create(fd, value, flags, mode) {
        const encoded = name(value);
        return fixed.symbols.remi_recovery_open(
          open,
          errors,
          darwin ? 1 : 0,
          fd,
          ptr(encoded),
          flags,
          mode,
        );
      },
      link() {
        throw new Error('recovery link unsupported');
      },
      unlink(fd, value) {
        const encoded = name(value);
        return fixed.symbols.remi_recovery_unlink(unlinkat, errors, fd, ptr(encoded));
      },
      lock(fd) {
        return fixed.symbols.remi_recovery_lock(flock, errors, fd);
      },
    };
    successful = true;
    return {
      ops,
      cloexec(fd: number) {
        return fixed.symbols.remi_recovery_cloexec(fcntl, fd);
      },
      fifo(value: string) {
        const encoded = name(value);
        return lib.symbols.mkfifo(ptr(encoded), 0o600);
      },
      close() {
        for (const close of closeSetup.reverse()) close();
      },
    };
  } finally {
    if (!successful) for (const close of closeSetup.reverse()) close();
  }
}
