import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createResumeSessionHandlers } from '../../../src/cli/handlers/resume-session-events.ts';
import { ClaudeHarness } from '../../../src/harness/index.ts';
import { inProcessResumeRefusal } from '../../../src/profiles/in-process-resume.ts';
import { parseProfiles } from '../../../src/profiles/profile-config.ts';
import { readProfileSidecar, sessionProfileOwner } from '../../../src/profiles/session-owner.ts';
import { SessionBindingStore } from '../../../src/session/session-binding-store.ts';
import { SessionProfilesFile } from '../../../src/session/session-profiles-file.ts';
import { SessionRegistry } from '../../../src/session/session-registry.ts';
import { SessionStore } from '../../../src/session/session-store.ts';
import { TranscriptDiscovery } from '../../../src/transcript/transcript-discovery.ts';

test('one in-process resume reads one sidecar snapshot', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2b-sidecar-count-'));
  const registry = new SessionRegistry({ orphanTimeoutMs: 1000 });
  try {
    const profiles = parseProfiles({
      work: { label: 'Work', remote_selectable: true, claude: { expects: 'subscription' } },
    });
    if ('error' in profiles) throw new Error(profiles.error);
    const revision = profiles.entries['work']?.revision ?? '';
    const store = new SessionStore(path.join(root, 'sessions.json'));
    const target = crypto.randomUUID();
    store.save(
      {
        remiSessionId: target,
        claudeSessionId: crypto.randomUUID(),
        projectPath: root,
        port: 19200,
        pid: null,
        startedAt: new Date().toISOString(),
        exitedAt: null,
        exitCode: null,
        profile: 'work',
        profileSnapshot: { revision },
      },
      { profile: 'work', revision },
    );
    class CountingSidecar extends SessionProfilesFile {
      reads = 0;
      override snapshot() {
        this.reads++;
        return super.snapshot();
      }
      override get(id: string) {
        this.reads++;
        return super.get(id);
      }
    }
    const sidecar = new CountingSidecar(root);
    const discovery = new TranscriptDiscovery({ projectsDir: path.join(root, 'projects') });
    let profileReads = 0;
    const handler = createResumeSessionHandlers({
      readSidecar: () => readProfileSidecar(sidecar),
      readProfiles: () => {
        profileReads++;
        return profiles;
      },
      isHiddenResumeOwner: (input, snapshot, policy) =>
        sessionProfileOwner(input, snapshot, policy).owner === 'hidden',
      childSessions: null,
      harnessId: 'claude',
      harnesses: () => ['claude'],
      sessionRegistry: registry,
      sessionStore: store,
      bindingStore: new SessionBindingStore(store),
      transcriptDiscovery: discovery,
      harness: new ClaudeHarness(discovery),
      checkResumeProfile: (id, snapshot, policy) =>
        inProcessResumeRefusal(store, snapshot, profiles, policy, 'work', id, () => {}),
      createNewSession: async () => {},
      send: () => true,
    });
    await handler.onResumeSessionRequest(crypto.randomUUID(), target, crypto.randomUUID());
    expect(sidecar.reads).toBe(1);
    expect(profileReads).toBe(1);
  } finally {
    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
