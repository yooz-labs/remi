import { relayV2 } from '@remi/shared';
import { usesNativeIdentity } from './native-identity';

interface Ingress {
  postMessage(request: {
    readonly op: 'scanQR' | 'cancelQR';
    readonly id: string;
  }): Promise<unknown>;
}
/** User-selected image decoding stays native; only bounded token text crosses guarded ingress. */
export async function readNativePairingQR(signal: AbortSignal): Promise<string | null> {
  signal.throwIfAborted();
  const bridge = (
    window as unknown as { webkit?: { messageHandlers?: { remiIdentity?: Ingress } } }
  ).webkit?.messageHandlers?.remiIdentity;
  if (!usesNativeIdentity() || !bridge)
    throw new Error('Native QR selection unavailable. Paste the token.');
  const id = crypto.randomUUID();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort!: () => void;
  const canceled = new Promise<never>((_, reject) => {
    abort = () => {
      void bridge.postMessage({ op: 'cancelQR', id }).catch(() => {});
      reject(new DOMException('QR selection canceled', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(abort, 120000);
  });
  try {
    const response = await Promise.race([bridge.postMessage({ op: 'scanQR', id }), canceled]);
    signal.throwIfAborted();
    if (!response || typeof response !== 'object' || Array.isArray(response))
      throw new Error('Invalid native QR reply.');
    const record = response as Record<string, unknown>;
    if (Object.keys(record).length === 1 && record['cancelled'] === true) return null;
    if (
      Object.keys(record).length !== 1 ||
      typeof record['token'] !== 'string' ||
      record['token'].length > 4096
    )
      throw new Error('Invalid native QR token.');
    const decoded = await relayV2.decodePairingToken(
      record['token'],
      Math.floor(Date.now() / 1000),
    );
    decoded.secret.fill(0);
    signal.throwIfAborted();
    return record['token'];
  } finally {
    signal.removeEventListener('abort', abort);
    clearTimeout(timer);
  }
}
