import * as os from 'node:os';
import { errorToString } from '@remi/shared';
import type { Bonjour, Service } from 'bonjour-service';
import { MDNS_SERVICE_TYPE } from './constants.ts';

export interface MdnsPublisherConfig {
  readonly port: number;
  readonly version: string;
  readonly authEnabled: boolean;
  readonly fingerprint?: string | undefined;
  /** Public discovery hint only; the client still authenticates the machine key (#1575). */
  readonly role?: 'hub' | 'session' | undefined;
  readonly name?: string | undefined;
  readonly probe?: boolean | undefined;
}

export class MdnsPublisher {
  private instance: Bonjour | null = null;
  private service: Service | null = null;
  private running = false;
  private readonly config: MdnsPublisherConfig;

  constructor(config: MdnsPublisherConfig) {
    this.config = config;
  }

  get isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) return;

    try {
      const { Bonjour: BonjourClass } = await import('bonjour-service');
      this.instance = new BonjourClass(undefined, (err: Error) => {
        console.error(`[mDNS] Error: ${err.message}`);
      });

      const hostname = os.hostname();
      const normalizedHost = hostname.replace(/\.+$/, '').toLowerCase();
      const serviceHost = normalizedHost.endsWith('.local')
        ? normalizedHost
        : `${normalizedHost}.local`;
      // System Bonjour resolvers need a local-domain SRV target. The library's
      // bare os.hostname() default browses in its own client but times out in
      // NetService; A/AAAA records still come from its real interfaces (#1575).
      if (
        serviceHost.length > 253 ||
        !serviceHost
          .split('.')
          .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
      ) {
        throw new Error('System hostname cannot form a local Bonjour target');
      }
      // A hub and its session daemons share a hostname. bonjour-service stops
      // publication on instance-name conflict instead of renaming it (#1575).
      const instanceHost = hostname.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 40) || 'machine';
      const instanceName = `remi-${instanceHost}-${this.config.role ?? 'daemon'}-${this.config.port}`;
      const txt: Record<string, string> = {
        version: this.config.version,
        auth: this.config.authEnabled ? 'true' : 'false',
        hostname,
      };
      if (this.config.fingerprint) {
        txt['fingerprint'] = this.config.fingerprint;
      }
      if (this.config.role) txt['role'] = this.config.role;

      this.service = this.instance.publish({
        name: this.config.name ?? instanceName,
        host: serviceHost,
        type: MDNS_SERVICE_TYPE,
        port: this.config.port,
        txt,
        probe: this.config.probe ?? true,
      });

      this.running = true;
    } catch (err) {
      const msg = errorToString(err);
      console.error(`[mDNS] Failed to start publisher: ${msg}`);
      this.forceCleanup();
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (!this.running || !this.instance) return;

    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        console.error('[mDNS] Shutdown timed out, forcing cleanup');
        this.forceCleanup();
        resolve();
      }, 2000);

      try {
        this.instance?.unpublishAll(() => {
          clearTimeout(timer);
          this.instance?.destroy();
          this.forceCleanup();
          resolve();
        });
      } catch (err) {
        clearTimeout(timer);
        const msg = errorToString(err);
        console.error(`[mDNS] Error during shutdown: ${msg}`);
        this.forceCleanup();
        resolve();
      }
    });
  }

  private forceCleanup(): void {
    this.instance = null;
    this.service = null;
    this.running = false;
  }
}
