/** Machine metadata (#1234, ADR 0039); names are display text, not identity or authorization. */
import * as os from 'node:os';
import { relayV2 } from '@remi/shared';

/** Same ID as the existing relay room, including for direct-only authenticated daemons. */
export async function machineIdForKey(publicKey: Uint8Array): Promise<string> {
  return Buffer.from(await relayV2.ridOf(publicKey)).toString('hex');
}

/** Pairing and the wire share a plain short name, bounded in Unicode scalars. */
export function defaultMachineName(hostname = os.hostname()): string {
  const short = hostname.split('.')[0] ?? '';
  const plain = Array.from(short.replace(/[^\p{L}\p{N} ._'-]/gu, ''))
    .slice(0, 64)
    .join('');
  return plain.length > 0 ? plain : 'remi';
}
