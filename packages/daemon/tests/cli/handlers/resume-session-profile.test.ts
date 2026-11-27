import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { type ProtocolMessage, generateId } from '@remi/shared';
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

test('hidden records are concealed before resume resolution errors on both routes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2b-resume-handler-'));
  const registry = new SessionRegistry({ orphanTimeoutMs: 1000 });
  try {
    const store = new SessionStore(path.join(root, 'sessions.json'));
    const bindingStore = new SessionBindingStore(store);
    const projects = path.join(root, 'projects');
    const discovery = new TranscriptDiscovery({ projectsDir: projects, primaryProfile: 'secret' });
    const target = generateId();
    const profiles = parseProfiles({
      secret: {
        label: 'Secret',
        remote_visible: false,
        claude: { expects: 'subscription', dir: path.join(root, 'hidden') },
      },
    });
    store.save(
      {
        remiSessionId: target,
        claudeSessionId: generateId(),
        projectPath: path.join(root, 'P2B-MARKER-HIDDEN'),
        port: 19200,
        pid: null,
        startedAt: new Date().toISOString(),
        exitedAt: null,
        exitCode: null,
        profile: 'secret',
        profileSnapshot: { revision: 'test' },
      },
      { profile: 'secret', revision: 'test' },
    );
    const targets = [target];
    for (const variant of ['other-harness', 'non-uuid', 'empty-path'] as const) {
      const id = generateId();
      targets.push(id);
      store.save(
        {
          remiSessionId: id,
          claudeSessionId:
            variant === 'other-harness' ? null : variant === 'non-uuid' ? 'non-uuid' : generateId(),
          ...(variant === 'other-harness' && { harness: 'codex', harnessSessionId: generateId() }),
          projectPath: path.join(root, 'P2B-MARKER-HIDDEN'),
          port: 19200,
          pid: null,
          startedAt: new Date().toISOString(),
          exitedAt: null,
          exitCode: null,
          profile: 'secret',
          profileSnapshot: { revision: 'test' },
        },
        { profile: 'secret', revision: 'test' },
      );
    }
    const sessionsFile = path.join(root, 'sessions.json');
    const data = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
    data.sessions.find(
      (record: { remiSessionId: string }) => record.remiSessionId === targets[3],
    ).projectPath = '';
    fs.writeFileSync(sessionsFile, JSON.stringify(data));
    const transcriptId = generateId();
    targets.push(transcriptId);
    fs.mkdirSync(path.join(projects, '-synthetic'), { recursive: true });
    fs.writeFileSync(
      path.join(projects, '-synthetic', `${transcriptId}.jsonl`),
      `${JSON.stringify({ cwd: path.join(root, 'P2B-MARKER-HIDDEN') })}\n`,
    );
    for (const hub of [false, true]) {
      const messages: ProtocolMessage[] = [];
      const handler = createResumeSessionHandlers({
        isHiddenResumeOwner: () => (input) =>
          sessionProfileOwner(input, readProfileSidecar(new SessionProfilesFile(root)), profiles)
            .owner === 'hidden',
        childSessions: hub
          ? async () => {
              throw new Error('unexpected child');
            }
          : null,
        harnessId: 'claude',
        harnesses: () => ['claude'],
        sessionRegistry: registry,
        sessionStore: store,
        bindingStore,
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
      for (const id of targets) {
        messages.length = 0;
        await handler.onResumeSessionRequest(generateId(), id, generateId());
        expect(messages).toHaveLength(1);
        const response = messages[0];
        expect(response?.type).toBe('resume_session_response');
        if (response?.type !== 'resume_session_response') throw new Error('wrong response');
        expect(response.success).toBe(false);
        expect(response.error).toBe(
          `Session ${id} not found. No Claude session ID available for resume.`,
        );
        expect('code' in response).toBe(false);
        for (const forbidden of ['P2B-MARKER-HIDDEN', 'secret', 'Secret'])
          expect(JSON.stringify(messages)).not.toContain(forbidden);
      }
    }
  } finally {
    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('in-process resume enforces current selectability and retains removed-profile refusal', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2b-inprocess-'));
  const registry = new SessionRegistry({ orphanTimeoutMs: 1000 });
  try {
    const original = parseProfiles({
      work: { label: 'Work', remote_selectable: true, claude: { expects: 'subscription' } },
      quiet: { label: 'Quiet', claude: { expects: 'subscription' } },
      removed: { label: 'Removed', remote_selectable: true, claude: { expects: 'subscription' } },
    });
    if ('error' in original) throw new Error(original.error);
    const current = parseProfiles({
      work: { label: 'Work', remote_selectable: true, claude: { expects: 'subscription' } },
      quiet: { label: 'Quiet', claude: { expects: 'subscription' } },
    });
    const store = new SessionStore(path.join(root, 'sessions.json'));
    const sidecar = new SessionProfilesFile(root);
    const discovery = new TranscriptDiscovery({ projectsDir: path.join(root, 'projects') });
    const messages: ProtocolMessage[] = [];
    let own = 'quiet';
    let creates = 0;
    const handler = createResumeSessionHandlers({
      isHiddenResumeOwner: () => (input) =>
        sessionProfileOwner(input, readProfileSidecar(sidecar), current).owner === 'hidden',
      childSessions: null,
      harnessId: 'claude',
      harnesses: () => ['claude'],
      sessionRegistry: registry,
      sessionStore: store,
      bindingStore: new SessionBindingStore(store),
      transcriptDiscovery: discovery,
      harness: new ClaudeHarness(discovery),
      checkResumeProfile: (id) =>
        inProcessResumeRefusal(store, sidecar, original, current, own, id, () => {}),
      createNewSession: async () => {
        creates++;
      },
      send: (_id, message) => {
        messages.push(message);
        return true;
      },
    });
    const make = (profile: string) => {
      const id = generateId();
      const revision = original.entries[profile]?.revision ?? '';
      store.save(
        {
          remiSessionId: id,
          claudeSessionId: generateId(),
          projectPath: root,
          port: 19200,
          pid: null,
          startedAt: new Date().toISOString(),
          exitedAt: null,
          exitCode: null,
          profile,
          profileSnapshot: { revision },
        },
        { profile, revision },
      );
      return id;
    };
    const quiet = make('quiet');
    const work = make('work');
    const removed = make('removed');
    await handler.onResumeSessionRequest(generateId(), quiet, generateId());
    expect(messages.at(-1)).toMatchObject({
      success: false,
      error:
        "This session's profile quiet does not accept sessions from your devices. Resume it on that machine with remi --resume, or add remote_selectable = true to [profiles.quiet] in config.toml there.",
    });
    expect(creates).toBe(0);
    own = 'work';
    await handler.onResumeSessionRequest(generateId(), work, generateId());
    expect(creates).toBe(1);
    own = 'removed';
    await handler.onResumeSessionRequest(generateId(), removed, generateId());
    expect(messages.at(-1)).toMatchObject({
      success: false,
      error:
        'This session was started in profile removed, which no longer exists. Start a new session.',
    });
  } finally {
    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
