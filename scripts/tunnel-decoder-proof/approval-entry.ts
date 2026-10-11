/// <reference path="./pngjs.d.ts" />
import assert from 'node:assert/strict';

if (process.argv.includes('--approval-client')) {
  const { runApprovalClientMode } = await import('./approval-client');
  await runApprovalClientMode();
} else if (
  process.argv.includes('--owned-decode-worker') ||
  process.argv.includes('--owned-process-child')
) {
  // The worker mode imports the real decoder dispatcher, then exits from its owned handler.
  await import('./probe');
} else {
  assert(
    process.argv.includes('--approval-spike') && process.argv.includes('--owned-spike'),
    'use --owned-spike --approval-spike for the owned approval proof',
  );
  const [
    { decoderProofChecks, decoderPaletteImages, decoderChildExits },
    { approvalProof },
    { readApprovalImages },
    { default: inputs },
  ] = await Promise.all([
    import('./probe'),
    import('./approval-probe'),
    import('./approval-assets'),
    import('./inputs.json'),
  ]);
  const { png, jpg } = await readApprovalImages();
  const approval = await approvalProof(png, jpg);
  const checks = [...decoderProofChecks, ...approval.checks];
  console.log(
    JSON.stringify({
      bun: Bun.version,
      platform: process.platform,
      arch: process.arch,
      checks,
      images: inputs.images.map((image) => ({
        width: image.width,
        height: image.height,
        pixelBytes: image.pixelBytes,
        pixelSha256: image.pixelSha256,
      })),
      paletteImages: decoderPaletteImages,
      decoderChildExits,
      approvalLatencyMs: approval.scenarios.map((scenario) => scenario.latencyMs),
      approvalScenarios: approval.scenarios,
      ptyMutationControl: approval.ptyMutationControl,
      scope:
        '21 owned decoder and held-answer groups; Linux memory is a 512 MiB fixture only; portable resource enforcement and production adoption remain pending',
    }),
  );
}
