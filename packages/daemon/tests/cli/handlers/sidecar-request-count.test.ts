import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createCreateSessionHandlers } from '../../../src/cli/handlers/create-session-events.ts';
import { createResumeSessionHandlers } from '../../../src/cli/handlers/resume-session-events.ts';
import { validateClaudeRemoteArgs } from '../../../src/harness/claude-args.ts';
import { ClaudeHarness } from '../../../src/harness/index.ts';
import { HarnessRegistry } from '../../../src/harness/registry.ts';
import { inProcessResumeRefusal } from '../../../src/profiles/in-process-resume.ts';
import { parseProfiles } from '../../../src/profiles/profile-config.ts';
import { readProfileSidecar, sessionProfileOwner } from '../../../src/profiles/session-owner.ts';
import { SessionBindingStore } from '../../../src/session/session-binding-store.ts';
import { SessionProfilesFile } from '../../../src/session/session-profiles-file.ts';
import { SessionRegistryFile } from '../../../src/session/session-registry-file.ts';
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

test('hub resume passes the same policy snapshot into the child start', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2b-hub-snapshot-'));
  const registry = new SessionRegistry({ orphanTimeoutMs: 1000 });
  try {
    const profiles = parseProfiles({
      work: { label: 'Work', remote_selectable: true, claude: { expects: 'subscription' } },
    });
    if ('error' in profiles) throw new Error(profiles.error);
    const revision = profiles.entries['work']?.revision ?? '';
    const store = new SessionStore(path.join(root, 'sessions.json'));
    const target = crypto.randomUUID();
    const claudeId = crypto.randomUUID();
    store.save(
      {
        remiSessionId: target,
        claudeSessionId: claudeId,
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
    let profileReads = 0;
    let sidecarReads = 0;
    const readProfiles = () => {
      profileReads++;
      return profiles;
    };
    const readSidecar = () => {
      sidecarReads++;
      return readProfileSidecar(new SessionProfilesFile(root));
    };
    const discovery = new TranscriptDiscovery({ projectsDir: path.join(root, 'projects') });
    const responses: Array<{ type: string; success?: boolean }> = [];
    const create = createCreateSessionHandlers({
      harnesses: new HarnessRegistry({
        claude: { command: '/bin/sh', validateRemoteArgs: validateClaudeRemoteArgs },
      }),
      liveSessionsRegistry: new SessionRegistryFile(path.join(root, 'live')),
      spawningPorts: new Set(),
      basePort: 19200,
      portRange: 1,
      bindHost: '127.0.0.1',
      inheritedArgs: () => [],
      profiles: readProfiles,
      sidecar: readSidecar,
      resumeOwner: (_harness, id, sidecar, policy) => {
        expect(sidecar).toBeDefined();
        expect(policy).toBe(profiles);
        const record = store.findResumableByClaudeSessionId(id);
        if (!record) return null;
        const owner = sessionProfileOwner(record, sidecar, policy);
        return {
          record: true,
          ...(owner.owner === 'profile' && { profile: owner.id }),
          ...(owner.owner === 'hidden' && { hidden: true }),
        };
      },
      findAvailableTcpPort: async () => 19200,
      spawnDaemon: async () => ({ sessionId: crypto.randomUUID(), port: 19200, pid: 1 }),
      send: () => true,
    });
    const handler = createResumeSessionHandlers({
      readSidecar,
      readProfiles,
      isHiddenResumeOwner: (input, sidecar, policy) =>
        sessionProfileOwner(input, sidecar, policy).owner === 'hidden',
      childSessions: create.startSession,
      harnessId: 'claude',
      harnesses: () => ['claude'],
      sessionRegistry: registry,
      sessionStore: store,
      bindingStore: new SessionBindingStore(store),
      transcriptDiscovery: discovery,
      harness: new ClaudeHarness(discovery),
      checkResumeProfile: () => null,
      createNewSession: async () => {},
      send: (_id, message) => {
        responses.push(message);
        return true;
      },
    });
    await handler.onResumeSessionRequest(crypto.randomUUID(), target, crypto.randomUUID());
    expect(sidecarReads).toBe(1);
    expect(profileReads).toBe(1);
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ type: 'resume_session_response', success: true });
  } finally {
    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
