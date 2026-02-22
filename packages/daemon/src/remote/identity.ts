/**
 * DeviceIdentity - Persistent identity store for the daemon.
 *
 * Stores device ID (memorable name), device secret, and paired clients
 * at ~/.remi/identity.json. Created automatically on first load.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateDeviceName } from '@remi/shared';

export interface PairedClient {
  clientId: string;
  clientName: string;
  pairingToken: string;
  pairedAt: string;
  lastSeenAt: string;
}

export interface RemiIdentity {
  version: 1;
  deviceId: string;
  deviceSecret: string;
  pairedClients: PairedClient[];
  createdAt: string;
}

const REMI_DIR = path.join(os.homedir(), '.remi');
const IDENTITY_FILE = path.join(REMI_DIR, 'identity.json');

export class DeviceIdentity {
  private filePath: string;
  private identity: RemiIdentity | null = null;

  constructor(filePath?: string) {
    this.filePath = filePath ?? IDENTITY_FILE;
  }

  private ensureDir(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  private read(): RemiIdentity | null {
    try {
      if (!fs.existsSync(this.filePath)) return null;
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const data = JSON.parse(raw) as RemiIdentity;
      if (data.version !== 1 || !data.deviceId || !data.deviceSecret) return null;
      if (!Array.isArray(data.pairedClients)) {
        data.pairedClients = [];
      }
      return data;
    } catch {
      return null;
    }
  }

  private write(identity: RemiIdentity): void {
    this.ensureDir();
    fs.writeFileSync(this.filePath, JSON.stringify(identity, null, 2), { encoding: 'utf-8', mode: 0o600 });
  }

  /** Load existing identity or create a new one. */
  load(): RemiIdentity {
    const existing = this.read();
    if (existing) {
      this.identity = existing;
      return existing;
    }

    const identity: RemiIdentity = {
      version: 1,
      deviceId: generateDeviceName(),
      deviceSecret: crypto.randomBytes(32).toString('hex'),
      pairedClients: [],
      createdAt: new Date().toISOString(),
    };
    this.write(identity);
    this.identity = identity;
    return identity;
  }

  /** Get the loaded identity (must call load() first). */
  get(): RemiIdentity {
    if (!this.identity) {
      return this.load();
    }
    return this.identity;
  }

  /** Get the device ID. */
  get deviceId(): string {
    return this.get().deviceId;
  }

  /** Get the device secret. */
  get deviceSecret(): string {
    return this.get().deviceSecret;
  }

  /** Add a paired client. Returns the generated pairing token. */
  addPairedClient(clientId: string, clientName: string): string {
    const identity = this.get();
    const token = this.generatePairingToken();

    const client: PairedClient = {
      clientId,
      clientName,
      pairingToken: token,
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    };

    identity.pairedClients.push(client);
    this.write(identity);
    return token;
  }

  /** Remove a paired client by ID. Returns true if found and removed. */
  removePairedClient(clientId: string): boolean {
    const identity = this.get();
    const before = identity.pairedClients.length;
    identity.pairedClients = identity.pairedClients.filter((c) => c.clientId !== clientId);
    if (identity.pairedClients.length === before) return false;
    this.write(identity);
    return true;
  }

  /** Find a paired client by ID. */
  findClient(clientId: string): PairedClient | null {
    const identity = this.get();
    return identity.pairedClients.find((c) => c.clientId === clientId) ?? null;
  }

  /** Update lastSeenAt for a client. */
  touchClient(clientId: string): void {
    const identity = this.get();
    const client = identity.pairedClients.find((c) => c.clientId === clientId);
    if (client) {
      client.lastSeenAt = new Date().toISOString();
      this.write(identity);
    }
  }

  /** Verify an HMAC challenge response from a client. */
  verifyChallenge(clientId: string, nonce: string, hmacHex: string): boolean {
    const client = this.findClient(clientId);
    if (!client) return false;

    const keyBytes = Buffer.from(client.pairingToken, 'hex');
    const expected = crypto.createHmac('sha256', keyBytes).update(nonce).digest('hex');

    // timingSafeEqual throws RangeError if lengths differ
    if (hmacHex.length !== expected.length) return false;

    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(hmacHex, 'hex'));
  }

  /** Generate a random 256-bit pairing token. */
  generatePairingToken(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  /** List all paired clients. */
  listClients(): PairedClient[] {
    return this.get().pairedClients;
  }
}
