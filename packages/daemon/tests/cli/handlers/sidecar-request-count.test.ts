import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProtocolMessage, UUID } from '@remi/shared';
import type { MessageAPI } from '../../../src/api/message-api.ts';
import { SubagentViewRegistry } from '../../../src/api/subagent-view-registry.ts';
import { createCreateSessionHandlers } from '../../../src/cli/handlers/create-session-events.ts';
import { createRecentRepositoriesHandlers } from '../../../src/cli/handlers/recent-repositories-events.ts';
import { createResumeSessionHandlers } from '../../../src/cli/handlers/resume-session-events.ts';
import { createSessionHandlers } from '../../../src/cli/handlers/session-events.ts';
import { visibleLivePorts } from '../../../src/cli/handlers/session-list-entries.ts';
import { createTranscriptHandlers } from '../../../src/cli/handlers/transcript-events.ts';
import { createTrivialHandlers } from '../../../src/cli/handlers/trivial-events.ts';
import { validateClaudeRemoteArgs } from '../../../src/harness/claude-args.ts';
import { ClaudeHarness } from '../../../src/harness/index.ts';
import { HarnessRegistry } from '../../../src/harness/registry.ts';
import { inProcessResumeRefusal } from '../../../src/profiles/in-process-resume.ts';
import { parseProfiles } from '../../../src/profiles/profile-config.ts';
import {
  RemotePolicyScope,
  makeIsHiddenSessionOwner,
  readProfileSidecar,
  sessionProfileOwner,
} from '../../../src/profiles/session-owner.ts';
import { visibleProfileRoots } from '../../../src/profiles/visibility.ts';
import type { PTYSession } from '../../../src/pty/pty-session.ts';
import { SessionBindingStore } from '../../../src/session/session-binding-store.ts';
import { SessionProfilesFile } from '../../../src/session/session-profiles-file.ts';
import { SessionRegistryFile } from '../../../src/session/session-registry-file.ts';
import { SessionRegistry } from '../../../src/session/session-registry.ts';
import { SessionStore } from '../../../src/session/session-store.ts';
import { TranscriptIndex } from '../../../src/session/transcript-index.ts';
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

