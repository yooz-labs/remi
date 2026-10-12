/// <reference path="../../packages/daemon/src/tunnel/native-assets.d.ts" />
declare module '*.png' {
  const filename: string;
  export default filename;
}
