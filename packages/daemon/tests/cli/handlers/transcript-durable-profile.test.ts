import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProtocolMessage, UUID } from '@remi/shared';
import { SubagentViewRegistry } from '../../../src/api/subagent-view-registry.ts';
import { createTranscriptHandlers } from '../../../src/cli/handlers/transcript-events.ts';
import { ClaudeHarness } from '../../../src/harness/claude.ts';
import { SessionBindingStore } from '../../../src/session/session-binding-store.ts';
import { SessionStore } from '../../../src/session/session-store.ts';
import { TranscriptIndex } from '../../../src/session/transcript-index.ts';
import { TranscriptDiscovery } from '../../../src/transcript/transcript-discovery.ts';

test('durable index finds a profile transcript after the session record is gone', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-profile-'));
  try {
    const work = path.join(root, 'work');
    const dir = path.join(work, '-project');
    fs.mkdirSync(dir, { recursive: true });
    const claudeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const remiId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as UUID;
    fs.writeFileSync(
      path.join(dir, `${claudeId}.jsonl`),
      `${JSON.stringify({ type: 'user', uuid: 'u1', sessionId: claudeId, timestamp: new Date().toISOString(), message: { role: 'user', content: 'DURABLE-PROFILE-CONTENT' } })}\n`,
    );
    const discovery = new TranscriptDiscovery({
      projectsDir: path.join(root, 'primary'),
      profileRoots: () => [{ profile: 'work', projectsDir: work }],
    });
    const index = new TranscriptIndex(path.join(root, 'index.json'));
    index.record(remiId, claudeId, '/project');
    const store = new SessionStore(path.join(root, 'sessions.json'));
    const frames: ProtocolMessage[] = [];
    const handlers = createTranscriptHandlers({
      transcriptDiscovery: discovery,
      harness: new ClaudeHarness(discovery),
      transcriptWatchers: new Map(),
      bindingStore: new SessionBindingStore(store),
      transcriptIndex: index,
      currentOwnedSession: () => null,
      subagentViews: new SubagentViewRegistry(),
      send: (_id, message) => {
        frames.push(message);
        return true;
      },
    });
    handlers.onTranscriptLoadRequest(crypto.randomUUID(), remiId, crypto.randomUUID());
    const end = Date.now() + 5000;
    while (!frames.some((m) => m.type === 'transcript_load_complete') && Date.now() < end)
      await Bun.sleep(10);
    expect(frames.some((m) => m.type === 'transcript_load_complete')).toBe(true);
    expect(JSON.stringify(frames)).toContain('DURABLE-PROFILE-CONTENT');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
