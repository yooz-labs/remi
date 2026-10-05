/** Relay enrollment is separate from direct trust; revoked authorization always wins. */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RelayDevice } from '@remi/shared';
import { type IdentityStore, validatePublicKey } from '../auth/identity-store.ts';
import { withInterprocessFileLock } from '../storage/interprocess-file-lock.ts';

export class RelayDeviceStore {
  private readonly file: string;
  constructor(
    private readonly dir: string,
    private readonly trust: IdentityStore,
  ) {
    this.file = path.join(dir, 'relay_devices.json');
  }
  private read(): RelayDevice[] {
    let values: unknown;
    try {
      values = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error('RELAY_STORAGE_ERROR');
    }
    if (
      !Array.isArray(values) ||
      values.some(
        (v) =>
          !v ||
          typeof v.publicKey !== 'string' ||
          !/^[0-9a-f]{16}$/.test(v.fingerprint) ||
          typeof v.label !== 'string' ||
          !Number.isFinite(Date.parse(v.createdAt)) ||
          (v.lastUsedAt !== null && !Number.isFinite(Date.parse(v.lastUsedAt))),
      )
    )
      throw new Error('RELAY_STORAGE_ERROR');
    return values as RelayDevice[];
  }
  list(): RelayDevice[] {
    const authorized = new Map(
      this.trust.loadAuthorizedKeys().keys.map((key) => [key.fingerprint, key]),
    );
    return this.read()
      .filter((device) => authorized.get(device.fingerprint)?.publicKey === device.publicKey)
      .map((device) => ({
        ...device,
        lastUsedAt: authorized.get(device.fingerprint)?.lastUsedAt ?? null,
      }));
  }
  isEnrolled(publicKey: string): boolean {
    return this.list().some((device) => device.publicKey === publicKey);
  }
  private change(update: (values: RelayDevice[]) => RelayDevice[]): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.dir, 0o700);
    withInterprocessFileLock(path.join(this.dir, 'authorized_keys.json'), () => {
      const values = update(this.read());
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(this.dir, 0o700);
      const temp = `${this.file}.${randomUUID()}.tmp`;
      let fd: number | undefined;
      try {
        fd = fs.openSync(temp, 'wx', 0o600);
        fs.writeFileSync(fd, JSON.stringify(values));
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        fs.renameSync(temp, this.file);
        const directory = fs.openSync(this.dir, 'r');
        try {
          fs.fsyncSync(directory);
        } finally {
          fs.closeSync(directory);
        }
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
        if (fs.existsSync(temp)) fs.unlinkSync(temp);
      }
    });
  }
  async add(publicKey: string, label: string): Promise<RelayDevice> {
    const fingerprint = await validatePublicKey(publicKey);
    const device: RelayDevice = {
      publicKey,
      fingerprint,
      label,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    this.change((values) => [
      ...values.filter((value) => value.fingerprint !== fingerprint),
      device,
    ]);
    return device;
  }
  remove(fingerprint: string): void {
    this.change((values) => values.filter((value) => value.fingerprint !== fingerprint));
  }
}
