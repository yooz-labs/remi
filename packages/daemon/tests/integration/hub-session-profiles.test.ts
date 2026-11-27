import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type ProtocolMessage,
  createCreateSessionRequest,
  createRecentRepositoriesRequest,
  createResumeSessionRequest,
  createSessionHistoryRequest,
  createSessionListRequest,
  createSessionProfilesRequest,
  createTranscriptLoadRequest,
  generateId,
  serialize,
} from '@remi/shared';
import { DEFAULT_CONFIG } from '../../src/config/config.ts';
import { SessionStore } from '../../src/session/session-store.ts';
import { reserveRange } from '../session/port-test-helpers.ts';
import { CLI_TS, cleanupHub, makeIsolatedDirs, pollUntil, spawnHub } from './hub-test-utils.ts';
import { connectAndHelloRaw } from './profile-frame-helpers.ts';

test('hub lists selectable profiles, starts work and conceals a hidden session', async () => {
  const dirs = makeIsolatedDirs();
  const remi = path.join(dirs.home, '.remi');
  const bin = path.join(dirs.home, 'bin');
  const workConfig = path.join(dirs.home, 'work-config');
  const quietConfig = path.join(dirs.home, 'quiet-config');
  const quietFolder = path.join(dirs.home, 'quiet-folder');
  const hidden = path.join(dirs.home, 'P2B-MARKER-HIDDEN');
  const output = path.join(dirs.home, 'agent-output');
  const argumentsLog = path.join(dirs.home, 'arguments.jsonl');
  const entrypoint = path.join(dirs.home, 'entrypoint.ts');
  for (const dir of [remi, bin, workConfig, quietConfig, quietFolder, hidden])
    fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(bin, 'bun'));
  fs.writeFileSync(
    entrypoint,
    `import * as fs from 'node:fs';\nfs.appendFileSync(process.env.REMI_TEST_ARGUMENTS!, JSON.stringify(process.argv.slice(2)) + '\\n');\nawait import(${JSON.stringify(CLI_TS)});\n`,
  );
  fs.writeFileSync(
    path.join(bin, 'claude'),
    `#!/bin/sh\nif [ "$1 $2 $3" = 'auth status --json' ]; then printf '%s' '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}'; exit 0; fi\nprintf '%s' "$CLAUDE_CONFIG_DIR" > "$FAKE_OUTPUT"\ni=0\nwhile [ ! -e "$FAKE_OUTPUT.release" ] && [ "$i" -lt 600 ]; do sleep 0.1; i=$((i + 1)); done\n`,
    { mode: 0o700 },
  );
  fs.writeFileSync(
    path.join(remi, 'config.toml'),
    `[profiles.work]\nlabel="Work"\nfolders=[${JSON.stringify(dirs.work)}]\nremote_selectable=true\n[profiles.work.claude]\nexpects="subscription"\ndir=${JSON.stringify(workConfig)}\n[profiles.quiet]\nlabel="Quiet"\nfolders=[${JSON.stringify(quietFolder)}]\n[profiles.quiet.claude]\nexpects="subscription"\ndir=${JSON.stringify(quietConfig)}\n[profiles.secret]\nlabel="Hidden label"\nremote_visible=false\n[profiles.secret.claude]\nexpects="subscription"\ndir=${JSON.stringify(hidden)}\n`,
  );
  const secretId = generateId();
  const claudeId = generateId();
  const store = new SessionStore(path.join(remi, 'sessions.json'));
  const stripped = {
    remiSessionId: secretId,
    claudeSessionId: claudeId,
    projectPath: hidden,
    port: 19200,
    pid: null,
    startedAt: new Date().toISOString(),
    exitedAt: new Date().toISOString(),
    exitCode: 0,
  };
  store.save(
    { ...stripped, profile: 'secret', profileSnapshot: { revision: 'old', label: 'Hidden label' } },
    { profile: 'secret', revision: 'old' },
  );
  store.save(stripped);
  const liveDir = path.join(remi, 'live-sessions');
  fs.mkdirSync(liveDir, { recursive: true });
  const hiddenPort = 49321;
  fs.writeFileSync(
    path.join(liveDir, 'synthetic.json'),
    JSON.stringify({
      sessionId: secretId,
      pid: process.pid,
      wsPort: hiddenPort,
      hookPort: hiddenPort + 1,
      projectPath: hidden,
      name: 'synthetic',
      startedAt: new Date().toISOString(),
    }),
  );
  const transcriptDir = path.join(hidden, 'projects', '-synthetic');
  fs.mkdirSync(transcriptDir, { recursive: true });
  fs.writeFileSync(
    path.join(transcriptDir, `${claudeId}.jsonl`),
    `${JSON.stringify({ type: 'user', uuid: generateId(), sessionId: claudeId, cwd: hidden, timestamp: new Date().toISOString(), message: { role: 'user', content: 'test' } })}\n`,
  );
  const port = await reserveRange(20, 50, DEFAULT_CONFIG.daemon.bind);
  const hub = await spawnHub(
    dirs,
    {
      PATH: `${bin}:/usr/bin:/bin`,
      FAKE_OUTPUT: output,
      REMI_PORT: String(port),
      REMI_TEST_ARGUMENTS: argumentsLog,
    },
    entrypoint,
    port,
  );
  const client = await connectAndHelloRaw(port);
  const ask = async (request: ProtocolMessage, type: string) => {
    const start = client.received.length;
    client.ws.send(serialize(request));
    await pollUntil(
      () =>
        client.received
          .slice(start)
          .some(
            (message) =>
              message.type === type &&
              ('requestId' in message ? message.requestId === request.id : true),
          ),
      15000,
      type,
    );
    return client.received
      .slice(start)
      .find(
        (message) =>
          message.type === type &&
          ('requestId' in message ? message.requestId === request.id : true),
      );
  };
  try {
    const available = await ask(
      createSessionProfilesRequest(dirs.work),
      'session_profiles_response',
    );
    expect(available).toMatchObject({
      profiles: [{ id: 'default' }, { id: 'work' }],
      default: { id: 'work', source: 'folder' },
    });
    const started = await ask(
      createCreateSessionRequest(dirs.work, { profile: 'work' }),
      'create_session_response',
    );
    expect(started).toMatchObject({
      success: true,
      profile: { id: 'work', label: 'Work', state: 'current' },
    });
    await pollUntil(() => fs.existsSync(output), 15000, 'fake agent');
    expect(fs.readFileSync(output, 'utf8')).toBe(workConfig);
    if (!started || started.type !== 'create_session_response' || !started.port)
      throw new Error('missing child port');
    const child = await connectAndHelloRaw(started.port);
    expect(child.received.find((message) => message.type === 'hello_ack')).toMatchObject({
      type: 'hello_ack',
      profile: { id: 'work', label: 'Work', state: 'current' },
    });
    child.ws.close();
    const countBeforeRefusals = store.list().length;
    expect(
      await ask(
        createCreateSessionRequest(dirs.work, { profile: 'quiet' }),
        'create_session_response',
      ),
    ).toMatchObject({
      success: false,
      error:
        'Profile quiet does not accept sessions from your devices. To allow them, add remote_selectable = true to [profiles.quiet] in config.toml on that machine.',
    });
    expect(
      await ask(createCreateSessionRequest(quietFolder), 'create_session_response'),
    ).toMatchObject({ success: false, error: expect.stringContaining('remote_selectable = true') });
    expect(store.list()).toHaveLength(countBeforeRefusals);
    fs.writeFileSync(`${output}.release`, '');
    await pollUntil(
      () =>
        store
          .list()
          .some((record) => record.remiSessionId === started.sessionId && record.exitedAt !== null),
      10000,
      'first profile child exit',
    );
    fs.rmSync(`${output}.release`);
    fs.rmSync(output);
    const resumed = await ask(
      createResumeSessionRequest(started.sessionId as string),
      'resume_session_response',
    );
    expect(resumed).toMatchObject({ success: true });
    if (!resumed || resumed.type !== 'resume_session_response' || !resumed.port)
      throw new Error('missing resumed child port');
    await pollUntil(() => fs.existsSync(output), 15000, 'resumed profile child');
    const invocations = fs
      .readFileSync(argumentsLog, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
    const children = invocations.filter((args) => args.includes('--daemon'));
    expect(children.at(-1)).not.toContain('--remi-profile');
    const resumedChild = await connectAndHelloRaw(resumed.port);
    expect(resumedChild.received.find((message) => message.type === 'hello_ack')).toMatchObject({
      profile: { id: 'work', label: 'Work', state: 'current' },
    });
    resumedChild.ws.close();
    const list = await ask(createSessionListRequest(true), 'session_list_response');
    if (!list || list.type !== 'session_list_response') throw new Error('missing list');
    expect(list.daemonPorts ?? []).not.toContain(hiddenPort);
    expect(
      list.sessions.some(
        (session) => session.sessionId === secretId || session.claudeSessionId === claudeId,
      ),
    ).toBe(false);
    const unknown = generateId();
    const hiddenLoad = await ask(createTranscriptLoadRequest(secretId), 'error');
    const unknownLoad = await ask(createTranscriptLoadRequest(unknown), 'error');
    expect(hiddenLoad).toMatchObject({
      code: 'NOT_FOUND',
      message: `Transcript for session ${secretId} not found`,
    });
    expect(unknownLoad).toMatchObject({
      code: 'NOT_FOUND',
      message: `Transcript for session ${unknown} not found`,
    });
    const hiddenResume = await ask(createResumeSessionRequest(secretId), 'resume_session_response');
    const unknownResume = await ask(createResumeSessionRequest(unknown), 'resume_session_response');
    expect(hiddenResume).toMatchObject({
      success: false,
      error: `Session ${secretId} not found. No Claude session ID available for resume.`,
    });
    expect(unknownResume).toMatchObject({
      success: false,
      error: `Session ${unknown} not found. No Claude session ID available for resume.`,
    });
    if (
      !hiddenResume ||
      hiddenResume.type !== 'resume_session_response' ||
      !unknownResume ||
      unknownResume.type !== 'resume_session_response'
    )
      throw new Error('missing resume response');
    expect('code' in hiddenResume).toBe(false);
    expect('code' in unknownResume).toBe(false);
    fs.rmSync(hidden, { recursive: true, force: true });
    expect(
      await ask(createResumeSessionRequest(secretId), 'resume_session_response'),
    ).toMatchObject({
      success: false,
      error: `Session ${secretId} not found. No Claude session ID available for resume.`,
    });
    fs.writeFileSync(path.join(remi, 'session-profiles.json'), '{');
    expect(
      await ask(createResumeSessionRequest(secretId), 'resume_session_response'),
    ).toMatchObject({
      success: false,
      error: `Session ${secretId} not found. No Claude session ID available for resume.`,
    });
    const damagedList = await ask(createSessionListRequest(true), 'session_list_response');
    if (!damagedList || damagedList.type !== 'session_list_response')
      throw new Error('missing list');
    expect(damagedList.daemonPorts ?? []).not.toContain(hiddenPort);
    expect(damagedList.sessions.some((session) => session.sessionId === secretId)).toBe(false);
    expect(await ask(createTranscriptLoadRequest(secretId), 'error')).toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(
      await ask(createRecentRepositoriesRequest(), 'recent_repositories_response'),
    ).toMatchObject({ repositories: [] });
    expect(await ask(createSessionHistoryRequest(), 'session_history_response')).toMatchObject({
      directories: [],
    });
    for (const forbidden of ['P2B-MARKER-HIDDEN', 'secret', 'Hidden label'])
      expect(client.raw.join('\n')).not.toContain(forbidden);
  } finally {
    client.ws.close();
    fs.writeFileSync(`${output}.release`, '');
    try {
      await pollUntil(
        () => store.list().every((record) => record.exitedAt !== null),
        10000,
        'profile child exit',
      );
    } finally {
      await cleanupHub(hub);
    }
  }
}, 60000);
