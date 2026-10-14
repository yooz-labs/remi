#!/usr/bin/env bun
// #1170: dispatch owned decoder children before any CLI/home/config imports.
if (process.argv[2] === '--internal-image-worker') {
  const mediaType = process.argv[3];
  if (process.argv.length !== 4 || (mediaType !== 'image/png' && mediaType !== 'image/jpeg')) {
    console.log('{"kind":"refused"}');
    process.exit(1);
  }
  const { decodeWorker } = await import('./tunnel/image-worker');
  await decodeWorker(mediaType);
} else if (process.argv[2] === '--internal-browser-link') {
  const { runBrowserLinkCommand } = await import('./tunnel/browser-link-command');
  process.exitCode = await runBrowserLinkCommand(process.argv.slice(3));
} else {
  // Only the first operand selects internal mode; words after -- stay CLI arguments.
  await import('./cli');
}

export {};
