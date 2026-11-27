import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createCreateSessionHandlers } from '../../../src/cli/handlers/create-session-events.ts';
import { validateClaudeRemoteArgs } from '../../../src/harness/claude-args.ts';
import { HarnessRegistry } from '../../../src/harness/registry.ts';
import { parseProfiles } from '../../../src/profiles/profile-config.ts';
import {
  RemotePolicyScope,
  makeResumeOwner,
  readProfileSidecar,
} from '../../../src/profiles/session-owner.ts';
import { visibleProfileRoots } from '../../../src/profiles/visibility.ts';
import { SessionProfilesFile } from '../../../src/session/session-profiles-file.ts';
import { SessionRegistryFile } from '../../../src/session/session-registry-file.ts';
import { SessionStore } from '../../../src/session/session-store.ts';
import { TranscriptDiscovery } from '../../../src/transcript/transcript-discovery.ts';
import { emptySidecar, noResumeOwner } from '../../helpers/no-profiles-policy.ts';

test('invalid profile configuration refuses creates before reservation or spawn', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2b-create-'));
  const mapped = path.join(root, 'mapped');
  fs.mkdirSync(mapped);
  let reserved = 0;
  let spawned = 0;
  const profiles = parseProfiles({ work: { folders: [mapped], remote_selectable: 'invalid' } });
  expect(profiles).toHaveProperty('error');
  const handler = createCreateSessionHandlers({
    sidecar: emptySidecar,
    resumeOwner: noResumeOwner,
    harnesses: new HarnessRegistry({}),
    liveSessionsRegistry: new SessionRegistryFile(root),
    spawningPorts: new Set(),
    basePort: 19200,
    portRange: 1,
    bindHost: '127.0.0.1',
    inheritedArgs: () => [],
    profiles: () => profiles,
    findAvailableTcpPort: async () => {
      reserved++;
      return 19200;
    },
    spawnDaemon: async () => {
      spawned++;
      return { sessionId: 'unused', port: 19200, pid: 1 };
    },
    send: () => true,
  });
  try {
    for (const directory of [mapped, root]) {
      for (const extra of [undefined, { profile: 'default' }, { profile: 'work' }]) {
        expect(await handler.startSession(directory, extra)).toEqual({
          ok: false,
          error:
            "This machine's profile settings have an error. Run remi profile ls on the machine.",
        });
      }
    }
    expect(reserved).toBe(0);
    expect(spawned).toBe(0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('no profiles table preserves the existing child arguments', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2b-plain-'));
  let spawned: string[] = [];
  const handler = createCreateSessionHandlers({
    sidecar: emptySidecar,
    resumeOwner: noResumeOwner,
    harnesses: new HarnessRegistry({}),
    liveSessionsRegistry: new SessionRegistryFile(root),
    spawningPorts: new Set(),
    basePort: 19200,
    portRange: 1,
    bindHost: '127.0.0.1',
    inheritedArgs: () => ['--no-auth'],
    profiles: () => parseProfiles(undefined),
    findAvailableTcpPort: async () => 19200,
    spawnDaemon: async (_port, _directory, args) => {
      spawned = args;
      return { sessionId: crypto.randomUUID(), port: 19200, pid: 1 };
    },
    send: () => true,
  });
  try {
    expect((await handler.startSession(root)).ok).toBe(true);
    expect(spawned).toEqual(['--no-auth', '--harness', 'claude']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('create and resume enforce selection before reserving a port', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2b-choice-'));
  const profiles = parseProfiles({
    work: {
      label: 'Work',
      folders: [path.join(root, 'work')],
      remote_selectable: true,
      claude: { expects: 'subscription' },
    },
    quiet: {
      label: 'Quiet',
      folders: [path.join(root, 'quiet')],
      claude: { expects: 'subscription' },
    },
    secret: {
      label: 'Secret label',
      folders: [path.join(root, 'secret')],
      remote_visible: false,
      claude: { expects: 'subscription' },
    },
    codexonly: { label: 'Codex', remote_selectable: true, codex: { expects: 'subscription' } },
  });
  if ('error' in profiles) throw new Error(profiles.error);
  let reservations = 0;
  const spawned: string[][] = [];
  const owners: Record<string, { record: boolean; profile?: string; hidden?: boolean }> = {
    '11111111-1111-4111-8111-111111111111': { record: true, hidden: true },
    '22222222-2222-4222-8222-222222222222': { record: true, profile: 'quiet' },
    '33333333-3333-4333-8333-333333333333': { record: true, profile: 'work' },
    '44444444-4444-4444-8444-444444444444': { record: false, profile: 'work' },
  };
  const handler = createCreateSessionHandlers({
    sidecar: emptySidecar,
    harnesses: new HarnessRegistry({
      claude: { command: '/bin/sh', validateRemoteArgs: validateClaudeRemoteArgs },
    }),
    liveSessionsRegistry: new SessionRegistryFile(root),
    spawningPorts: new Set(),
    basePort: 19200,
    portRange: 1,
    bindHost: '127.0.0.1',
    inheritedArgs: () => [],
    profiles: () => profiles,
    resumeOwner: (_harness, id) => owners[id] ?? null,
    findAvailableTcpPort: async () => {
      reservations++;
      return 19200;
    },
    spawnDaemon: async (_port, _directory, args) => {
      spawned.push(args);
      return { sessionId: crypto.randomUUID(), port: 19200, pid: 1 };
    },
    send: () => true,
  });
  try {
    const denied = [
      [
        path.join(root, 'quiet'),
        undefined,
        'New sessions in this folder use profile quiet, which does not accept sessions from your devices. To allow them, add remote_selectable = true to [profiles.quiet] in config.toml on that machine.',
      ],
      [
        path.join(root, 'secret'),
        undefined,
        'New sessions in this folder use a profile that does not accept sessions from your devices.',
      ],
      [
        root,
        { profile: 'quiet' },
        'Profile quiet does not accept sessions from your devices. To allow them, add remote_selectable = true to [profiles.quiet] in config.toml on that machine.',
      ],
      ...['unknown', 'bad id', 'secret'].map(
        (profile) =>
          [
            root,
            { profile },
            'This profile is not available for new sessions from your devices. Run remi profile ls on the machine.',
          ] as const,
      ),
      [root, { profile: 'codexonly' }, 'This profile does not configure that harness.'],
      [
        root,
        { args: ['--resume', Object.keys(owners)[0]] },
        'That session was not found on this machine.',
      ],
      [
        root,
        { args: ['--resume', Object.keys(owners)[1]] },
        "This session's profile quiet does not accept sessions from your devices. Resume it on that machine with remi --resume, or add remote_selectable = true to [profiles.quiet] in config.toml there.",
      ],
      [
        root,
        { profile: 'quiet', args: ['--resume', Object.keys(owners)[2]] },
        'This session belongs to another profile; resume it without choosing a profile.',
      ],
    ] as const;
    for (const [directory, extra, error] of denied)
      expect(await handler.startSession(directory as string, extra as never)).toEqual({
        ok: false,
        error,
      });
    expect(reservations).toBe(0);
    expect(spawned).toEqual([]);
    expect((await handler.startSession(root, { profile: 'work' })).ok).toBe(true);
    expect((await handler.startSession(path.join(root, 'work'))).ok).toBe(true);
    expect(
      (await handler.startSession(root, { args: ['--resume', Object.keys(owners)[2] as string] }))
        .ok,
    ).toBe(true);
    expect(
      (await handler.startSession(root, { args: ['--resume', Object.keys(owners)[3] as string] }))
        .ok,
    ).toBe(true);
    expect(spawned[0]?.slice(0, 4)).toEqual(['--remi-profile', 'work', '--harness', 'claude']);
    expect(spawned[1]?.slice(0, 4)).toEqual(['--remi-profile', 'work', '--harness', 'claude']);
    expect(spawned[2]).not.toContain('--remi-profile');
    expect(spawned[3]?.slice(0, 4)).toEqual(['--remi-profile', 'work', '--harness', 'claude']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the real resume owner resolver pins a record-less transcript to its root', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p2b-resume-owner-')));
  try {
    const workDir = path.join(root, 'work-config');
    const secretDir = path.join(root, 'P2B-MARKER-HIDDEN');
    const profiles = parseProfiles({
      work: {
        label: 'Work',
        remote_selectable: true,
        claude: { expects: 'subscription', dir: workDir },
      },
      secret: {
        label: 'Secret label',
        remote_visible: false,
        claude: { expects: 'subscription', dir: secretDir },
      },
    });
    if ('error' in profiles) throw new Error(profiles.error);
    const transcript = (dir: string) => {
      const id = crypto.randomUUID();
      const project = path.join(dir, 'projects', '-project');
      fs.mkdirSync(project, { recursive: true });
      fs.writeFileSync(
        path.join(project, `${id}.jsonl`),
        `${JSON.stringify({ type: 'user', uuid: 'u1', sessionId: id, cwd: root, timestamp: new Date().toISOString(), message: { role: 'user', content: 'x' } })}\n`,
      );
      return id;
    };
    const workTranscript = transcript(workDir);
    // The hub lists only visible roots, so a hidden root's transcript is not found at all.
    const secretTranscript = transcript(secretDir);
    const store = new SessionStore(path.join(root, 'sessions.json'));
    const revision = profiles.entries['work']?.revision ?? '';
    const recordClaudeId = crypto.randomUUID();
    store.save(
      {
        remiSessionId: crypto.randomUUID(),
        claudeSessionId: recordClaudeId,
        projectPath: root,
        port: 19200,
        pid: null,
        startedAt: new Date().toISOString(),
        exitedAt: new Date().toISOString(),
        exitCode: 0,
        profile: 'work',
        profileSnapshot: { revision },
      },
      { profile: 'work', revision },
    );
    const scope = new RemotePolicyScope(
      () => profiles,
      () => readProfileSidecar(new SessionProfilesFile(root)),
    );
    const discovery = new TranscriptDiscovery({
      projectsDir: path.join(root, 'default'),
      profileRoots: () => visibleProfileRoots(profiles, scope.profiles()),
    });
    const spawned: string[][] = [];
    const handler = createCreateSessionHandlers({
      profiles: scope.profiles,
      sidecar: scope.sidecar,
      resumeOwner: makeResumeOwner({
        sessionStore: store,
        discovery,
        within: (fn, snapshot) => scope.run(fn, snapshot),
      }),
      harnesses: new HarnessRegistry({
        claude: { command: '/bin/sh', validateRemoteArgs: validateClaudeRemoteArgs },
      }),
      liveSessionsRegistry: new SessionRegistryFile(path.join(root, 'live')),
      spawningPorts: new Set(),
      basePort: 19200,
      portRange: 1,
      bindHost: '127.0.0.1',
      inheritedArgs: () => [],
      findAvailableTcpPort: async () => 19200,
      spawnDaemon: async (_port, _directory, args) => {
        spawned.push(args);
        return { sessionId: crypto.randomUUID(), port: 19200, pid: 1 };
      },
      send: () => true,
    });
    const resume = (id: string) =>
      scope.run(() => handler.startSession(root, { args: ['--resume', id] }));
    expect((await resume(workTranscript)).ok).toBe(true);
    expect(spawned[0]?.slice(0, 4)).toEqual(['--remi-profile', 'work', '--harness', 'claude']);
    expect((await resume(recordClaudeId)).ok).toBe(true);
    expect(spawned[1]).not.toContain('--remi-profile');
    // Not found by the hub's discovery: an unknown id is a create in the folder's default.
    expect((await resume(secretTranscript)).ok).toBe(true);
    expect(spawned[2]?.slice(0, 4)).toEqual(['--remi-profile', 'default', '--harness', 'claude']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
