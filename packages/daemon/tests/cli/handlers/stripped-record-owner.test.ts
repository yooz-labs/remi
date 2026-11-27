import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { type ProtocolMessage, generateId } from '@remi/shared';
import { SubagentViewRegistry } from '../../../src/api/subagent-view-registry.ts';
import { createResumeSessionHandlers } from '../../../src/cli/handlers/resume-session-events.ts';
import { createTranscriptHandlers } from '../../../src/cli/handlers/transcript-events.ts';
import { ClaudeHarness } from '../../../src/harness/index.ts';
import { inProcessResumeRefusal } from '../../../src/profiles/in-process-resume.ts';
import { parseProfiles } from '../../../src/profiles/profile-config.ts';
import {
  makeIsHiddenSessionOwner,
  readProfileSidecar,
  sessionProfileOwner,
} from '../../../src/profiles/session-owner.ts';
import { SessionBindingStore } from '../../../src/session/session-binding-store.ts';
import { SessionProfilesFile } from '../../../src/session/session-profiles-file.ts';
import { SessionRegistry } from '../../../src/session/session-registry.ts';
import { SessionStore } from '../../../src/session/session-store.ts';
import { TranscriptIndex } from '../../../src/session/transcript-index.ts';
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
          readSidecar: () => readProfileSidecar(sidecar),
          readProfiles: () => profiles,
          isHiddenResumeOwner: (input, snapshot, policy) =>
            sessionProfileOwner(input, snapshot, policy).owner === 'hidden',
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
      readSidecar: () => readProfileSidecar(sidecar),
      readProfiles: () => profiles,
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
        inProcessResumeRefusal(store, snapshot, profiles, policy, 'default', id, () => {}),
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

test('a transcript load of a stripped hidden record takes the not-found path', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2b-stripped-load-'));
  try {
    const store = new SessionStore(path.join(root, 'sessions.json'));
    const target = generateId();
    const claudeId = generateId();
    const record = {
      remiSessionId: target,
      claudeSessionId: claudeId,
      projectPath: path.join(root, 'P2B-MARKER-HIDDEN'),
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
    // An older writer removed the profile fields; the sidecar still names secret.
    store.save(record);
    const profiles = parseProfiles({
      secret: { label: 'Hidden label', remote_visible: false, claude: { expects: 'subscription' } },
    });
    // The transcript sits in a root this handler scans, so only the owner check hides it.
    const project = path.join(root, 'projects', '-project');
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(
      path.join(project, `${claudeId}.jsonl`),
      `${JSON.stringify({ type: 'user', uuid: 'u1', sessionId: claudeId, timestamp: new Date().toISOString(), message: { role: 'user', content: 'P2B-HIDDEN-CONTENT' } })}\n`,
    );
    const discovery = new TranscriptDiscovery({ projectsDir: path.join(root, 'projects') });
    const frames: ProtocolMessage[] = [];
    const handlers = createTranscriptHandlers({
      isHiddenOwner: makeIsHiddenSessionOwner({ sessionStore: store, discovery }, () => ({
        profiles,
        sidecar: readProfileSidecar(new SessionProfilesFile(root)),
      })),
      transcriptDiscovery: discovery,
      harness: new ClaudeHarness(discovery),
      transcriptWatchers: new Map(),
      bindingStore: new SessionBindingStore(store),
      transcriptIndex: new TranscriptIndex(path.join(root, 'index.json')),
      currentOwnedSession: () => null,
      subagentViews: new SubagentViewRegistry(),
      send: (_id, message) => {
        frames.push(message);
        return true;
      },
    });
    for (const id of [target, claudeId]) {
      frames.length = 0;
      handlers.onTranscriptLoadRequest(generateId(), id, generateId());
      await Bun.sleep(50);
      expect(frames).toMatchObject([
        { type: 'error', code: 'NOT_FOUND', message: `Transcript for session ${id} not found` },
      ]);
      for (const forbidden of ['P2B-MARKER-HIDDEN', 'P2B-HIDDEN-CONTENT', 'secret', 'Hidden label'])
        expect(JSON.stringify(frames)).not.toContain(forbidden);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
