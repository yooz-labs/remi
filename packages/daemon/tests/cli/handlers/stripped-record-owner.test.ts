import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateId } from '@remi/shared';
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

test('stripped hidden ownership stays concealed with intact and damaged sidecars', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2b-stripped-'));
  const registry = new SessionRegistry({ orphanTimeoutMs: 1000 });
  try {
    const hiddenPath = path.join(root, 'P2B-MARKER-HIDDEN');
    const store = new SessionStore(path.join(root, 'sessions.json'));
    const target = generateId();
    const record = {
      remiSessionId: target,
      claudeSessionId: generateId(),
      projectPath: hiddenPath,
      port: 19200,
      pid: null,
      startedAt: new Date().toISOString(),
      exitedAt: null,
      exitCode: null,
    };
    store.save(
      { ...record, profile: 'secret', profileSnapshot: { revision: 'test' } },
      { profile: 'secret', revision: 'test' },
    );
    store.save(record);
    const sidecar = new SessionProfilesFile(root);
    expect(sidecar.get(target)?.profile).toBe('secret');
    const profiles = parseProfiles({
      secret: {
        label: 'Hidden label',
        remote_visible: false,
        claude: { dir: hiddenPath, expects: 'subscription' },
      },
    });
    const discovery = new TranscriptDiscovery({ projectsDir: path.join(root, 'projects') });
    for (const damaged of [false, true]) {
      if (damaged) fs.writeFileSync(path.join(root, 'session-profiles.json'), '{');
      for (const hub of [false, true]) {
        const messages: unknown[] = [];
        const handler = createResumeSessionHandlers({
          isHiddenResumeOwner: () => (input) =>
            sessionProfileOwner(input, readProfileSidecar(sidecar), profiles).owner === 'hidden',
          childSessions: hub
            ? async () => {
                throw new Error('unexpected child');
              }
            : null,
          harnessId: 'claude',
          harnesses: () => ['claude'],
          sessionRegistry: registry,
          sessionStore: store,
          bindingStore: new SessionBindingStore(store),
          transcriptDiscovery: discovery,
          harness: new ClaudeHarness(discovery),
          checkResumeProfile: () => null,
          createNewSession: async () => {
            throw new Error('unexpected spawn');
          },
          send: (_id, message) => {
            messages.push(message);
            return true;
          },
        });
        await handler.onResumeSessionRequest(generateId(), target, generateId());
        expect(messages).toMatchObject([
          {
            success: false,
            error: `Session ${target} not found. No Claude session ID available for resume.`,
          },
        ]);
        for (const forbidden of ['P2B-MARKER-HIDDEN', 'secret', 'Hidden label'])
          expect(JSON.stringify(messages)).not.toContain(forbidden);
      }
    }
  } finally {
    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a profile-free record resumes without a profiles table even if the sidecar is damaged', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2b-plain-resume-'));
  const registry = new SessionRegistry({ orphanTimeoutMs: 1000 });
  try {
    const store = new SessionStore(path.join(root, 'sessions.json'));
    const target = generateId();
    store.save({
      remiSessionId: target,
      claudeSessionId: generateId(),
      projectPath: root,
      port: 19200,
      pid: null,
      startedAt: new Date().toISOString(),
      exitedAt: null,
      exitCode: null,
    });
    fs.writeFileSync(path.join(root, 'session-profiles.json'), '{');
    const sidecar = new SessionProfilesFile(root);
    const profiles = parseProfiles(undefined);
    const discovery = new TranscriptDiscovery({ projectsDir: path.join(root, 'projects') });
    let created = 0;
    const handler = createResumeSessionHandlers({
      isHiddenResumeOwner: () => (input) =>
        sessionProfileOwner(input, readProfileSidecar(sidecar), profiles).owner === 'hidden',
      childSessions: null,
      harnessId: 'claude',
      harnesses: () => ['claude'],
      sessionRegistry: registry,
      sessionStore: store,
      bindingStore: new SessionBindingStore(store),
      transcriptDiscovery: discovery,
      harness: new ClaudeHarness(discovery),
      checkResumeProfile: (id) =>
        inProcessResumeRefusal(store, sidecar, profiles, profiles, 'default', id, () => {}),
      createNewSession: async () => {
        created++;
      },
      send: () => true,
    });
    await handler.onResumeSessionRequest(generateId(), target, generateId());
    expect(created).toBe(1);
  } finally {
    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
