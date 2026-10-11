// Minimal API used from pinned pngjs 7.0.0; decoded dimensions/length are checked at runtime.
declare module 'pngjs' {
  export const PNG: {
    sync: {
      write(
        pixels: { width: number; height: number; data: Buffer },
        options: { colorType: 2 | 6; inputColorType: 6; bitDepth: 8 },
      ): Buffer;
      read(
        bytes: Buffer,
        options: { checkCRC: boolean },
      ): {
        width: number;
        height: number;
        data: Buffer;
      };
    };
  };
}
declare module 'pngjs/lib/crc' {
  const CRC: { crc32(bytes: Buffer): number };
  export default CRC;
}
declare module '*.png' {
  const asset: string;
  export default asset;
}
declare module '*.jpg' {
  const asset: string;
  export default asset;
}
