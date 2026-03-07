import * as os from 'node:os';
import type { Bonjour, Service } from 'bonjour-service';

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
      type: 'remi',
      port: this.config.port,
      txt,
      probe: this.config.probe ?? true,
    });

    this.running = true;
  }

  async stop(): Promise<void> {
    if (!this.running || !this.instance) return;

    return new Promise<void>((resolve) => {
      try {
        this.instance?.unpublishAll(() => {
          this.instance?.destroy();
          this.instance = null;
          this.service = null;
          this.running = false;
          resolve();
        });
      } catch {
        this.instance = null;
        this.service = null;
        this.running = false;
        resolve();
      }
    });
  }
}
