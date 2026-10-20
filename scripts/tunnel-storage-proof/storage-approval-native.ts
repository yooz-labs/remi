import { FFIType, dlopen, ptr } from 'bun:ffi';
// #1170 proof-only native helper preparation and identity checks.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import nativeSource from './openat.c' with { type: 'file' };
import type { PrivateOps } from './private-copy';
import nativeOpsSource from './storage-approval-native.c' with { type: 'file' };
import {
  linuxNativeHelperManifestJson,
  linuxNativeHelperManifestSha256,
} from './storage-approval-native.generated';

export interface OwnedFileIdentity {
  device: string;
  inode: string;
  uid: string;
  nlink: string;
  size: number;
  mode: number;
}

export interface PreparedNativeHelper {
  fixtureRoot: string;
  directory: string;
  sourcePath: string;
  sourceSha256: string;
  sourceIdentity: OwnedFileIdentity;
  opsSourcePath: string;
  opsSourceSha256: string;
  opsSourceIdentity: OwnedFileIdentity;
  libraryName: string;
  libraryPath: string;
  librarySha256: string;
  libraryIdentity: OwnedFileIdentity;
  compilerPath: string;
  compilerVersion: string;
  compilerSha256: string;
  compilerTargetTriple: string;
  compilerResolutionMethod: 'xcrun' | 'embedded-prepared';
  compilerLauncherPath: string | null;
  compilerLauncherVersion: string | null;
  compilerLauncherSha256: string | null;
  compilerSdkPath: string | null;
  compilerSdkVersion: string | null;
  compilerImageIndexReference: string | null;
  compilerImageIndexDigest: string | null;
  compilerContainerImageDotImageId: string | null;
  compilerImagePlatformDigest: string | null;
  compilerImagePlatform: string | null;
  compilerOsRelease: string | null;
  compilerLibcVersion: string | null;
  compilerPreparationDurationMs: number | null;
  compilerPreparationContainerDurationMs: number | null;
  supportManifestSha256: string | null;
  libraryElfMachine: string | null;
  libraryNeeded: string[];
  libraryRequiredGlibcVersions: string[];
  compileCommand: string[];
  setupDurationMs: number;
  platform: string;
  arch: string;
}

export interface LoadedNativeHelperEvidence {
  sourceSha256: string;
  opsSourceSha256: string;
  librarySha256: string;
  sourceIdentity: OwnedFileIdentity;
  opsSourceIdentity: OwnedFileIdentity;
  libraryIdentity: OwnedFileIdentity;
  compilerPath: string;
  compilerVersion: string;
  compilerSha256: string;
  compilerTargetTriple: string;
  compilerResolutionMethod: 'xcrun' | 'embedded-prepared';
  compilerLauncherPath: string | null;
  compilerLauncherVersion: string | null;
  compilerLauncherSha256: string | null;
  compilerSdkPath: string | null;
  compilerSdkVersion: string | null;
  compilerImageIndexReference: string | null;
  compilerImageIndexDigest: string | null;
  compilerContainerImageDotImageId: string | null;
  compilerImagePlatformDigest: string | null;
  compilerImagePlatform: string | null;
  compilerOsRelease: string | null;
  compilerLibcVersion: string | null;
  compilerPreparationDurationMs: number | null;
  compilerPreparationContainerDurationMs: number | null;
  supportManifestSha256: string | null;
  libraryElfMachine: string | null;
  libraryNeeded: string[];
  libraryRequiredGlibcVersions: string[];
  compileCommand: string[];
  setupDurationMs: number;
  platform: string;
  arch: string;
}

const OWNER_DIRECTORY_MODE = 0o700;
const OWNER_SOURCE_MODE = 0o600;
const OWNER_LIBRARY_MODE = 0o700;
const COMPILER_TIMEOUT_MS = 15_000;
const MAX_COMPILER_OUTPUT_BYTES = 32 * 1024;
const MAX_PREPARED_LIBRARY_BYTES = 4 * 1024 * 1024;
const LINUX_COMPILER_IMAGE_INDEX_NAME = 'docker.io/library/golang';
const LINUX_COMPILER_IMAGE_INDEX_DIGEST =
  'sha256:0f063af2d465d8dcae54cce04278ada488b96f77b42449c8d071e47d016cc65a';
const LINUX_COMPILER_IMAGE_INDEX_REFERENCE =
  `${LINUX_COMPILER_IMAGE_INDEX_NAME}@${LINUX_COMPILER_IMAGE_INDEX_DIGEST}` as const;
const LINUX_COMPILER_PLATFORM_DIGESTS = {
  arm64: 'sha256:4364967143356b3498a4bcec1f1a2a2129495333f85f8f05b4e4dbb9ef70d287',
  x64: 'sha256:af00f232205a01baf323bddc5bb4a4ea2e4cbf49e8ccc988beb2558d0f9c882a',
} as const;

interface EmbeddedLinuxHelperAsset {
  compilerImageIndexId: string;
  platform: 'linux/arm64' | 'linux/amd64';
  platformManifestDigest: string;
  containerImageDotImageId: string;
  osRelease: string;
  libcVersion: string;
  compilerPath: string;
  compilerVersion: string;
  compilerSha256: string;
  compilerTargetTriple: string;
  compilerPreparationDurationMs: number;
  compilerPreparationContainerDurationMs: number;
  compileCommand: string[];
  sourceSha256: string;
  opsSourceSha256: string;
  library: {
    name: string;
    sha256: string;
    base64: string;
    size: number;
    elfMachine: string;
    needed: string[];
    requiredGlibcVersions: string[];
  };
}

