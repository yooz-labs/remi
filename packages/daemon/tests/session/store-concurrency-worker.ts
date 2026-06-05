// Worker process for session-store-concurrency.test.ts. NOT a test file
// (its name does not match the bun test glob). It hammers a shared
// sessions.json via SessionStore.save() so the test can exercise the
// multi-writer tmp-rename race (#461) with REAL concurrent processes.
//
// Usage: bun store-concurrency-worker.ts <sessionsFilePath> <iterations>
import type { UUID } from '@remi/shared';
import { SessionStore } from '../../src/session/session-store.ts';

const filePath = process.argv[2];
const iterations = Number(process.argv[3]) || 50;

if (!filePath) {
  process.stderr.write('worker: missing sessions file path\n');
  process.exit(2);
}

const store = new SessionStore(filePath);
const workerTag = crypto.randomUUID();

for (let i = 0; i < iterations; i++) {
  store.save({
    remiSessionId: crypto.randomUUID() as UUID,
    claudeSessionId: `claude-${workerTag}-${i}`,
    projectPath: '/tmp/concurrency-project',
    port: 18000 + (i % 200),
    pid: process.pid,
    startedAt: new Date().toISOString(),
    exitedAt: null,
    exitCode: null,
  });
}

process.exit(0);
