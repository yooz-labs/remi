/** Select a local routing hint and its fresh capability together; never downgrade a remote URL. */
import { isIP } from 'node:net';
import { join } from 'node:path';
import { remiHome } from '../config/remi-home.ts';
import { readLocalDaemonEndpoint } from '../storage/local-daemon-endpoints.ts';
import { capabilityWsOptions } from './capability-client.ts';

export interface DaemonWsTarget {
  readonly url: string;
  readonly options: ReturnType<typeof capabilityWsOptions>;
}

export function resolveDaemonWsTarget(
  host: string,
  publicPort: number,
  options: {
    readonly path?: '/ws' | '/relay-control';
    readonly home?: string;
    readonly expectedPid?: number;
  } = {},
): DaemonWsTarget {
  const path = options.path ?? '/ws';
  if (
    !Number.isInteger(publicPort) ||
    publicPort < 1 ||
    publicPort > 65535 ||
    !host ||
    /[\s/@?#\\]/.test(host) ||
    host.includes('://') ||
    (path !== '/ws' && path !== '/relay-control')
  )
    throw new Error('Invalid daemon target');
  const url = `ws://${host === '::1' ? '[::1]' : host}:${publicPort}${path}`;
  try {
    new URL(url);
  } catch {
    throw new Error('Invalid daemon target');
  }
  const local =
    host === 'localhost' ||
    host === '::1' ||
    host === '[::1]' ||
    (isIP(host) === 4 && host.startsWith('127.'));
  // Return before any endpoint or capability read, even when DNS would resolve to loopback.
  if (!local) return { url, options: undefined };
  const home = options.home ?? remiHome();
  const record = readLocalDaemonEndpoint(publicPort, {
    home,
    ...(options.expectedPid !== undefined && { expectedPid: options.expectedPid }),
  });
  if (record.kind === 'invalid') throw new Error('Local daemon endpoint unavailable');
  const capability = capabilityWsOptions(join(home, 'capability.key'));
  if (record.kind === 'absent') return { url, options: capability };
  if (!capability) throw new Error('Local daemon capability unavailable');
  return { url: `ws://127.0.0.1:${record.endpoint.privatePort}${path}`, options: capability };
}