interface EmbeddedLinuxHelperManifest {
  schemaVersion: 1;
  compilerImageIndexReference: typeof LINUX_COMPILER_IMAGE_INDEX_REFERENCE;
  compilerImageIndexDigest: typeof LINUX_COMPILER_IMAGE_INDEX_DIGEST;
  assets: Record<'arm64' | 'x64', EmbeddedLinuxHelperAsset>;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function currentUid(): bigint {
  const uid = process.getuid?.();
  assert(uid !== undefined, 'owned native helper requires a process uid');
  return BigInt(uid);
}

function expectedLibraryName(): string {
  if (process.platform === 'darwin') return 'libremi-openat.dylib';
  if (process.platform === 'linux') return 'libremi-openat.so';
  throw new Error(`unsupported storage approval proof platform: ${process.platform}`);
}

function assertOwnedDirectory(directory: string, mode: number, witness: string): void {
  const stat = fs.lstatSync(directory, { bigint: true });
  assert(
    stat.isDirectory() && stat.uid === currentUid() && (stat.mode & 0o777n) === BigInt(mode),
    `${witness}: directory is owned and mode ${mode.toString(8)}`,
  );
  assert.equal(fs.realpathSync(directory), directory, `${witness}: directory path is canonical`);
}

function identity(stat: fs.BigIntStats): OwnedFileIdentity {
  return {
    device: String(stat.dev),
    inode: String(stat.ino),
    uid: String(stat.uid),
    nlink: String(stat.nlink),
    size: Number(stat.size),
    mode: Number(stat.mode & 0o777n),
  };
}

function sameIdentity(left: OwnedFileIdentity, right: OwnedFileIdentity): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.uid === right.uid &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mode === right.mode
  );
}

function hashOwnedFile(
  filename: string,
  expectedMode: number,
  witness: string,
): { sha256: string; identity: OwnedFileIdentity } {
  const beforePath = fs.lstatSync(filename, { bigint: true });
  assert(
    beforePath.isFile() &&
      beforePath.nlink === 1n &&
      beforePath.uid === currentUid() &&
      (beforePath.mode & 0o777n) === BigInt(expectedMode),
    `${witness}: regular, single-link file is owned with mode ${expectedMode.toString(8)}`,
  );
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const beforeFD = fs.fstatSync(fd, { bigint: true });
    assert(
      beforeFD.isFile() &&
        beforeFD.dev === beforePath.dev &&
        beforeFD.ino === beforePath.ino &&
        beforeFD.nlink === 1n &&
        beforeFD.uid === currentUid() &&
        (beforeFD.mode & 0o777n) === BigInt(expectedMode),
      `${witness}: opened descriptor matches the owned path identity`,
    );
    const digest = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let offset = 0;
    while (offset < Number(beforeFD.size)) {
      const count = fs.readSync(
        fd,
        buffer,
        0,
        Math.min(buffer.length, Number(beforeFD.size) - offset),
        offset,
      );
      assert(count > 0, `${witness}: owned descriptor hash read made progress`);
      digest.update(buffer.subarray(0, count));
      offset += count;
    }
    const afterFD = fs.fstatSync(fd, { bigint: true });
    const afterPath = fs.lstatSync(filename, { bigint: true });
    const beforeIdentity = identity(beforeFD);
    assert(
      sameIdentity(beforeIdentity, identity(afterFD)),
      `${witness}: descriptor identity stayed stable while hashing`,
    );
    assert(
      sameIdentity(beforeIdentity, identity(afterPath)),
      `${witness}: owned path identity stayed stable while hashing`,
    );
    return { sha256: digest.digest('hex'), identity: beforeIdentity };
  } finally {
    fs.closeSync(fd);
  }
}

function compilerOutput(result: ReturnType<typeof spawnSync>, witness: string): string {
  if (result.error) throw new Error(`${witness}: ${result.error.message}`);
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? '');
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr ?? '');
  assert(
    stdout.byteLength + stderr.byteLength <= MAX_COMPILER_OUTPUT_BYTES,
    `${witness}: compiler output stayed within ${MAX_COMPILER_OUTPUT_BYTES} bytes`,
  );
  assert.equal(result.signal, null, `${witness}: compiler process did not receive a signal`);
  assert.equal(
    result.status,
    0,
    `${witness}: compiler exited successfully: ${stderr.toString('utf8')}`,
  );
  return stdout.toString('utf8').trim();
}

interface CompilerBinding {
  compilerPath: string;
  compilerVersion: string;
  compilerSha256: string;
  compilerTargetTriple: string;
  compilerResolutionMethod: 'xcrun' | 'embedded-prepared';
  compilerLauncherPath: string | null;
  compilerLauncherVersion: string | null;
  compilerLauncherSha256: string | null;
  compilerSdkPath: string | null;
  compilerSdkVersion: string | null;
  compilerImageIndexReference: string | null;
  compilerImageIndexDigest: string | null;
  compilerContainerImageDotImageId: string | null;
  compilerImagePlatformDigest: string | null;
  compilerImagePlatform: string | null;
  compilerOsRelease: string | null;
  compilerLibcVersion: string | null;
  compilerPreparationDurationMs: number | null;
  compilerPreparationContainerDurationMs: number | null;
  supportManifestSha256: string | null;
  libraryElfMachine: string | null;
  libraryNeeded: string[];
  libraryRequiredGlibcVersions: string[];
}

function compilerEnvironment(directory: string): Record<string, string> {
  return {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    LANG: 'en_US.UTF-8',
    TMPDIR: directory,
  };
}

function localToolOutput(
  executable: string,
  args: string[],
  directory: string,
  witness: string,
): string {
  const result = spawnSync(executable, args, {
    cwd: directory,
    env: compilerEnvironment(directory),
    encoding: 'buffer',
    timeout: COMPILER_TIMEOUT_MS,
    maxBuffer: MAX_COMPILER_OUTPUT_BYTES,
  });
  return compilerOutput(result, witness);
}

