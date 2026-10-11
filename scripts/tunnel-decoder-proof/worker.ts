import { MAX_INPUT_BYTES } from './admission';
import { decodeImage } from './decode';

export async function decodeInput(mediaType: string | undefined) {
  if (mediaType !== 'image/png' && mediaType !== 'image/jpeg') throw new Error('kind');
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const part of Bun.stdin.stream()) {
    size += part.byteLength;
    if (size > MAX_INPUT_BYTES) throw new Error('size');
    parts.push(part);
  }
  const decoded = decodeImage(Buffer.concat(parts), mediaType);
  return {
    kind: 'decoded',
    width: decoded.width,
    height: decoded.height,
    pixelBytes: decoded.data.byteLength,
    pixelSha256: new Bun.CryptoHasher('sha256').update(decoded.data).digest('hex'),
  };
}

export async function decodeWorker(mediaType: string | undefined): Promise<void> {
  try {
    console.log(JSON.stringify(await decodeInput(mediaType)));
  } catch {
    console.log('{"kind":"refused"}');
    process.exitCode = 1;
  }
}
