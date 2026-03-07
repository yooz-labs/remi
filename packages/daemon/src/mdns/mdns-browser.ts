import type { Service } from 'bonjour-service';

export interface DiscoveredDaemon {
  name: string;
  host: string;
  port: number;
  version: string;
  authEnabled: boolean;
  fingerprint?: string | undefined;
  hostname: string;
}

export interface BrowseOptions {
  timeout?: number;
}

export async function discoverDaemons(opts?: BrowseOptions): Promise<DiscoveredDaemon[]> {
  const timeout = opts?.timeout ?? 3000;
  const daemons: DiscoveredDaemon[] = [];

  const { Bonjour } = await import('bonjour-service');
  const instance = new Bonjour(undefined, (err: Error) => {
    console.error(`[mDNS] Browse error: ${err.message}`);
  });

  return new Promise<DiscoveredDaemon[]>((resolve) => {
    const browser = instance.find({ type: 'remi' }, (service: Service) => {
      const txt = (service.txt || {}) as Record<string, string>;

      let host = service.host || 'localhost';
      if (service.addresses && service.addresses.length > 0) {
        const ipv4 = service.addresses.find((a: string) => !a.includes(':'));
        host = ipv4 || service.addresses[0] || host;
      }

      daemons.push({
        name: service.name,
        host,
        port: service.port,
        version: txt['version'] || 'unknown',
        authEnabled: txt['auth'] === 'true',
        fingerprint: txt['fingerprint'],
        hostname: txt['hostname'] || service.name,
      });
    });

    setTimeout(() => {
      browser.stop();
      instance.destroy();
      resolve(daemons);
    }, timeout);
  });
}