function resolveMacCompiler(directory: string): CompilerBinding {
  assert.equal(process.platform, 'darwin', 'xcrun compiler resolution is macOS-only');
  let compilerLauncherPath: string | null = null;
  let compilerLauncherVersion: string | null = null;
  let compilerLauncherSha256: string | null = null;
  let compilerSdkPath: string | null = null;
  let compilerSdkVersion: string | null = null;

  const launcher = '/usr/bin/xcrun';
  fs.accessSync(launcher, fs.constants.X_OK);
  compilerLauncherPath = fs.realpathSync(launcher);
  compilerLauncherSha256 = sha256(fs.readFileSync(compilerLauncherPath));
  compilerLauncherVersion =
    localToolOutput(compilerLauncherPath, ['--version'], directory, 'xcrun launcher version').split(
      /\r?\n/,
      1,
    )[0] ?? '';
  const selectedCompiler = localToolOutput(
    compilerLauncherPath,
    ['--sdk', 'macosx', '--find', 'clang'],
    directory,
    'xcrun selected clang path',
  );
  const compilerPath = fs.realpathSync(selectedCompiler);
  fs.accessSync(compilerPath, fs.constants.X_OK);
  compilerSdkPath = fs.realpathSync(
    localToolOutput(
      compilerLauncherPath,
      ['--sdk', 'macosx', '--show-sdk-path'],
      directory,
      'xcrun selected macOS SDK path',
    ),
  );
  compilerSdkVersion =
    localToolOutput(
      compilerLauncherPath,
      ['--sdk', 'macosx', '--show-sdk-version'],
      directory,
      'xcrun selected macOS SDK version',
    ).split(/\r?\n/, 1)[0] ?? '';

  const compilerVersion =
    localToolOutput(
      compilerPath,
      ['--version'],
      directory,
      'resolved native compiler version',
    ).split(/\r?\n/, 1)[0] ?? '';
  const compilerTargetTriple =
    localToolOutput(
      compilerPath,
      ['-dumpmachine'],
      directory,
      'resolved native compiler target triple',
    ).split(/\r?\n/, 1)[0] ?? '';
  const compilerSha256 = sha256(fs.readFileSync(compilerPath));
  assert(compilerVersion.length > 0, 'resolved native compiler version is recorded');
  assert(compilerTargetTriple.length > 0, 'resolved native compiler target is recorded');
  if (process.platform === 'darwin') {
    assert(compilerLauncherPath, 'xcrun launcher path is recorded');
    assert(compilerLauncherVersion, 'xcrun launcher version is recorded');
    assert(compilerLauncherSha256, 'xcrun launcher hash is recorded');
    assert(compilerSdkPath, 'selected macOS SDK path is recorded');
    assert(compilerSdkVersion, 'selected macOS SDK version is recorded');
  }
  return {
    compilerPath,
    compilerVersion,
    compilerSha256,
    compilerTargetTriple,
    compilerResolutionMethod: 'xcrun',
    compilerLauncherPath,
    compilerLauncherVersion,
    compilerLauncherSha256,
    compilerSdkPath,
    compilerSdkVersion,
    compilerImageIndexReference: null,
    compilerImageIndexDigest: null,
    compilerContainerImageDotImageId: null,
    compilerImagePlatformDigest: null,
    compilerImagePlatform: null,
    compilerOsRelease: null,
    compilerLibcVersion: null,
    compilerPreparationDurationMs: null,
    compilerPreparationContainerDurationMs: null,
    supportManifestSha256: null,
    libraryElfMachine: null,
    libraryNeeded: [],
    libraryRequiredGlibcVersions: [],
  };
}

