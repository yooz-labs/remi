import { lstatSync, readdirSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { DecoderProcess } from './image-process';

/** Fixed local self-exec command; neither the executable nor its entry comes from a client. */
export function imageWorkerCommand(): readonly string[] {
  const command = import.meta.path.startsWith('/$bunfs/')
    ? [process.execPath]
    : [process.execPath, '--no-env-file', resolve(import.meta.dir, '../entry.ts')];
  return [...command, '--internal-image-worker'];
}

/** Single-decode API; repeated decoding remains an explicit proof-controller operation. */
export type ImageDecoder = Pick<DecoderProcess, 'decode' | 'lastChildPID' | 'lastChildExit'>;

/**
 * The local storage service must generate and exclusively retain this private empty directory.
 * Compiled Bun loads cwd configuration before JS; the worker must not run from a repository.
 * This check does not prevent the owning user from changing that directory afterward.
 */
export function createImageDecoder(privateWorkerCwd: string): ImageDecoder {
  if (!isAbsolute(privateWorkerCwd)) throw new Error('IMAGE_WORKER_CWD');
  const directory = lstatSync(privateWorkerCwd);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    (directory.mode & 0o077) !== 0 ||
    directory.uid !== process.getuid?.() ||
    readdirSync(privateWorkerCwd).length !== 0
  )
    throw new Error('IMAGE_WORKER_CWD');
  return new DecoderProcess(imageWorkerCommand(), privateWorkerCwd);
}
