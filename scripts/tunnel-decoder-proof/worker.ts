import { MAX_INPUT_BYTES } from './admission';
import { decodeImage } from './decode';

export async function decodeInput(mediaType: string | undefined) {
  if (mediaType !== 'image/png' && mediaType !== 'image/jpeg') throw new Error('kind');
  const bytes = await readImageBytes();
  return decodeBytes(bytes, mediaType);
}

async function readImageBytes(): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const part of Bun.stdin.stream()) {
    size += part.byteLength;
    if (size > MAX_INPUT_BYTES) throw new Error('size');
    parts.push(part);
  }
  return Buffer.concat(parts);
}

function decodeBytes(bytes: Buffer, mediaType: 'image/png' | 'image/jpeg') {
  const decoded = decodeImage(bytes, mediaType);
  return {
    kind: 'decoded',
    width: decoded.width,
    height: decoded.height,
    pixelBytes: decoded.data.byteLength,
    pixelSha256: new Bun.CryptoHasher('sha256').update(decoded.data).digest('hex'),
  };
}

export async function decodeRepeatedWorker(mediaType: string | undefined): Promise<void> {
  if (mediaType !== 'image/png' && mediaType !== 'image/jpeg') throw new Error('kind');
  const bytes = await readImageBytes();
  const first = decodeBytes(bytes, mediaType);
  const second = decodeBytes(bytes, mediaType);
  if (
    first.width !== second.width ||
    first.height !== second.height ||
    first.pixelBytes !== second.pixelBytes ||
    first.pixelSha256 !== second.pixelSha256
  )
    throw new Error('pixel disagreement');
  await Bun.write(Bun.stdout, `${JSON.stringify({ ...second, kind: 'ready', decodes: 2 })}\n`);
  while (true) {
    const repeated = decodeBytes(bytes, mediaType);
    if (
      first.width !== repeated.width ||
      first.height !== repeated.height ||
      first.pixelBytes !== repeated.pixelBytes ||
      first.pixelSha256 !== repeated.pixelSha256
    )
      throw new Error('pixel disagreement');
  }
}

export async function decodeWorker(mediaType: string | undefined): Promise<void> {
  try {
    console.log(JSON.stringify(await decodeInput(mediaType)));
  } catch {
    console.log('{"kind":"refused"}');
    process.exitCode = 1;
  }
}