function embeddedLinuxHelper(
  sourceSha256: string,
  opsSourceSha256: string,
): {
  arch: 'arm64' | 'x64';
  asset: EmbeddedLinuxHelperAsset;
  libraryBytes: Buffer;
  supportManifestSha256: string;
} {
  assert.equal(process.platform, 'linux', 'embedded Linux helper is Linux-only');
  assert(
    process.arch === 'arm64' || process.arch === 'x64',
    `unsupported Linux helper architecture: ${process.arch}`,
  );
  assert(
    linuxNativeHelperManifestJson.length > 0,
    'compiled Linux proof includes the S1-prepared helper manifest',
  );
  assert(
    /^[a-f0-9]{64}$/.test(linuxNativeHelperManifestSha256),
    'compiled Linux proof includes a canonical helper manifest hash',
  );
  const manifestBytes = Buffer.from(linuxNativeHelperManifestJson, 'utf8');
  const supportManifestSha256 = sha256(manifestBytes);
  assert.equal(
    supportManifestSha256,
    linuxNativeHelperManifestSha256,
    'embedded Linux helper manifest matches its S1 hash',
  );
  const manifest = JSON.parse(linuxNativeHelperManifestJson) as EmbeddedLinuxHelperManifest;
  assert.equal(manifest.schemaVersion, 1, 'embedded Linux helper manifest schema is supported');
  assert.equal(
    manifest.compilerImageIndexReference,
    LINUX_COMPILER_IMAGE_INDEX_REFERENCE,
    'embedded Linux helper names the approved immutable compiler image index',
  );
  assert.equal(
    manifest.compilerImageIndexDigest,
    LINUX_COMPILER_IMAGE_INDEX_DIGEST,
    'embedded Linux helper compiler index digest matches the approved pin',
  );
  assert.deepEqual(
    Object.keys(manifest.assets).sort(),
    ['arm64', 'x64'],
    'embedded helper bundle contains exactly the supported Linux architectures',
  );

  const arch = process.arch;
  const asset = manifest.assets[arch];
  const platform = arch === 'arm64' ? 'linux/arm64' : 'linux/amd64';
  const expectedTarget = arch === 'arm64' ? 'aarch64-linux-gnu' : 'x86_64-linux-gnu';
  const expectedElfMachine = arch === 'arm64' ? 'AArch64' : 'Advanced Micro Devices X86-64';
  assert.equal(asset.platform, platform, 'prepared helper platform matches the running proof');
  assert.equal(
    asset.compilerImageIndexId,
    manifest.compilerImageIndexDigest,
    'compiler source records the approved root index ID separately from its platform manifest',
  );
  assert.equal(
    asset.platformManifestDigest,
    LINUX_COMPILER_PLATFORM_DIGESTS[arch],
    'prepared helper uses the approved platform manifest from the pinned index',
  );
  assert.equal(
    asset.containerImageDotImageId,
    manifest.compilerImageIndexDigest,
    'observed Docker container .Image matches the root index; platform selection is proven separately',
  );
  assert(
    asset.osRelease.includes('VERSION_CODENAME=trixie') &&
      asset.osRelease.includes('VERSION_ID="13"'),
    'compiler preparation image is Debian 13 Trixie',
  );
  assert(
    asset.libcVersion.includes('GLIBC 2.41'),
    'compiler preparation image records the pinned GLIBC 2.41 ABI family',
  );
  assert(
    path.isAbsolute(asset.compilerPath) &&
      asset.compilerPath.startsWith('/usr/bin/') &&
      asset.compilerPath.endsWith('gcc-14'),
    'compiler provenance records the resolved GCC 14 executable path',
  );
  assert(asset.compilerVersion.includes('(Debian 14.2.0-'), 'GCC 14.2 version is recorded');
  assert(/^[a-f0-9]{64}$/.test(asset.compilerSha256), 'compiler binary hash is canonical');
  assert.equal(
    asset.compilerTargetTriple,
    expectedTarget,
    'compiler target triple matches platform',
  );
  assert(
    Number.isFinite(asset.compilerPreparationDurationMs) &&
      asset.compilerPreparationDurationMs >= 0,
    'compiler container setup duration is recorded',
  );
  assert.equal(
    sourceSha256,
    asset.sourceSha256,
    'prepared helper embeds the exact openat.c source',
  );
  assert.equal(
    opsSourceSha256,
    asset.opsSourceSha256,
    'prepared helper embeds the exact syscall wrapper source',
  );
  assert.deepEqual(
    asset.compileCommand,
    [
      asset.compilerPath,
      '-shared',
      '-fPIC',
      '-nostdlib',
      '-o',
      '/out/libremi-openat.so',
      '/src/openat.c',
      '/src/storage-approval-native.c',
      '-lc',
    ],
    'prepared helper records the exact fixed compiler command',
  );
  assert.equal(asset.library.name, 'libremi-openat.so', 'prepared helper library name is fixed');
  assert(/^[a-f0-9]{64}$/.test(asset.library.sha256), 'prepared helper library hash is canonical');
  assert.equal(
    asset.library.elfMachine,
    expectedElfMachine,
    'prepared ELF machine matches platform',
  );
  assert.deepEqual(
    asset.library.needed,
    ['libc.so.6'],
    'prepared helper depends only on the target C library',
  );
  assert(
    asset.library.requiredGlibcVersions.length > 0 &&
      asset.library.requiredGlibcVersions.every((version) => {
        const match = /^GLIBC_(\d+)\.(\d+)(?:\.\d+)?$/.exec(version);
        return match !== null && Number(match[1]) === 2 && Number(match[2]) <= 41;
      }),
    'prepared helper GLIBC symbol requirements stay within the Bun runtime ABI family',
  );
  assert(
    asset.library.base64.length > 0 &&
      asset.library.base64.length <= Math.ceil((MAX_PREPARED_LIBRARY_BYTES * 4) / 3) + 4,
    'prepared helper library payload stays within its 4 MiB bound',
  );
  const libraryBytes = Buffer.from(asset.library.base64, 'base64');
  assert.equal(
    libraryBytes.toString('base64'),
    asset.library.base64,
    'prepared helper library uses canonical base64 encoding',
  );
  assert(libraryBytes.byteLength > 0, 'prepared helper library bytes are nonempty');
  assert.equal(
    sha256(libraryBytes),
    asset.library.sha256,
    'prepared helper library bytes match their immutable hash',
  );
  assert.equal(
    libraryBytes.byteLength,
    asset.library.size,
    'prepared helper library bytes match their recorded size',
  );
  return { arch, asset, libraryBytes, supportManifestSha256 };
}

