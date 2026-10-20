// One owned child repeatedly exercises the actual reserved private-copy composition.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DirectoryRoot, FileAdmission } from './admission';
import type { PrivateOps } from './private-copy';
import { Reservations } from './reservations';
import { type ReservedPrivateCopy, reserveAndCopy } from './reserved-copy';
import { type PreparedNativeHelper, loadPreparedNativeHelper } from './storage-approval-native';

export interface StorageLoadWorkerConfig {
  fixtureRoot: string;
  nativeHelper: PreparedNativeHelper;
  inputPath: string;
  projectPath: string;
  privatePath: string;
  ledgerPath: string;
  progressPath: string;
  stopPath: string;
  expectedBytes: number;
  expectedSha256: string;
}

interface Progress {
  state: 'starting' | 'ready' | 'copying' | 'waiting' | 'stopped';
  completedCopies: number;
  copyStartedAtUnixMs: number | null;
  lastCopyStartedAtUnixMs: number | null;
  lastCopyCompletedAtUnixMs: number | null;
  lastAllocatedBytes: number | null;
  lastSha256: string | null;
  setupMeasurements: WorkerSetupMeasurements;
}

interface WorkerSetupMeasurements {
  initialProgressMs: number | null;
  nativeHelperLoadMs: number | null;
  directoryCaptureMs: number | null;
  sourceAdmissionMs: number | null;
  ledgerInitializationMs: number | null;
  readyAtWorkerMs: number | null;
}

const MAX_WORKER_RUNTIME_MS = 4000;
const MAX_WORKER_LIFETIME_MS = 5000;
const COPY_PAUSE_MS = 30;
const VERIFY_CHUNK_BYTES = 64 * 1024;

function childProgress(config: StorageLoadWorkerConfig, progress: Progress): void {
  const temporary = `${config.progressPath}.next`;
  fs.writeFileSync(temporary, JSON.stringify(progress), { mode: 0o600 });
  fs.renameSync(temporary, config.progressPath);
}

function owner() {
  return {
    device: randomBytes(32).toString('hex'),
    session: randomUUID(),
    hub: randomBytes(16).toString('hex'),
  };
}

function assertPrivateBytes(
  sourceFD: number,
  artifact: ReservedPrivateCopy,
  size: number,
  expectedSha256: string,
): string {
  assert.equal(artifact.size, size, 'actual-copy witness: private copy has exact 10 MiB length');
  assert.equal(
    artifact.sha256,
    expectedSha256,
    'actual-copy witness: private-copy digest matches generated input',
  );
  const source = Buffer.alloc(VERIFY_CHUNK_BYTES);
  const copied = Buffer.alloc(VERIFY_CHUNK_BYTES);
  const digest = createHash('sha256');
  let offset = 0;
  while (offset < size) {
    const wanted = Math.min(source.length, size - offset);
    const sourceBytes = fs.readSync(sourceFD, source, 0, wanted, offset);
    const privateBytes = artifact.read(copied, offset);
    assert.equal(
      sourceBytes,
      wanted,
      'actual-copy witness: admitted source descriptor returned every expected byte',
    );
    assert.equal(
      privateBytes,
      sourceBytes,
      'actual-copy witness: private descriptor returned the same byte count',
    );
    assert.deepEqual(
      copied.subarray(0, privateBytes),
      source.subarray(0, sourceBytes),
      'actual-copy witness: private bytes equal the same admitted source descriptor',
    );
    digest.update(copied.subarray(0, privateBytes));
    offset += privateBytes;
  }
  const observed = digest.digest('hex');
  assert.equal(observed, expectedSha256, 'actual-copy witness: streamed bytes match source digest');
  return observed;
}

