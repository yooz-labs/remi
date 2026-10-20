/**
 * Restricted local routing hints (#1170), separate from broadcast status.
 * PID checks establish liveness only. The complete tuple supplies ownership
 * for retirement; neither it nor instanceId grants access or proves PID age.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { remiHome } from '../config/remi-home.ts';
import { isProcessAlive } from '../session/process-alive.ts';
import { withInterprocessFileLock } from './interprocess-file-lock.ts';
import { writeRestrictedJson } from './restricted-json.ts';

export interface LocalDaemonEndpoint {
  readonly version: 1;
  readonly publicPort: number;
  readonly pid: number;
  readonly privatePort: number;
  readonly instanceId: string;
}

export type LocalEndpointLookup =
  | { readonly kind: 'absent' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'found'; readonly endpoint: LocalDaemonEndpoint };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RECORD_ERROR = 'Local daemon endpoint record operation failed';

function validPort(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65535;
}

function validEndpoint(value: unknown): value is LocalDaemonEndpoint {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 5 &&
    record['version'] === 1 &&
    validPort(record['publicPort']) &&
    validPort(record['privatePort']) &&
    Number.isSafeInteger(record['pid']) &&
    (record['pid'] as number) > 0 &&
    typeof record['instanceId'] === 'string' &&
    UUID.test(record['instanceId'])
  );
}

function sameOwner(left: LocalDaemonEndpoint, right: LocalDaemonEndpoint): boolean {
  return (
    left.version === right.version &&
    left.publicPort === right.publicPort &&
    left.pid === right.pid &&
    left.privatePort === right.privatePort &&
    left.instanceId === right.instanceId
  );
}

function recordPath(publicPort: number, home: string): string {
  return path.join(home, 'local-endpoints', `${publicPort}.json`);
}

function transactionPath(publicPort: number, home: string): string {
  const file = recordPath(publicPort, home);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(file), 0o700);
  return file;
}

/** Atomic snapshots need no reader lock. Liveness is checked by the public reader. */
function snapshot(publicPort: number, home: string): LocalEndpointLookup {
  const file = recordPath(publicPort, home);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) return { kind: 'invalid' };
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return validEndpoint(value) && value.publicPort === publicPort
      ? { kind: 'found', endpoint: value }
      : { kind: 'invalid' };
  } catch (error) {
    return { kind: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'invalid' };
  }
}

export function readLocalDaemonEndpoint(
  publicPort: number,
  options: { readonly home?: string; readonly expectedPid?: number } = {},
): LocalEndpointLookup {
  if (
    !validPort(publicPort) ||
    (options.expectedPid !== undefined &&
      (!Number.isSafeInteger(options.expectedPid) || options.expectedPid <= 0))
  )
    return { kind: 'invalid' };
  const result = snapshot(publicPort, options.home ?? remiHome());
  if (
    result.kind === 'found' &&
    (!isProcessAlive(result.endpoint.pid) ||
      (options.expectedPid !== undefined && result.endpoint.pid !== options.expectedPid))
  )
    return { kind: 'invalid' };
  return result;
}

export function publishLocalDaemonEndpoint(
  endpoint: LocalDaemonEndpoint,
  home: string = remiHome(),
): void {
  if (!validEndpoint(endpoint)) throw new Error(RECORD_ERROR);
  try {
    const file = transactionPath(endpoint.publicPort, home);
    withInterprocessFileLock(file, () => {
      const current = snapshot(endpoint.publicPort, home);
      if (current.kind === 'invalid') throw new Error(RECORD_ERROR);
      if (current.kind === 'found') {
        if (sameOwner(current.endpoint, endpoint)) return;
        if (isProcessAlive(current.endpoint.pid)) throw new Error(RECORD_ERROR);
      }
      writeRestrictedJson(file, endpoint);
    });
  } catch {
    // Parser bodies and filesystem errors may hold private data; keep one fixed diagnostic.
    throw new Error(RECORD_ERROR);
  }
}

export function releaseLocalDaemonEndpoint(
  endpoint: LocalDaemonEndpoint,
  home: string = remiHome(),
): void {
  if (!validEndpoint(endpoint)) throw new Error(RECORD_ERROR);
  try {
    const file = transactionPath(endpoint.publicPort, home);
    withInterprocessFileLock(file, () => {
      const current = snapshot(endpoint.publicPort, home);
      if (current.kind === 'invalid') throw new Error(RECORD_ERROR);
      if (current.kind === 'found' && sameOwner(current.endpoint, endpoint)) fs.unlinkSync(file);
    });
  } catch {
    throw new Error(RECORD_ERROR);
  }
}