function helperSymbols() {
  return {
    remi_approval_openat: {
      args: [FFIType.i32, FFIType.ptr, FFIType.i32],
      returns: FFIType.i32,
    },
    remi_approval_create: {
      args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32],
      returns: FFIType.i32,
    },
    remi_approval_linkat: {
      args: [FFIType.i32, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
    remi_approval_unlinkat: {
      args: [FFIType.i32, FFIType.ptr],
      returns: FFIType.i32,
    },
  } as const;
}

function cString(value: string): Buffer {
  return Buffer.from(`${value}\0`);
}

function writeOwnedBytes(filename: string, bytes: Buffer, witness: string): void {
  const fd = fs.openSync(filename, 'wx', OWNER_SOURCE_MODE);
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = fs.writeSync(fd, bytes, offset, bytes.byteLength - offset, offset);
      assert(count > 0, `${witness}: owned source write made progress`);
      offset += count;
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writeOwnedSource(
  filename: string,
  bytes: Buffer,
  witness: string,
): { sha256: string; identity: OwnedFileIdentity } {
  writeOwnedBytes(filename, bytes, witness);
  const evidence = hashOwnedFile(filename, OWNER_SOURCE_MODE, witness);
  assert.equal(evidence.sha256, sha256(bytes), `${witness}: source matches embedded snapshot`);
  return evidence;
}

export async function prepareNativeHelper(fixtureRoot: string): Promise<PreparedNativeHelper> {
  const setupStarted = performance.now();
  const canonicalRoot = fs.realpathSync(fixtureRoot);
  assert.equal(canonicalRoot, fixtureRoot, 'native helper fixture root is canonical');
  assertOwnedDirectory(canonicalRoot, OWNER_DIRECTORY_MODE, 'native helper fixture root');
  const directory = path.join(canonicalRoot, 'native-helper');
  fs.mkdirSync(directory, { mode: OWNER_DIRECTORY_MODE });
  assertOwnedDirectory(directory, OWNER_DIRECTORY_MODE, 'native helper private directory');

  const sourcePath = path.join(directory, 'openat.c');
  const opsSourcePath = path.join(directory, 'storage-approval-native.c');
  const libraryName = expectedLibraryName();
  const libraryPath = path.join(directory, libraryName);
  const sourceBytes = Buffer.from(await Bun.file(nativeSource).arrayBuffer());
  const opsSourceBytes = Buffer.from(await Bun.file(nativeOpsSource).arrayBuffer());
  const sourceEvidence = writeOwnedSource(sourcePath, sourceBytes, 'prepared helper source');
  const opsSourceEvidence = writeOwnedSource(
    opsSourcePath,
    opsSourceBytes,
    'prepared syscall wrapper source',
  );

  let compiler: CompilerBinding;
  let compileCommand: string[];
  let libraryEvidence: { sha256: string; identity: OwnedFileIdentity };
  if (process.platform === 'darwin') {
    compiler = resolveMacCompiler(directory);
    const sdkPath = compiler.compilerSdkPath;
    assert(sdkPath, 'resolved macOS compiler binding has an SDK path');
    compileCommand = [
      compiler.compilerPath,
      '-isysroot',
      sdkPath,
      '-dynamiclib',
      '-fPIC',
      '-nostdlib',
      '-lSystem',
      '-o',
      libraryPath,
      sourcePath,
      opsSourcePath,
    ];
    const compileResult = spawnSync(compiler.compilerPath, compileCommand.slice(1), {
      cwd: directory,
      env: compilerEnvironment(directory),
      encoding: 'buffer',
      timeout: COMPILER_TIMEOUT_MS,
      maxBuffer: MAX_COMPILER_OUTPUT_BYTES,
    });
    compilerOutput(compileResult, 'native helper compile');
    fs.chmodSync(libraryPath, OWNER_LIBRARY_MODE);
    libraryEvidence = hashOwnedFile(libraryPath, OWNER_LIBRARY_MODE, 'compiled helper library');
  } else if (process.platform === 'linux') {
    const embedded = embeddedLinuxHelper(sourceEvidence.sha256, opsSourceEvidence.sha256);
    const { asset } = embedded;
    compiler = {
      compilerPath: asset.compilerPath,
      compilerVersion: asset.compilerVersion,
      compilerSha256: asset.compilerSha256,
      compilerTargetTriple: asset.compilerTargetTriple,
      compilerResolutionMethod: 'embedded-prepared',
      compilerLauncherPath: null,
      compilerLauncherVersion: null,
      compilerLauncherSha256: null,
      compilerSdkPath: null,
      compilerSdkVersion: null,
      compilerImageIndexReference: LINUX_COMPILER_IMAGE_INDEX_REFERENCE,
      compilerImageIndexDigest: LINUX_COMPILER_IMAGE_INDEX_DIGEST,
      compilerContainerImageDotImageId: asset.containerImageDotImageId,
      compilerImagePlatformDigest: asset.platformManifestDigest,
      compilerImagePlatform: asset.platform,
      compilerOsRelease: asset.osRelease,
      compilerLibcVersion: asset.libcVersion,
      compilerPreparationDurationMs: asset.compilerPreparationDurationMs,
      compilerPreparationContainerDurationMs: asset.compilerPreparationContainerDurationMs,
      supportManifestSha256: embedded.supportManifestSha256,
      libraryElfMachine: asset.library.elfMachine,
      libraryNeeded: asset.library.needed,
      libraryRequiredGlibcVersions: asset.library.requiredGlibcVersions,
    };
    compileCommand = asset.compileCommand;
    writeOwnedBytes(libraryPath, embedded.libraryBytes, 'embedded prepared helper library');
    fs.chmodSync(libraryPath, OWNER_LIBRARY_MODE);
    libraryEvidence = hashOwnedFile(
      libraryPath,
      OWNER_LIBRARY_MODE,
      'materialized prepared helper library',
    );
    assert.equal(
      libraryEvidence.sha256,
      asset.library.sha256,
      'materialized prepared helper bytes match embedded library hash',
    );
  } else {
    throw new Error(`unsupported storage approval proof platform: ${process.platform}`);
  }
  assert(libraryEvidence.identity.size > 0, 'compiled native helper library is nonempty');
  const prepared: PreparedNativeHelper = {
    fixtureRoot: canonicalRoot,
    directory,
    sourcePath,
    sourceSha256: sourceEvidence.sha256,
    sourceIdentity: sourceEvidence.identity,
    opsSourcePath,
    opsSourceSha256: opsSourceEvidence.sha256,
    opsSourceIdentity: opsSourceEvidence.identity,
    libraryName,
    libraryPath,
    librarySha256: libraryEvidence.sha256,
    libraryIdentity: libraryEvidence.identity,
    ...compiler,
    compileCommand,
    setupDurationMs: performance.now() - setupStarted,
    platform: process.platform,
    arch: process.arch,
  };
  return prepared;
}

export async function loadPreparedNativeHelper(
  fixtureRoot: string,
  prepared: PreparedNativeHelper,
): Promise<{ ops: PrivateOps; evidence: LoadedNativeHelperEvidence; close(): void }> {
  const canonicalRoot = fs.realpathSync(fixtureRoot);
  assert.equal(canonicalRoot, fixtureRoot, 'worker native helper fixture root is canonical');
  assertOwnedDirectory(canonicalRoot, OWNER_DIRECTORY_MODE, 'worker native helper fixture root');
  const directory = path.join(canonicalRoot, 'native-helper');
  assert.equal(prepared.fixtureRoot, canonicalRoot, 'prepared helper names the owned fixture root');
  assert.equal(
    prepared.directory,
    directory,
    'prepared helper uses the fixed owned helper directory',
  );
  assert.equal(
    prepared.sourcePath,
    path.join(directory, 'openat.c'),
    'prepared source path is fixed inside proof root',
  );
  assert.equal(
    prepared.opsSourcePath,
    path.join(directory, 'storage-approval-native.c'),
    'prepared syscall wrapper source path is fixed inside proof root',
  );
  assert.equal(
    prepared.libraryName,
    expectedLibraryName(),
    'prepared helper library name matches this platform',
  );
  assert.equal(
    prepared.libraryPath,
    path.join(directory, prepared.libraryName),
    'prepared library path is fixed inside proof root',
  );
  assert.equal(prepared.platform, process.platform, 'prepared helper platform matches worker');
  assert.equal(prepared.arch, process.arch, 'prepared helper architecture matches worker');
  assert(
    /^[a-f0-9]{64}$/.test(prepared.sourceSha256),
    'prepared helper source digest is canonical',
  );
  assert(
    /^[a-f0-9]{64}$/.test(prepared.opsSourceSha256),
    'prepared syscall wrapper source digest is canonical',
  );
  assert(
    /^[a-f0-9]{64}$/.test(prepared.librarySha256),
    'prepared helper library digest is canonical',
  );
  assert(
    /^[a-f0-9]{64}$/.test(prepared.compilerSha256),
    'prepared helper compiler digest is canonical',
  );
  assert.equal(
    prepared.compilerResolutionMethod,
    process.platform === 'darwin' ? 'xcrun' : 'embedded-prepared',
    'native compiler resolution method matches this platform',
  );
  assert(path.isAbsolute(prepared.compilerPath), 'resolved native compiler path is absolute');
  assert(prepared.compilerVersion.length > 0, 'resolved native compiler version is recorded');
  assert(
    prepared.compilerTargetTriple.length > 0,
    'resolved native compiler target triple is recorded',
  );
  if (process.platform === 'darwin') {
    assert.equal(
      fs.realpathSync(prepared.compilerPath),
      prepared.compilerPath,
      'native compiler path records the resolved executable rather than a launcher shim',
    );
    assert(prepared.compilerLauncherPath, 'xcrun launcher path is recorded');
    assert.equal(
      fs.realpathSync(prepared.compilerLauncherPath),
      prepared.compilerLauncherPath,
      'xcrun launcher path is canonical',
    );
    assert(prepared.compilerLauncherVersion, 'xcrun launcher version is recorded');
    assert(
      prepared.compilerLauncherSha256 && /^[a-f0-9]{64}$/.test(prepared.compilerLauncherSha256),
      'xcrun launcher hash is recorded',
    );
    assert(prepared.compilerSdkPath, 'selected macOS SDK path is recorded');
    assert.equal(
      fs.realpathSync(prepared.compilerSdkPath),
      prepared.compilerSdkPath,
      'selected macOS SDK path is canonical',
    );
    assert(prepared.compilerSdkVersion, 'selected macOS SDK version is recorded');
    const sdkArgument = prepared.compileCommand.indexOf('-isysroot');
    assert(sdkArgument >= 0, 'compile command binds the selected SDK');
    assert.equal(
      prepared.compileCommand[sdkArgument + 1],
      prepared.compilerSdkPath,
      'compile command names the recorded SDK',
    );
    assert.equal(prepared.compilerImageIndexReference, null, 'macOS helper has no compiler image');
    assert.equal(prepared.compilerImageIndexDigest, null, 'macOS helper has no image index digest');
    assert.equal(
      prepared.compilerContainerImageDotImageId,
      null,
      'macOS helper has no compiler-container .Image identity',
    );
    assert.equal(prepared.compilerImagePlatformDigest, null, 'macOS helper has no platform digest');
    assert.equal(prepared.compilerImagePlatform, null, 'macOS helper has no compiler platform');
    assert.equal(prepared.compilerOsRelease, null, 'macOS helper has no Linux OS release');
    assert.equal(prepared.compilerLibcVersion, null, 'macOS helper has no Linux libc version');
    assert.equal(
      prepared.compilerPreparationDurationMs,
      null,
      'macOS helper has no separate compiler container duration',
    );
    assert.equal(
      prepared.compilerPreparationContainerDurationMs,
      null,
      'macOS helper has no compiler container startup duration',
    );
    assert.equal(
      prepared.supportManifestSha256,
      null,
      'macOS helper has no Linux support manifest',
    );
    assert.equal(prepared.libraryElfMachine, null, 'macOS helper has no ELF machine');
    assert.deepEqual(prepared.libraryNeeded, [], 'macOS helper has no ELF DT_NEEDED list');
    assert.deepEqual(
      prepared.libraryRequiredGlibcVersions,
      [],
      'macOS helper has no GLIBC symbol requirements',
    );
  } else {
    assert(
      process.arch === 'arm64' || process.arch === 'x64',
      `unsupported Linux helper architecture: ${process.arch}`,
    );
    assert(
      prepared.compilerPath.startsWith('/usr/bin/') && prepared.compilerPath.endsWith('gcc-14'),
      'Linux compiler path records the resolved GCC 14 executable from the preparation image',
    );
    assert.equal(prepared.compilerLauncherPath, null, 'Linux compiler has no launcher');
    assert.equal(prepared.compilerLauncherVersion, null, 'Linux compiler has no launcher version');
    assert.equal(prepared.compilerLauncherSha256, null, 'Linux compiler has no launcher hash');
    assert.equal(prepared.compilerSdkPath, null, 'Linux compiler has no macOS SDK path');
    assert.equal(prepared.compilerSdkVersion, null, 'Linux compiler has no macOS SDK version');
    assert.equal(
      prepared.compilerImageIndexReference,
      LINUX_COMPILER_IMAGE_INDEX_REFERENCE,
      'Linux helper names the approved immutable compiler image index',
    );
    assert.equal(
      prepared.compilerImageIndexDigest,
      LINUX_COMPILER_IMAGE_INDEX_DIGEST,
      'Linux helper compiler index digest matches the approved pin',
    );
    assert.equal(
      prepared.compilerContainerImageDotImageId,
      LINUX_COMPILER_IMAGE_INDEX_DIGEST,
      'observed compiler-container .Image matches the root index, not the architecture child',
    );
    assert.equal(
      prepared.compilerImagePlatform,
      process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64',
      'Linux compiler image platform matches the worker',
    );
    assert.equal(
      prepared.compilerImagePlatformDigest,
      LINUX_COMPILER_PLATFORM_DIGESTS[process.arch as 'arm64' | 'x64'],
      'Linux compiler platform manifest matches the approved pin',
    );
    assert(
      prepared.compilerOsRelease?.includes('VERSION_CODENAME=trixie') &&
        prepared.compilerOsRelease.includes('VERSION_ID="13"'),
      'Linux compiler image Debian release is recorded',
    );
    assert(
      prepared.compilerLibcVersion?.includes('GLIBC 2.41'),
      'Linux compiler container libc version is recorded',
    );
    assert(
      prepared.compilerPreparationDurationMs !== null &&
        Number.isFinite(prepared.compilerPreparationDurationMs) &&
        prepared.compilerPreparationDurationMs >= 0,
      'Linux compiler container preparation duration is recorded',
    );
    assert(
      prepared.compilerPreparationContainerDurationMs !== null &&
        Number.isFinite(prepared.compilerPreparationContainerDurationMs) &&
        prepared.compilerPreparationContainerDurationMs >= 0,
      'Linux compiler container wall duration is recorded',
    );
    assert(
      prepared.supportManifestSha256 && /^[a-f0-9]{64}$/.test(prepared.supportManifestSha256),
      'Linux helper records its embedded support manifest hash',
    );
    assert(prepared.libraryElfMachine, 'Linux helper records its ELF machine');
    assert.deepEqual(prepared.libraryNeeded, ['libc.so.6'], 'Linux ELF needs only libc');
    assert(
      prepared.libraryRequiredGlibcVersions.length > 0,
      'Linux helper records its required GLIBC symbol versions',
    );
  }
  assert(
    Number.isFinite(prepared.setupDurationMs) && prepared.setupDurationMs >= 0,
    'parent setup duration is recorded',
  );
  assertOwnedDirectory(directory, OWNER_DIRECTORY_MODE, 'worker native helper private directory');

  const localSourceSha256 = sha256(Buffer.from(await Bun.file(nativeSource).arrayBuffer()));
  const localOpsSourceSha256 = sha256(Buffer.from(await Bun.file(nativeOpsSource).arrayBuffer()));
  let embedded: ReturnType<typeof embeddedLinuxHelper> | null = null;
  if (process.platform === 'linux') {
    embedded = embeddedLinuxHelper(localSourceSha256, localOpsSourceSha256);
    const asset = embedded.asset;
    assert.equal(
      prepared.supportManifestSha256,
      embedded.supportManifestSha256,
      'worker independently validates the embedded helper support manifest',
    );
    assert.equal(
      prepared.compilerPath,
      asset.compilerPath,
      'worker compiler path matches the manifest',
    );
    assert.equal(
      prepared.compilerVersion,
      asset.compilerVersion,
      'worker compiler version matches the manifest',
    );
    assert.equal(
      prepared.compilerSha256,
      asset.compilerSha256,
      'worker compiler binary hash matches the manifest',
    );
    assert.equal(
      prepared.compilerTargetTriple,
      asset.compilerTargetTriple,
      'worker compiler target matches the manifest',
    );
    assert.equal(
      prepared.compilerImageIndexReference,
      LINUX_COMPILER_IMAGE_INDEX_REFERENCE,
      'worker compiler image index matches the manifest',
    );
    assert.equal(
      prepared.compilerImageIndexDigest,
      LINUX_COMPILER_IMAGE_INDEX_DIGEST,
      'worker compiler image digest matches the manifest',
    );
    assert.equal(
      prepared.compilerContainerImageDotImageId,
      asset.containerImageDotImageId,
      'worker container .Image root index matches the embedded provenance field',
    );
    assert.equal(
      prepared.compilerImagePlatformDigest,
      asset.platformManifestDigest,
      'worker compiler platform digest matches the manifest',
    );
    assert.equal(
      prepared.compilerImagePlatform,
      asset.platform,
      'worker compiler platform matches the manifest',
    );
    assert.equal(
      prepared.compilerLibcVersion,
      asset.libcVersion,
      'worker compiler libc version matches the manifest',
    );
    assert.equal(
      prepared.compilerOsRelease,
      asset.osRelease,
      'worker compiler image OS release matches the manifest',
    );
    assert.equal(
      prepared.compilerPreparationDurationMs,
      asset.compilerPreparationDurationMs,
      'worker compiler preparation duration matches the manifest',
    );
    assert.equal(
      prepared.compilerPreparationContainerDurationMs,
      asset.compilerPreparationContainerDurationMs,
      'worker compiler container wall duration matches the manifest',
    );
    assert.equal(
      prepared.libraryElfMachine,
      asset.library.elfMachine,
      'worker library ELF machine matches the manifest',
    );
    assert.deepEqual(
      prepared.libraryNeeded,
      asset.library.needed,
      'worker library DT_NEEDED entries match the manifest',
    );
    assert.deepEqual(
      prepared.libraryRequiredGlibcVersions,
      asset.library.requiredGlibcVersions,
      'worker library GLIBC requirements match the manifest',
    );
    assert.deepEqual(
      prepared.compileCommand,
      asset.compileCommand,
      'worker compile command matches the manifest',
    );
    assert.equal(
      prepared.librarySha256,
      asset.library.sha256,
      'worker library digest matches the manifest',
    );
  }
  assert.equal(
    prepared.sourceSha256,
    localSourceSha256,
    'prepared helper is the exact compiled source snapshot',
  );
  assert.equal(
    prepared.opsSourceSha256,
    localOpsSourceSha256,
    'prepared syscall wrappers are the exact compiled source snapshot',
  );
  const sourceEvidence = hashOwnedFile(
    prepared.sourcePath,
    OWNER_SOURCE_MODE,
    'worker prepared helper source',
  );
  assert(
    sameIdentity(prepared.sourceIdentity, sourceEvidence.identity),
    'worker source inode and mode match parent preparation receipt',
  );
  assert.equal(
    sourceEvidence.sha256,
    prepared.sourceSha256,
    'worker source bytes match compiled source hash',
  );
  const opsSourceEvidence = hashOwnedFile(
    prepared.opsSourcePath,
    OWNER_SOURCE_MODE,
    'worker prepared syscall wrapper source',
  );
  assert(
    sameIdentity(prepared.opsSourceIdentity, opsSourceEvidence.identity),
    'worker syscall wrapper source inode and mode match parent preparation receipt',
  );
  assert.equal(
    opsSourceEvidence.sha256,
    prepared.opsSourceSha256,
    'worker syscall wrapper source bytes match compiled source hash',
  );
  const libraryEvidence = hashOwnedFile(
    prepared.libraryPath,
    OWNER_LIBRARY_MODE,
    'worker prepared helper library',
  );
  assert(
    sameIdentity(prepared.libraryIdentity, libraryEvidence.identity),
    'worker library inode and mode match parent preparation receipt',
  );
  assert.equal(
    libraryEvidence.sha256,
    prepared.librarySha256,
    'worker library bytes match parent preparation hash',
  );

  const helper = dlopen(prepared.libraryPath, helperSymbols());
  try {
    const libraryAfterLoad = hashOwnedFile(
      prepared.libraryPath,
      OWNER_LIBRARY_MODE,
      'loaded helper library',
    );
    assert(
      sameIdentity(prepared.libraryIdentity, libraryAfterLoad.identity),
      'loaded helper path retained the prepared inode',
    );
    assert.equal(
      libraryAfterLoad.sha256,
      prepared.librarySha256,
      'loaded helper bytes retained the prepared hash',
    );

    const ops: PrivateOps = {
      openAt: (directoryFD, name, flags) =>
        helper.symbols.remi_approval_openat(directoryFD, ptr(cString(name)), flags),
      create: (directoryFD, name, flags, mode) =>
        helper.symbols.remi_approval_create(directoryFD, ptr(cString(name)), flags, mode),
      link: (directoryFD, from, to) =>
        helper.symbols.remi_approval_linkat(directoryFD, ptr(cString(from)), ptr(cString(to))),
      unlink: (directoryFD, name) =>
        helper.symbols.remi_approval_unlinkat(directoryFD, ptr(cString(name))),
    };
    return {
      ops,
      evidence: {
        sourceSha256: prepared.sourceSha256,
        opsSourceSha256: prepared.opsSourceSha256,
        librarySha256: prepared.librarySha256,
        sourceIdentity: sourceEvidence.identity,
        opsSourceIdentity: opsSourceEvidence.identity,
        libraryIdentity: libraryAfterLoad.identity,
        compilerPath: prepared.compilerPath,
        compilerVersion: prepared.compilerVersion,
        compilerSha256: prepared.compilerSha256,
        compilerTargetTriple: prepared.compilerTargetTriple,
        compilerResolutionMethod: prepared.compilerResolutionMethod,
        compilerLauncherPath: prepared.compilerLauncherPath,
        compilerLauncherVersion: prepared.compilerLauncherVersion,
        compilerLauncherSha256: prepared.compilerLauncherSha256,
        compilerSdkPath: prepared.compilerSdkPath,
        compilerSdkVersion: prepared.compilerSdkVersion,
        compilerImageIndexReference: prepared.compilerImageIndexReference,
        compilerImageIndexDigest: prepared.compilerImageIndexDigest,
        compilerContainerImageDotImageId: prepared.compilerContainerImageDotImageId,
        compilerImagePlatformDigest: prepared.compilerImagePlatformDigest,
        compilerImagePlatform: prepared.compilerImagePlatform,
        compilerOsRelease: prepared.compilerOsRelease,
        compilerLibcVersion: prepared.compilerLibcVersion,
        compilerPreparationDurationMs: prepared.compilerPreparationDurationMs,
        compilerPreparationContainerDurationMs: prepared.compilerPreparationContainerDurationMs,
        supportManifestSha256: prepared.supportManifestSha256,
        libraryElfMachine: prepared.libraryElfMachine,
        libraryNeeded: prepared.libraryNeeded,
        libraryRequiredGlibcVersions: prepared.libraryRequiredGlibcVersions,
        compileCommand: prepared.compileCommand,
        setupDurationMs: prepared.setupDurationMs,
        platform: prepared.platform,
        arch: prepared.arch,
      },
      close() {
        helper.close();
      },
    };
  } catch (error) {
    helper.close();
    throw error;
  }
}
