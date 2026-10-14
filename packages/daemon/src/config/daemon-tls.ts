/** Read operator TLS files once at daemon startup; never expose loader bodies. */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { ServerConfig } from '../server/websocket-server.ts';
import { type DaemonTlsConfig, assertDaemonTlsConfig } from './config.ts';

export function loadDaemonTls(
  config: DaemonTlsConfig | null,
  configPath: string,
): NonNullable<ServerConfig['tls']> | undefined {
  assertDaemonTlsConfig(config);
  if (config === null) return undefined;
  try {
    return {
      cert: readFileSync(resolve(dirname(configPath), config.certificate_file), 'utf8'),
      key: readFileSync(resolve(dirname(configPath), config.private_key_file), 'utf8'),
    };
  } catch {
    throw new Error('TLS_FILES_UNAVAILABLE: cannot read configured TLS files');
  }
}