function actualPrivateAllocation(
  privateRoot: DirectoryRoot,
  privatePath: string,
  ops: PrivateOps,
  expectedBytes: number,
): number {
  const names = fs.readdirSync(privatePath);
  assert.equal(names.length, 1, 'actual-copy witness: one completed private artifact exists');
  const name = names[0];
  assert(name, 'actual-copy witness: completed private artifact name is present');
  const fd = ops.openAt(
    privateRoot.fd,
    name,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  assert(fd >= 0, 'actual-copy witness: completed private artifact opens by owned directory fd');
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    assert(
      stat.isFile() &&
        stat.nlink === 1n &&
        stat.uid === BigInt(process.getuid?.() ?? -1) &&
        stat.size === BigInt(expectedBytes) &&
        (stat.mode & 0o777n) === 0o600n,
      'actual-copy witness: private descriptor is owned regular 0600 exact-length content',
    );
    const allocatedBytes = Number(stat.blocks * 512n);
    assert(
      Number.isSafeInteger(allocatedBytes) && allocatedBytes > 0,
      'actual-copy witness: private descriptor has positive allocated blocks',
    );
    return allocatedBytes;
  } finally {
    fs.closeSync(fd);
  }
}

export async function runStorageLoadWorker(config: StorageLoadWorkerConfig): Promise<void> {
  const started = performance.now();
  let phase = 'initial-progress';
  const setupMeasurements: WorkerSetupMeasurements = {
    initialProgressMs: null,
    nativeHelperLoadMs: null,
    directoryCaptureMs: null,
    sourceAdmissionMs: null,
    ledgerInitializationMs: null,
    readyAtWorkerMs: null,
  };
  let progress: Progress = {
    state: 'starting',
    completedCopies: 0,
    copyStartedAtUnixMs: null,
    lastCopyStartedAtUnixMs: null,
    lastCopyCompletedAtUnixMs: null,
    lastAllocatedBytes: null,
    lastSha256: null,
    setupMeasurements,
  };
  const initialProgressStarted = performance.now();
  childProgress(config, progress);
  setupMeasurements.initialProgressMs = performance.now() - initialProgressStarted;
  let native: Awaited<ReturnType<typeof loadPreparedNativeHelper>> | undefined;
  let projectRoot: DirectoryRoot | null = null;
  let privateRoot: DirectoryRoot | null = null;
  let source: ReturnType<FileAdmission['open']> = null;
  try {
    phase = 'load-prepared-native-helper';
    const nativeHelperStarted = performance.now();
    native = await loadPreparedNativeHelper(config.fixtureRoot, config.nativeHelper);
    setupMeasurements.nativeHelperLoadMs = performance.now() - nativeHelperStarted;
    phase = 'capture-project-and-private-roots';
    const rootCaptureStarted = performance.now();
    projectRoot = DirectoryRoot.capture(config.projectPath, native.ops.openAt);
    privateRoot = DirectoryRoot.capture(config.privatePath, native.ops.openAt);
    assert(projectRoot && privateRoot, 'load worker captured both owned directories');
    setupMeasurements.directoryCaptureMs = performance.now() - rootCaptureStarted;
    phase = 'admit-generated-input';
    const admissionStarted = performance.now();
    const protectedRoots: DirectoryRoot[] = [];
    source = new FileAdmission(native.ops.openAt, protectedRoots).open(projectRoot, [
      path.basename(config.inputPath),
    ]);
    assert(source, 'load worker admitted the generated regular input');
    assert.equal(Number(source.size), config.expectedBytes, 'load source has exact 10 MiB size');
    const sourceStat = fs.fstatSync(source.fd, { bigint: true });
    assert(
      sourceStat.isFile() &&
        sourceStat.nlink === 1n &&
        sourceStat.uid === BigInt(process.getuid?.() ?? -1) &&
        (sourceStat.mode & 0o777n) === 0o600n,
      'load source is an owned single-link regular input with mode 0600',
    );
    setupMeasurements.sourceAdmissionMs = performance.now() - admissionStarted;
    phase = 'initialize-reservations';
    const reservationsStarted = performance.now();
    const store = Reservations.create(config.ledgerPath);
    const loadOwner = owner();
    setupMeasurements.ledgerInitializationMs = performance.now() - reservationsStarted;
    setupMeasurements.readyAtWorkerMs = performance.now() - started;
    progress = { ...progress, state: 'ready', setupMeasurements };
    childProgress(config, progress);

    while (!fs.existsSync(config.stopPath)) {
      phase = 'copy-loop-lifetime-guard';
      const elapsed = performance.now() - started;
      if (elapsed >= MAX_WORKER_RUNTIME_MS) {
        throw new Error(
          `storage load worker reached its ${MAX_WORKER_RUNTIME_MS} ms internal deadline before the next copy: ${JSON.stringify(
            {
              pid: process.pid,
              elapsedMs: elapsed,
              phase,
              completedCopies: progress.completedCopies,
              state: progress.state,
              setupMeasurements,
            },
          )}`,
        );
      }
      const copyStartedAtUnixMs = Date.now();
      progress = {
        ...progress,
        state: 'copying',
        copyStartedAtUnixMs,
        lastCopyStartedAtUnixMs: copyStartedAtUnixMs,
      };
      childProgress(config, progress);

      phase = 'reserveAndCopy-and-witness';
      const artifact = reserveAndCopy(source, privateRoot, native.ops, store, loadOwner);
      assert(artifact, 'actual-copy witness: real reserved private copy returned an artifact');
      let allocatedBytes = 0;
      let observedSha256 = '';
      try {
        observedSha256 = assertPrivateBytes(
          source.fd,
          artifact,
          config.expectedBytes,
          config.expectedSha256,
        );
        allocatedBytes = actualPrivateAllocation(
          privateRoot,
          config.privatePath,
          native.ops,
          config.expectedBytes,
        );
        const records = store.inspect();
        assert.equal(records.length, 1, 'actual-copy witness: one active reservation is retained');
        const record = records[0];
        assert(
          record && record.state === 'staged',
          'actual-copy witness: completed copy has staged accounting',
        );
        assert.equal(
          record.charge,
          allocatedBytes,
          'actual-copy witness: ledger charge equals actual private descriptor allocation',
        );
      } finally {
        artifact.close();
      }
      assert.deepEqual(
        fs.readdirSync(config.privatePath),
        [],
        'actual-copy witness: confirmed owned deletion leaves no private artifact',
      );
      assert.equal(
        store.inspect().length,
        0,
        'actual-copy witness: confirmed deletion releases the reservation ledger row',
      );
      assert(source.isCurrent(), 'load worker retains the same current admitted input');
      const completedAtUnixMs = Date.now();
      progress = {
        ...progress,
        state: 'waiting',
        completedCopies: progress.completedCopies + 1,
        copyStartedAtUnixMs: null,
        lastCopyCompletedAtUnixMs: completedAtUnixMs,
        lastAllocatedBytes: allocatedBytes,
        lastSha256: observedSha256,
      };
      childProgress(config, progress);
      phase = 'inter-copy-pause';
      await Bun.sleep(COPY_PAUSE_MS);
    }

    progress = { ...progress, state: 'stopped', copyStartedAtUnixMs: null };
    childProgress(config, progress);
    console.log(
      JSON.stringify({
        completedCopies: progress.completedCopies,
        lastCopyStartedAtUnixMs: progress.lastCopyStartedAtUnixMs,
        lastCopyCompletedAtUnixMs: progress.lastCopyCompletedAtUnixMs,
        lastAllocatedBytes: progress.lastAllocatedBytes,
        lastSha256: progress.lastSha256,
        setupMeasurements,
        nativeHelper: native.evidence,
        workerLifetimeMs: performance.now() - started,
        workerDeadlineMs: MAX_WORKER_RUNTIME_MS,
        maxWorkerLifetimeMs: MAX_WORKER_LIFETIME_MS,
        maxWorkers: 1,
        queuedCopies: 0,
      }),
    );
  } finally {
    source?.close();
    privateRoot?.close();
    projectRoot?.close();
    native?.close();
  }
}
