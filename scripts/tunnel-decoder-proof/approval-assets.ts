import jpgAsset from './fixture.jpg' with { type: 'file' };
import pngAsset from './fixture.png' with { type: 'file' };

export async function readApprovalImages(): Promise<{ png: Buffer; jpg: Buffer }> {
  return {
    png: Buffer.from(await Bun.file(pngAsset).arrayBuffer()),
    jpg: Buffer.from(await Bun.file(jpgAsset).arrayBuffer()),
  };
}
