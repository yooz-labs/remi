/// <reference path="../../packages/daemon/src/tunnel/image-codecs.d.ts" />
declare module '*.png' {
  const asset: string;
  export default asset;
}
declare module '*.jpg' {
  const asset: string;
  export default asset;
}
