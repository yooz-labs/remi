/** Relay enrollment is separate from direct trust; revoked authorization always wins. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RelayDevice } from '@remi/shared';
import { type IdentityStore, validatePublicKey } from '../auth/identity-store.ts';
import { newAuthorityEpoch } from '../storage/authority-epoch.ts';
import { withInterprocessFileLock } from '../storage/interprocess-file-lock.ts';
import {
  type StoredRelayDevice,
  readRelayEnrollments,
  writeRelayEnrollments,
} from '../storage/relay-enrollments.ts';
import { activateSecurePushLocked } from '../storage/secure-push-activation.ts';

export class RelayDeviceStore {
  constructor(
    private readonly dir: string,
    private readonly trust: IdentityStore,
  ) {}
  private read(): StoredRelayDevice[] {
    return readRelayEnrollments(this.dir);
  }
  list(): RelayDevice[] {
    const authorized = new Map(
      this.trust.loadAuthorizedKeys().keys.map((key) => [key.fingerprint, key]),
    );
    return this.read()
      .filter((device) => authorized.get(device.fingerprint)?.publicKey === device.publicKey)
      .map((device) => ({
        publicKey: device.publicKey,
        fingerprint: device.fingerprint,
        label: device.label,
        createdAt: device.createdAt,
        lastUsedAt: authorized.get(device.fingerprint)?.lastUsedAt ?? null,
      }));
  }
  isEnrolled(publicKey: string): boolean {
    return this.list().some((device) => device.publicKey === publicKey);
  }
  /** Capture only an authorized enrollment, with bounded lazy migration of its current row. */
  captureEnrollmentEpoch(publicKey: string): string | null {
    return this.trust.withAuthorizationEpoch(
      publicKey,
      (grant) => {
        if (!grant) return null;
        const fingerprint = this.trust
          .loadAuthorizedKeys()
          .keys.find((key) => key.publicKey === publicKey)?.fingerprint;
        const values = this.read();
        const device = values.find(
          (value) => value.publicKey === publicKey && value.fingerprint === fingerprint,
        );
        if (!device) return null;
        activateSecurePushLocked(this.dir);
        if (device.enrollmentEpoch) return device.enrollmentEpoch;
        const enrollmentEpoch = newAuthorityEpoch();
        writeRelayEnrollments(
          this.dir,
          values.map((value) => (value === device ? { ...device, enrollmentEpoch } : value)),
        );
        return enrollmentEpoch;
      },
      true,
    );
  }
  private change(update: (values: StoredRelayDevice[]) => StoredRelayDevice[]): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.dir, 0o700);
    withInterprocessFileLock(path.join(this.dir, 'authorized_keys.json'), () => {
      writeRelayEnrollments(this.dir, update(this.read()));
    });
  }
  async add(
    publicKey: string,
    label: string,
    mayCommit: () => boolean = () => true,
  ): Promise<RelayDevice> {
    const fingerprint = await validatePublicKey(publicKey);
    const device: RelayDevice = {
      publicKey,
      fingerprint,
      label,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    this.change((values) => {
      if (!mayCommit()) throw new Error('RELAY_CANCELLED');
      activateSecurePushLocked(this.dir);
      const stored: StoredRelayDevice = { ...device, enrollmentEpoch: newAuthorityEpoch() };
      return [...values.filter((value) => value.fingerprint !== fingerprint), stored];
    });
    return device;
  }
  remove(fingerprint: string): void {
    this.change((values) => {
      if (values.length > 0) activateSecurePushLocked(this.dir);
      return values.filter((value) => value.fingerprint !== fingerprint);
    });
  }
}
