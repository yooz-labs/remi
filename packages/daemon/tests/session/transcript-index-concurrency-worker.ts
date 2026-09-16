// Worker process for transcript-index-concurrency.test.ts. NOT a test file.
// It records unique bindings into one shared TranscriptIndex so the test can
// exercise the real cross-process read-modify-write path.
//
// Usage: bun transcript-index-concurrency-worker.ts <indexFilePath> <iterations>
import type { UUID } from '@remi/shared';
import { TranscriptIndex } from '../../src/session/transcript-index.ts';

const filePath = process.argv[2];
const iterations = Number(process.argv[3]) || 40;

if (!filePath) {
  process.stderr.write('worker: missing transcript index file path\n');
  process.exit(2);
}

const index = new TranscriptIndex(filePath);
const workerTag = crypto.randomUUID();

for (let i = 0; i < iterations; i++) {
  const remiSessionId = crypto.randomUUID() as UUID;
  index.record(remiSessionId, `claude-${workerTag}-${i}`, '/tmp/transcript-index-project');
}

process.exit(0);
