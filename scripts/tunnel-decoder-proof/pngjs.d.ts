// Minimal API used from pinned pngjs 7.0.0; decoded dimensions/length are checked at runtime.
declare module 'pngjs' {
  export const PNG: {
    sync: {
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
declare module '*.png' {
  const asset: string;
  export default asset;
}
declare module '*.jpg' {
  const asset: string;
  export default asset;
}
