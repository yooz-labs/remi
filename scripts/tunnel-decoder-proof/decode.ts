import jpeg from 'jpeg-js';
// #1170 candidate only. Header admission precedes full decode; process limits are unproved.
import { PNG } from 'pngjs';
import { admitImage } from './admission';

export function decodeImage(bytes: Buffer, mediaType: 'image/png' | 'image/jpeg') {
  const admitted = admitImage(bytes, mediaType);
  try {
    const decoded =
      mediaType === 'image/png'
        ? PNG.sync.read(bytes, { checkCRC: true })
        : jpeg.decode(bytes, {
            useTArray: true,
            tolerantDecoding: false,
            maxResolutionInMP: 32,
            maxMemoryUsageInMB: 256,
          });
    if (
      decoded.width !== admitted.width ||
      decoded.height !== admitted.height ||
      decoded.data.byteLength !== admitted.width * admitted.height * 4
    )
      throw new Error('decode disagreement');
    return decoded;
  } catch {
    throw new Error('IMAGE_DECODE_REFUSED'); // Never expose decoder text or input bytes.
  }
}
