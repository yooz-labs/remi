// Scratch candidate only. Admission does not prove valid pixels or bounded decoder memory/CPU.
// Layout references: https://www.w3.org/TR/png-3/#11IHDR
// JPEG T.81 Annex B: https://www.w3.org/Graphics/JPEG/itu-t81.pdf
export const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const MAX_SIDE = 8192;
const MAX_PIXELS = 32_000_000;
export type Dimensions = Readonly<{ width: number; height: number }>;

function refuse(): never {
  throw new Error('IMAGE_ADMISSION_REFUSED');
}

function dimensions(width: number, height: number): Dimensions {
  if (
    width < 1 ||
    height < 1 ||
    width > MAX_SIDE ||
    height > MAX_SIDE ||
    width * height > MAX_PIXELS
  )
    refuse();
  return Object.freeze({ width, height });
}

export function admitImage(bytes: Uint8Array, mediaType: 'image/png' | 'image/jpeg'): Dimensions {
  if (mediaType !== 'image/png' && mediaType !== 'image/jpeg') refuse();
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_INPUT_BYTES) refuse();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return mediaType === 'image/png' ? pngDimensions(bytes, view) : jpegDimensions(bytes, view);
}

function pngDimensions(bytes: Uint8Array, view: DataView): Dimensions {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 33 || signature.some((byte, i) => bytes[i] !== byte)) refuse();
  let offset = 8;
  let result: Dimensions | undefined;
  let imageData = false;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) refuse();
    const type = view.getUint32(offset + 4);
    if (!result && type !== 0x49484452) refuse(); // IHDR must be first.
    if (type === 0x49484452) {
      if (result || length !== 13) refuse();
      result = dimensions(view.getUint32(offset + 8), view.getUint32(offset + 12));
      // pngjs 7's interlaced sync branch uses uncapped zlib.inflateSync. Candidate only.
      if (bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || bytes[offset + 20] !== 0)
        refuse();
    } else if (type === 0x6163544c || type === 0x6663544c || type === 0x66644154) {
      refuse(); // acTL/fcTL/fdAT: this candidate admits a single static image only.
    } else if (type === 0x49444154) {
      imageData = true;
    } else if (type === 0x49454e44) {
      if (length !== 0 || !imageData || end !== bytes.length || !result) refuse();
      return result;
    }
    offset = end;
  }
  return refuse(); // No complete IEND; CRC and pixel validation still belong to full decode.
}

function jpegDimensions(bytes: Uint8Array, view: DataView): Dimensions {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) refuse();
  let offset = 2;
  let entropy = false;
  let result: Dimensions | undefined;
  let componentCount = 0;
  let scans = 0;
  // Every iteration advances within the admitted byte count. Never allocate pixels here.
  while (offset < bytes.length) {
    if (entropy) {
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }
      if (offset + 1 >= bytes.length) refuse();
      const next = bytes[offset + 1];
      if (next === 0 || (next >= 0xd0 && next <= 0xd7)) {
        offset += 2;
        continue;
      }
      entropy = false;
    }
    if (bytes[offset++] !== 0xff) refuse();
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) refuse();
    const marker = bytes[offset++];
    if (marker === 0xd9) {
      if (!result || !scans || offset !== bytes.length) refuse();
      return result;
    }
    if (marker === 0 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) refuse();
    if (marker === 1) refuse(); // This decoder candidate does not implement TEM.
    if (offset + 2 > bytes.length) refuse();
    const length = view.getUint16(offset);
    const end = offset + length;
    if (length < 2 || end > bytes.length) refuse();
    const payload = offset + 2;
    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      // jpeg-js supports SOF0/1/2. Refuse a second frame before either can allocate.
      if (result || marker > 0xc2 || length < 8 || bytes[payload] !== 8) refuse();
      componentCount = bytes[payload + 5];
      if (componentCount < 1 || componentCount > 4 || length !== 8 + 3 * componentCount) refuse();
      result = dimensions(view.getUint16(payload + 3), view.getUint16(payload + 1));
      const ids = new Set<number>();
      for (let i = 0; i < componentCount; i++) {
        const start = payload + 6 + 3 * i;
        const id = bytes[start];
        const horizontal = bytes[start + 1] >> 4;
        const vertical = bytes[start + 1] & 15;
        if (
          ids.has(id) ||
          horizontal < 1 ||
          horizontal > 4 ||
          vertical < 1 ||
          vertical > 4 ||
          bytes[start + 2] > 3
        )
          refuse();
        ids.add(id);
      }
    } else if (marker === 0xdb) {
      quantizationTables(bytes, payload, end);
    } else if (marker === 0xc4) {
      huffmanTables(bytes, payload, end);
    } else if (marker === 0xdd) {
      // jpeg-js consumes exactly four bytes regardless of the declared DRI length.
      if (length !== 4) refuse();
    } else if (marker === 0xda) {
      if (!result || length < 6) refuse();
      const components = bytes[payload];
      if (components < 1 || components > componentCount || length !== 6 + 2 * components) refuse();
      scans++;
      entropy = true;
    } else if (!(marker >= 0xe0 && marker <= 0xef) && marker !== 0xfe) {
      // Only bounded APP/COM payloads may be skipped; unknown marker recovery is unadmitted.
      refuse();
    }
    offset = end;
  }
  return refuse();
}

function quantizationTables(bytes: Uint8Array, start: number, end: number): void {
  if (start === end) refuse();
  let offset = start;
  while (offset < end) {
    const spec = bytes[offset++];
    const precision = spec >> 4;
    if (precision > 1 || (spec & 15) > 3) refuse();
    offset += 64 * (precision + 1);
    if (offset > end) refuse();
  }
}

function huffmanTables(bytes: Uint8Array, start: number, end: number): void {
  if (start === end) refuse();
  let offset = start;
  while (offset < end) {
    if (offset + 17 > end) refuse();
    const spec = bytes[offset++];
    if (spec >> 4 > 1 || (spec & 15) > 3) refuse();
    let symbols = 0;
    let slots = 1;
    for (let i = 0; i < 16; i++) {
      const count = bytes[offset++];
      symbols += count;
      slots = 2 * slots - count;
      if (slots < 0) refuse();
    }
    if (symbols < 1 || symbols > 256) refuse();
    offset += symbols;
    if (offset > end) refuse();
  }
}
