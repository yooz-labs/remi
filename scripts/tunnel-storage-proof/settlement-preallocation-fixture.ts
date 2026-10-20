// Reuse the predecessor's actual allocation syscall wrapper; fixture only.
import { FFIType, cc, dlopen, ptr } from 'bun:ffi';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import source from './openat.c' with { type: 'file' };

export async function preallocationFixture(directory: string) {
  const filename = path.join(directory, 'preallocate.c');
  fs.writeFileSync(filename, Buffer.from(await Bun.file(source).arrayBuffer()), {
    mode: 0o600,
    flag: 'wx',
  });
  const fixed = cc({
    source: filename,
    flags: ['-nostdlib'],
    symbols: {
      remi_preallocate_owned: {
        args: [FFIType.ptr, FFIType.i32, FFIType.i32],
        returns: FFIType.i32,
      },
    },
  });
  const darwin = process.platform === 'darwin';
  const library = darwin ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
  const loader = dlopen(darwin ? library : 'libdl.so.2', {
    dlopen: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.ptr },
    dlsym: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    dlclose: { args: [FFIType.ptr], returns: FFIType.i32 },
  });
  let handle: ReturnType<typeof loader.symbols.dlopen> = null;
  try {
    const encoded = Buffer.from(`${library}\0`);
    handle = loader.symbols.dlopen(ptr(encoded), 2);
    assert(handle !== null && handle > 0);
    const symbol = Buffer.from(`${darwin ? 'fcntl' : 'fallocate'}\0`);
    const allocate = loader.symbols.dlsym(handle, ptr(symbol));
    assert(allocate !== null && allocate > 0);
    return {
      preallocate(fd: number) {
        return fixed.symbols.remi_preallocate_owned(allocate, darwin ? 1 : 0, fd);
      },
      close() {
        if (handle !== null) loader.symbols.dlclose(handle);
        loader.close();
        fixed.close();
      },
    };
  } catch (error) {
    if (handle !== null) loader.symbols.dlclose(handle);
    loader.close();
    fixed.close();
    throw error;
  } finally {
    fs.unlinkSync(filename);
  }
}
