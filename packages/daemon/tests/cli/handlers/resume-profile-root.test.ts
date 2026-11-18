import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createCreateSessionHandlers } from '../../../src/cli/handlers/create-session-events.ts';
import { createResumeSessionHandlers } from '../../../src/cli/handlers/resume-session-events.ts';
import { validateClaudeRemoteArgs } from '../../../src/harness/claude-args.ts';
import { ClaudeHarness } from '../../../src/harness/claude.ts';
import { HarnessRegistry } from '../../../src/harness/registry.ts';
import { SessionBindingStore } from '../../../src/session/session-binding-store.ts';
import { SessionRegistryFile } from '../../../src/session/session-registry-file.ts';
import { SessionRegistry } from '../../../src/session/session-registry.ts';
import { SessionStore } from '../../../src/session/session-store.ts';
import { TranscriptDiscovery } from '../../../src/transcript/transcript-discovery.ts';

test('create and resume routes carry only recordless profile ownership', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-profile-'));
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const primary = path.join(root, 'primary');
  const work = path.join(root, 'work');
  const profileId = '11111111-1111-4111-8111-111111111111';
  const primaryId = '22222222-2222-4222-8222-222222222222';
  const recordId = '33333333-3333-4333-8333-333333333333';
  for (const [dir, ids] of [
    [work, [profileId, recordId]],
    [primary, [primaryId]],
  ] as const) {
    fs.mkdirSync(path.join(dir, '-project'), { recursive: true });
    for (const id of ids)
      fs.writeFileSync(
        path.join(dir, '-project', `${id}.jsonl`),
        `${JSON.stringify({ cwd: project })}\n`,
      );
  }
  const store = new SessionStore(path.join(root, 'sessions.json'));
  store.save({
    remiSessionId: crypto.randomUUID(),
    claudeSessionId: recordId,
    projectPath: project,
    port: 0,
    pid: null,
    startedAt: new Date().toISOString(),
    exitedAt: new Date().toISOString(),
    exitCode: 0,
    profile: 'work',
  });
  const discovery = new TranscriptDiscovery({
    projectsDir: primary,
    profileRoots: () => [{ profile: 'work', projectsDir: work }],
  });
  const registry = new SessionRegistry({});
  const args: string[][] = [];
  const handlers = createCreateSessionHandlers({
    harnesses: new HarnessRegistry({
      claude: { command: '/bin/sh', validateRemoteArgs: validateClaudeRemoteArgs },
    }),
    liveSessionsRegistry: new SessionRegistryFile(path.join(root, 'live')),
    spawningPorts: new Set(),
    basePort: 19990,
    portRange: 1,
    bindHost: '127.0.0.1',
    inheritedArgs: () => ['--no-auth'],
    resumeProfileOf: (harness, id) =>
      harness === 'claude' && !store.findResumableByClaudeSessionId(id)
        ? discovery.profileOfTranscript(id)
        : undefined,
    findAvailableTcpPort: async () => 19990,
    spawnDaemon: async (port, _dir, extra) => {
      args.push(extra);
      return { port, pid: process.pid, sessionId: crypto.randomUUID() };
    },
    send: () => true,
  });
  try {
    expect((await handlers.startSession(project, { args: ['--resume', profileId] })).ok).toBe(true);
    const resume = createResumeSessionHandlers({
      childSessions: handlers.startSession,
      harnessId: 'claude',
      harnesses: () => ['claude'],
      sessionRegistry: registry,
      sessionStore: store,
      bindingStore: new SessionBindingStore(store),
      transcriptDiscovery: discovery,
      harness: new ClaudeHarness(discovery),
      createNewSession: async () => {
        throw new Error('hub must start a child');
      },
      checkResumeProfile: () => null,
      send: () => true,
    });
    await resume.onResumeSessionRequest(crypto.randomUUID(), profileId, crypto.randomUUID());
    const expected = [
      '--no-auth',
      '--remi-profile',
      'work',
      '--harness',
      'claude',
      '--',
      '--resume',
      profileId,
    ];
    expect(args.slice(0, 2)).toEqual([expected, expected]);
    expect(args).toHaveLength(2);
    await handlers.startSession(project, { args: ['--resume', primaryId] });
    await handlers.startSession(project, { args: ['--resume', recordId] });
    await handlers.startSession(project);
    expect(args[2]).toEqual(['--no-auth', '--harness', 'claude', '--', '--resume', primaryId]);
    expect(args[3]).toEqual(['--no-auth', '--harness', 'claude', '--', '--resume', recordId]);
    expect(args[4]).toEqual(['--no-auth', '--harness', 'claude']);
  } finally {
    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
