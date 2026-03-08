import * as os from 'node:os';
import type { Bonjour, Service } from 'bonjour-service';
import { MDNS_SERVICE_TYPE } from './constants.ts';

export interface MdnsPublisherConfig {
  readonly port: number;
  readonly version: string;
  readonly authEnabled: boolean;
  readonly fingerprint?: string | undefined;
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
      const txt: Record<string, string> = {
        version: this.config.version,
        auth: this.config.authEnabled ? 'true' : 'false',
        hostname,
      };
      if (this.config.fingerprint) {
        txt['fingerprint'] = this.config.fingerprint;
      }

      this.service = this.instance.publish({
        name: this.config.name ?? `remi-${hostname}`,
        type: MDNS_SERVICE_TYPE,
        port: this.config.port,
        txt,
        probe: this.config.probe ?? true,
      });

      this.running = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
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
        const msg = err instanceof Error ? err.message : String(err);
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
