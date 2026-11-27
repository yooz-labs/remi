import { findAvailableTcpPort } from '../session/port-utils.ts';

/** Retry only a public port collision between the probe and the listener bind. */
export async function startSessionPort(
  initialPort: number,
  range: number,
  reservedBase: number,
  host: string,
  usedPorts: () => Set<number>,
  start: (port: number) => Promise<void>,
): Promise<number> {
  const end = initialPort + range;
  let port = initialPort;
  while (true) {
    try {
      await start(port);
      return port;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EADDRINUSE') throw error;
      const used = usedPorts();
      used.add(reservedBase);
      const next = await findAvailableTcpPort(port + 1, end - port - 1, used, host);
      if (next === null) throw error;
      port = next;
    }
  }
}
