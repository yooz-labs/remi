/**
 * Handler for `remi ls` — list live sessions with four branches:
 *
 *   1. `--network` → scan the LAN via mDNS for remi daemons
 *   2. Explicit port (or REMI_PORT) → query a single daemon (optionally on --host)
 *   3. `--host` without port → probe the standard port range on that host
 *   4. Default → discover all local sessions via the live registry
 *
 * The four `ls-client` helpers stay in their current module; this handler
 * decides which to call based on the CLI flag combination and uniformly maps
 * thrown errors to `console.error` + exit code 1.
 */

import { errorToString } from '@remi/shared';
import { DEFAULT_BASE_PORT, type SessionRegistryFile } from '../session/session-registry-file.ts';

export interface LsCommandIO {
  readonly err: (msg: string) => void;
}

const defaultIO: LsCommandIO = { err: (msg) => console.error(msg) };

export interface LsCommandOptions {
  readonly port?: number;
  readonly host?: string;
  readonly network?: boolean;
  /** This binary's remi version, for the stale-daemon warning (#539). */
  readonly remiVersion?: string;
}

/** Injectable ls-client helpers; the default loader lazy-imports the real ones. */
export interface LsClientHelpers {
  runNetworkLs: (args: { localPort: number; localPorts: number[] }) => Promise<void>;
  runLsClient: (args: { host: string; port: number }) => Promise<void>;
  runHostLs: (args: { host: string; ports: number[] }) => Promise<void>;
  getDefaultPortRange: () => number[];
  runMultiPortLs: (args: {
    registry: SessionRegistryFile;
    installedVersion?: string;
  }) => Promise<void>;
}

const defaultLoader = async (): Promise<LsClientHelpers> => import('./ls-client.ts');

export async function runLsCommand(
  opts: LsCommandOptions,
  registry: SessionRegistryFile,
  io: LsCommandIO = defaultIO,
  loadHelpers: () => Promise<LsClientHelpers> = defaultLoader,
): Promise<number> {
  const envPort = process.env['REMI_PORT'] ? Number.parseInt(process.env['REMI_PORT']) : undefined;
  const explicitPort = opts.port ?? envPort;
  const helpers = await loadHelpers();

  try {
    if (opts.network) {
      await helpers.runNetworkLs({
        localPort: explicitPort ?? DEFAULT_BASE_PORT,
        localPorts: registry.getLivePorts(),
      });
      return 0;
    }
    if (explicitPort) {
      // Explicit port: query single daemon on given (or default) host
      await helpers.runLsClient({ host: opts.host ?? 'localhost', port: explicitPort });
      return 0;
    }
    if (opts.host) {
      // Host without port: probe the standard port range on that host
      await helpers.runHostLs({ host: opts.host, ports: helpers.getDefaultPortRange() });
      return 0;
    }
    // No explicit port: discover all local remi sessions via live registry
    await helpers.runMultiPortLs({
      registry,
      ...(opts.remiVersion !== undefined && { installedVersion: opts.remiVersion }),
    });
    return 0;
  } catch (err) {
    io.err(errorToString(err));
    return 1;
  }
}
