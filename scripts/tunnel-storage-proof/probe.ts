import { FFIType, cc, dlopen, ptr } from 'bun:ffi';
// Feasibility experiment only. No daemon caller, authorization, upload route or capability.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import source from './openat.c' with { type: 'file' };
if (!process.argv.includes('--owned-spike')) {
  console.error('Use --owned-spike to run this temporary-filesystem experiment.');
  process.exit(2);
}
const C = fs.constants;
const library = process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
// TinyCC reads the OS filesystem rather than Bun's embedded virtual filesystem.
// Materialize only the binary's trusted helper source, never a transfer byte.
const fixed = await (async () => {
  const helper = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-tunnel-cc-probe-'));
  fs.chmodSync(helper, 0o700);
  try {
    const helperSource = path.join(helper, 'fixed.c');
    fs.writeFileSync(helperSource, Buffer.from(await Bun.file(source).arrayBuffer()), {
      mode: 0o600,
      flag: 'wx',
    });
    return cc({
      source: helperSource,
      flags: ['-nostdlib'],
      symbols: {
        remi_openat_create: {
          args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32],
          returns: FFIType.i32,
        },
      },
    });
  } finally {
    fs.rmSync(helper, { recursive: true, force: true });
  }
})();
const lib = dlopen(library, {
  openat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  mkdirat: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  linkat: {
    args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32],
    returns: FFIType.i32,
  },
  unlinkat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
});
const name = (s: string) => Buffer.from(`${s}\0`);
const loader = dlopen(process.platform === 'darwin' ? library : 'libdl.so.2', {
  dlopen: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.ptr },
  dlsym: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
  dlclose: { args: [FFIType.ptr], returns: FFIType.i32 },
});
const libraryName = name(library);
const handle = loader.symbols.dlopen(ptr(libraryName), 2);
assert(handle !== null && handle > 0, 'native library handle');
const symbolName = name('openat');
const openatAddress = loader.symbols.dlsym(handle, ptr(symbolName));
assert(openatAddress !== null && openatAddress > 0, 'native openat address');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-tunnel-probe-'));
fs.chmodSync(root, 0o700);
fs.mkdirSync(path.join(root, 'private'), { mode: 0o700 });
fs.mkdirSync(path.join(root, 'outside'));
const fd = fs.openSync(path.join(root, 'private'), C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
const opened: number[] = [fd];
const checks: string[] = [];
const record = (s: string) => checks.push(s);
function readBeneath(directory: number, parts: string[]): number | null {
  if (
    !parts.length ||
    parts.some((p) => !p || p === '.' || p === '..' || /[\/\\\u0000-\u001f]/u.test(p))
  )
    return null;
  let current = directory;
  const ancestors: number[] = [];
  try {
    for (const [i, part] of parts.entries()) {
      const component = name(part);
      const last = i === parts.length - 1;
      const result = lib.symbols.openat(
        current,
        ptr(component),
        C.O_RDONLY | C.O_NOFOLLOW | (last ? C.O_NONBLOCK : C.O_DIRECTORY),
      );
      if (result < 0) return null;
      if (last) {
        const st = fs.fstatSync(result);
        if (!st.isFile() || st.nlink !== 1) {
          fs.closeSync(result);
          return null;
        }
        return result;
      }
      ancestors.push(result);
      current = result;
    }
    return null;
  } finally {
    for (const ancestor of ancestors) fs.closeSync(ancestor);
  }
}
try {
  const partial = name('partial');
  const created = fixed.symbols.remi_openat_create(
    openatAddress,
    fd,
    ptr(partial),
    C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW,
    0o600,
  );
  assert(created >= 0, 'exclusive create refused');
  opened.push(created);
  assert.equal(fs.fstatSync(created).mode & 0o777, 0o600, 'creation mode');
  fs.writeSync(created, 'owned probe bytes');
  assert(
    fixed.symbols.remi_openat_create(
      openatAddress,
      fd,
      ptr(partial),
      C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW,
      0o600,
    ) < 0,
    'exclusive create reused file',
  );
  record('exclusive 0600 creation');
  const final = name('final');
  assert.equal(lib.symbols.linkat(fd, ptr(partial), fd, ptr(final), 0), 0, 'publication');
  assert(
    lib.symbols.linkat(fd, ptr(partial), fd, ptr(final), 0) < 0,
    'publication overwrote target',
  );
  assert.equal(lib.symbols.unlinkat(fd, ptr(partial), 0), 0, 'partial retirement');
  assert.equal(fs.fstatSync(created).nlink, 1, 'published link count');
  record('exclusive descriptor-relative publication and retirement');
  const good = readBeneath(fd, ['final']);
  assert(good !== null, 'regular file read');
  opened.push(good);
  assert.equal(fs.readFileSync(good, 'utf8'), 'owned probe bytes');
  record('same regular descriptor read');
  for (const parts of [['..', 'outside'], ['/absolute'], ['final/other'], ['final\\other'], ['']])
    assert.equal(readBeneath(fd, parts), null);
  record('component policy');
  fs.writeFileSync(path.join(root, 'outside', 'marker'), 'outside untouched');
  fs.symlinkSync(path.join(root, 'outside', 'marker'), path.join(root, 'private', 'bad-leaf'));
  fs.symlinkSync(path.join(root, 'outside'), path.join(root, 'private', 'bad-parent'));
  assert.equal(readBeneath(fd, ['bad-leaf']), null);
  assert.equal(readBeneath(fd, ['bad-parent', 'marker']), null);
  record('leaf and ancestor symlink refusal');
  fs.linkSync(path.join(root, 'private', 'final'), path.join(root, 'private', 'another-link'));
  assert.equal(readBeneath(fd, ['final']), null);
  fs.unlinkSync(path.join(root, 'private', 'another-link'));
  record('multiply linked file refusal');
  fs.renameSync(path.join(root, 'private'), path.join(root, 'moved'));
  fs.symlinkSync(path.join(root, 'outside'), path.join(root, 'private'));
  assert.equal(lib.symbols.unlinkat(fd, ptr(final), 0), 0, 'captured directory unlink');
  assert.equal(fs.readFileSync(path.join(root, 'outside', 'marker'), 'utf8'), 'outside untouched');
  assert.equal(fs.existsSync(path.join(root, 'moved', 'final')), false);
  record('captured directory survives path replacement; outside untouched');
  console.log(
    JSON.stringify({
      bun: Bun.version,
      platform: process.platform,
      arch: process.arch,
      checks,
      scope:
        'prototype primitives only; no transfer protocol, authority, decoder, quota or production integration',
    }),
  );
} finally {
  for (const descriptor of opened.reverse()) fs.closeSync(descriptor);
  fixed.close();
  lib.close();
  loader.symbols.dlclose(handle);
  loader.close();
  fs.rmSync(root, { recursive: true, force: true });
}
