/** Pairing secrets go only to the requesting interactive terminal, through a local capability. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { generateId } from '@remi/shared';
import { toString as qrCode } from 'qrcode';
import { remiHome } from '../config/remi-home.ts';
import { capabilityWsOptions } from './capability-client.ts';

export function escapeDeviceName(name: string): string {
  return JSON.stringify(name).replace(
    /[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}
export async function runRelayCommand(
  command: 'pair' | 'devices',
  args: readonly string[],
  explicitPort?: number,
): Promise<number> {
  if (command === 'pair' && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    console.error('Run remi pair in an interactive terminal to compare fingerprints and confirm.');
    return 1;
  }
  let port = explicitPort;
  if (port === undefined) {
    try {
      const status = JSON.parse(
        fs.readFileSync(path.join(remiHome(), 'daemon-status.json'), 'utf8'),
      ) as Record<string, unknown>;
      if (status['mode'] !== 'hub' || typeof status['wsPort'] !== 'number') throw new Error('hub');
      port = status['wsPort'];
    } catch {
      console.error('Start the local hub with remi serve --relay first.');
      return 1;
    }
  }
  const options = capabilityWsOptions();
  if (!options || !Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) {
    console.error('Local hub capability unavailable.');
    return 1;
  }
  const requestId = generateId();
  const request =
    command === 'pair'
      ? { t: 'pair', id: requestId }
      : args.length === 0
        ? { t: 'devices', id: requestId }
        : args.length === 2 && args[0] === 'revoke' && /^[0-9a-f]{16}$/.test(args[1] ?? '')
          ? { t: 'revoke', id: requestId, fingerprint: args[1] }
          : undefined;
  if (!request) {
    console.error('Usage: remi devices [revoke <exact fingerprint>]');
    return 1;
  }
  return new Promise<number>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/relay-control`, options as never);
    let done = false;
    let reader: ReturnType<typeof createInterface> | undefined;
    const finish = (code: number) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reader?.close();
      ws.close();
      resolve(code);
    };
    const timer = setTimeout(
      () => {
        console.error('Local relay operation timed out; outcome unverified.');
        finish(1);
      },
      command === 'pair' ? 600000 : 10000,
    );
    ws.onopen = () => ws.send(JSON.stringify(request));
    let tail = Promise.resolve();
    ws.onmessage = (event) => {
      tail = tail
        .then(async () => {
          if (done || typeof event.data !== 'string' || event.data.length > 65536)
            throw new Error('control');
          const value = JSON.parse(event.data) as Record<string, unknown>;
          if (value['t'] === 'error') {
            console.error(
              'Local relay operation refused; start an authenticated hub with --relay and retry.',
            );
            finish(1);
            return;
          }
          if (value['id'] !== requestId) throw new Error('correlation');
          if (
            command === 'pair' &&
            value['t'] === 'offer' &&
            typeof value['token'] === 'string' &&
            value['token'].startsWith('remi-pair2:')
          ) {
            const qr = await qrCode(value['token'], {
              type: 'terminal',
              small: true,
              errorCorrectionLevel: 'M',
              margin: 4,
            });
            if (done) return;
            process.stdout.write(
              `${qr}\n${value['token']}\nCompare the fingerprint on both devices before confirming.\n`,
            );
          } else if (
            command === 'pair' &&
            value['t'] === 'compare' &&
            typeof value['fingerprint'] === 'string' &&
            /^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/.test(value['fingerprint']) &&
            typeof value['deviceName'] === 'string' &&
            typeof value['offerId'] === 'string' &&
            typeof value['connectionId'] === 'string'
          ) {
            process.stdout.write(
              `Device ${escapeDeviceName(value['deviceName'])}\nFingerprint: ${value['fingerprint']}\n`,
            );
            reader = createInterface({ input: process.stdin, output: process.stdout });
            const accept =
              (await reader.question('Do both fingerprints match? [y/N] ')).trim().toLowerCase() ===
              'y';
            reader.close();
            reader = undefined;
            if (!done)
              ws.send(
                JSON.stringify({
                  t: 'confirm',
                  id: requestId,
                  offerId: value['offerId'],
                  connectionId: value['connectionId'],
                  fingerprint: value['fingerprint'],
                  accept,
                }),
              );
            if (!accept) {
              console.error('Pairing declined.');
              finish(1);
            }
          } else if (command === 'pair' && value['t'] === 'paired') {
            console.log('Device paired.');
            finish(0);
          } else if (
            command === 'devices' &&
            value['t'] === 'devices' &&
            Array.isArray(value['devices'])
          ) {
            console.log(JSON.stringify(value['devices'], null, 2));
            finish(0);
          } else if (
            command === 'devices' &&
            value['t'] === 'revoked' &&
            typeof value['success'] === 'boolean' &&
            typeof value['edgeAcknowledged'] === 'boolean'
          ) {
            console.log(
              value['success']
                ? `Local authorization revoked. Worker outcome ${value['edgeAcknowledged'] ? 'acknowledged' : 'unverified'}.`
                : 'Revocation refused.',
            );
            finish(value['success'] && value['edgeAcknowledged'] ? 0 : 1);
          } else throw new Error('control');
        })
        .catch(() => {
          console.error('Invalid local relay response; outcome unverified.');
          finish(1);
        });
    };
    ws.onerror = () => {
      console.error('Cannot reach local relay control; start remi serve --relay.');
      finish(1);
    };
    ws.onclose = () => {
      if (!done) {
        console.error('Local relay closed; outcome unverified.');
        finish(1);
      }
    };
  });
}