test('list, live-port, listing and transcript-load requests read the policy once each', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p2b-request-count-')));
  const registry = new SessionRegistry({ orphanTimeoutMs: 1000 });
  try {
    const workDir = path.join(root, 'work');
    const profiles = parseProfiles({
      work: {
        label: 'Work',
        remote_selectable: true,
        claude: { expects: 'subscription', dir: workDir },
      },
    });
    if ('error' in profiles) throw new Error(profiles.error);
    const revision = profiles.entries['work']?.revision ?? '';
    // A transcript in work's root, so every scan of the hub's roots reads the policy.
    const transcriptId = crypto.randomUUID();
    const project = path.join(workDir, 'projects', '-project');
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(
      path.join(project, `${transcriptId}.jsonl`),
      `${JSON.stringify({ type: 'user', uuid: 'u1', sessionId: transcriptId, timestamp: new Date().toISOString(), message: { role: 'user', content: 'COUNT-CONTENT' } })}\n`,
    );
    const store = new SessionStore(path.join(root, 'sessions.json'));
    const save = (id: UUID, projectPath: string) =>
      store.save(
        {
          remiSessionId: id,
          claudeSessionId: null,
          projectPath,
          port: 19301,
          pid: null,
          startedAt: new Date().toISOString(),
          exitedAt: null,
          exitCode: null,
          profile: 'work',
          profileSnapshot: { revision },
        },
        { profile: 'work', revision },
      );
    // An own session and a live sibling, each owned by work: both need the sidecar.
    const own = registry.createSessionId();
    registry.registerSession(
      own,
      root,
      {
        id: crypto.randomUUID(),
        write: () => {},
        submitInput: async () => {},
        close: async () => {},
      } as unknown as PTYSession,
      { getFullBulletContent: () => null } as unknown as MessageAPI,
    );
    save(own, root);
    const sibling = crypto.randomUUID() as UUID;
    save(sibling, root);
    const live = new SessionRegistryFile(path.join(root, 'live'));
    live.register({
      sessionId: sibling,
      pid: process.pid,
      wsPort: 19302,
      hookPort: 19303,
      projectPath: root,
      name: 'sibling',
      startedAt: new Date().toISOString(),
    });
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
    let profileReads = 0;
    // The scope cli.ts builds, over counting readers.
    const scope = new RemotePolicyScope(
      () => {
        profileReads++;
        return profiles;
      },
      () => readProfileSidecar(sidecar),
    );
    const discovery = new TranscriptDiscovery({
      projectsDir: path.join(root, 'default'),
      profileRoots: () => visibleProfileRoots(profiles, scope.profiles()),
    });
    const frames: ProtocolMessage[] = [];
    const send = (_id: UUID, message: ProtocolMessage) => {
      frames.push(message);
      return true;
    };
    const sessions = createSessionHandlers({
      profiles: scope.profiles,
      sidecar: scope.sidecar,
      profileOfSession: (id) => store.findByRemiSessionId(id),
      visibleLivePorts: () =>
        visibleLivePorts({
          listLive: () => live.listLive(),
          profileOfSession: (id) => store.findByRemiSessionId(id),
          profiles: scope.profiles,
          sidecar: scope.sidecar,
        }),
      withholdTranscriptPaths: false,
      sessionRegistry: registry,
      bindingStore: new SessionBindingStore(store),
      transcriptDiscovery: discovery,
      harness: new ClaudeHarness(discovery),
      liveSessionsRegistry: live,
      currentPort: () => 19300,
      untrackConnection: () => {},
      onConnectionRemoved: () => {},
      send,
    });
    const transcripts = createTranscriptHandlers({
      isHiddenOwner: makeIsHiddenSessionOwner({ sessionStore: store, discovery }, () => ({
        profiles: scope.profiles(),
        sidecar: scope.sidecar(),
      })),
      transcriptDiscovery: discovery,
      harness: new ClaudeHarness(discovery),
      transcriptWatchers: new Map(),
      bindingStore: new SessionBindingStore(store),
      transcriptIndex: new TranscriptIndex(path.join(root, 'index.json')),
      currentOwnedSession: () => null,
      subagentViews: new SubagentViewRegistry(),
      send,
    });
    const recent = createRecentRepositoriesHandlers({
      profiles: scope.profiles,
      sidecar: scope.sidecar,
      sessionStore: store,
      send,
    });
    const trivial = createTrivialHandlers({
      profiles: scope.profiles,
      sidecar: scope.sidecar,
      sessionStore: store,
      sessionRegistry: registry,
      registerDeviceToken: () => {},
      unregisterDeviceToken: () => {},
      send,
    });
    const measure = async (request: () => unknown) => {
      profileReads = 0;
      sidecar.reads = 0;
      frames.length = 0;
      await scope.run(request);
      return { profileReads, sidecarReads: sidecar.reads };
    };

    expect(
      await measure(() =>
        sessions.onSessionListRequest(crypto.randomUUID(), crypto.randomUUID(), true),
      ),
    ).toEqual({ profileReads: 1, sidecarReads: 1 });
    // The reads were needed: the own entry, the live sibling's port and the external entry.
    expect(frames).toMatchObject([
      {
        type: 'session_list_response',
        daemonPorts: [19302],
        sessions: [
          { sessionId: own, profile: { id: 'work' } },
          { sessionId: transcriptId, profile: { id: 'work' } },
        ],
      },
    ]);

    expect(
      await measure(() =>
        transcripts.onTranscriptLoadRequest(crypto.randomUUID(), transcriptId, crypto.randomUUID()),
      ),
    ).toEqual({ profileReads: 1, sidecarReads: 0 });
    // A remi id: the record is owned through the sidecar.
    expect(
      await measure(() =>
        transcripts.onTranscriptLoadRequest(crypto.randomUUID(), sibling, crypto.randomUUID()),
      ),
    ).toEqual({ profileReads: 1, sidecarReads: 1 });

    expect(
      await measure(() =>
        recent.onRecentRepositoriesRequest(crypto.randomUUID(), crypto.randomUUID(), undefined),
      ),
    ).toEqual({ profileReads: 1, sidecarReads: 1 });
    expect(
      await measure(() =>
        trivial.onSessionHistoryRequest(crypto.randomUUID(), crypto.randomUUID(), undefined),
      ),
    ).toEqual({ profileReads: 1, sidecarReads: 1 });
  } finally {
    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
