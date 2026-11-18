import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createSessionListRequest,
  createTranscriptLoadRequest,
  serialize,
} from '@remi/shared/protocol.ts';
import { SessionStore } from '../../src/session/session-store.ts';
import { cleanupHub, makeIsolatedDirs, pollUntil, spawnHub } from './hub-test-utils.ts';
import { connectAndHelloRaw } from './profile-frame-helpers.ts';

test('hub discovers and loads both profile transcripts without exposing profile paths', async () => {
  const dirs = makeIsolatedDirs();
  const remi = path.join(dirs.home, '.remi');
  const adopted = path.join(dirs.home, 'P2A-MARKER-DIR');
  const local = path.join(remi, 'p', 'home', 'claude');
  fs.mkdirSync(remi, { recursive: true });
  fs.writeFileSync(
    path.join(remi, 'config.toml'),
    `[profiles.work]\nlabel="Work"\n[profiles.work.claude]\nexpects="subscription"\ndir=${JSON.stringify(adopted)}\n[profiles.home]\nlabel="Home"\n[profiles.home.claude]\nexpects="subscription"\n`,
  );
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
  for (const [index, dir] of [adopted, local].entries()) {
    const project = path.join(dir, 'projects', dirs.work.replace(/\//g, '-'));
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(
      path.join(project, `${ids[index]}.jsonl`),
      `${JSON.stringify({ type: 'user', uuid: `u${index}`, sessionId: ids[index], timestamp: new Date().toISOString(), message: { role: 'user', content: `CONTENT-${index}` } })}\n`,
    );
  }
  const remiId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  new SessionStore(path.join(remi, 'sessions.json')).save({
    remiSessionId: remiId,
    claudeSessionId: ids[0] as string,
    projectPath: dirs.work,
    profile: 'work',
    port: 0,
    pid: null,
    startedAt: new Date().toISOString(),
    exitedAt: new Date().toISOString(),
    exitCode: 0,
  });
  const hub = await spawnHub(dirs, { PATH: '/opt/homebrew/bin:/usr/bin:/bin' });
  const { ws, received, raw } = await connectAndHelloRaw(hub.port);
  try {
    const list = createSessionListRequest(true);
    ws.send(serialize(list));
    await pollUntil(
      () => received.some((m) => m.type === 'session_list_response' && m.requestId === list.id),
      10000,
      'profile list',
    );
    const response = received.find(
      (m) => m.type === 'session_list_response' && m.requestId === list.id,
    );
    if (response?.type !== 'session_list_response') throw new Error('missing list');
    for (const [id, marker] of [
      [ids[0], 'CONTENT-0'],
      [ids[1], 'CONTENT-1'],
      [remiId, 'CONTENT-0'],
    ] as const) {
      const previous = raw.length;
      const request = createTranscriptLoadRequest(id as string);
      ws.send(serialize(request));
      await pollUntil(
        () =>
          received.some((m) => m.type === 'transcript_load_complete' && m.requestId === request.id),
        10000,
        'profile transcript',
      );
      const frames = raw.slice(previous).join('\n');
      expect(frames).toContain(marker);
      expect(frames).not.toContain(marker === 'CONTENT-0' ? 'CONTENT-1' : 'CONTENT-0');
    }
    for (const id of ids) {
      const entry = response.sessions.find((s) => s.sessionId === id);
      expect(entry).toBeDefined();
      expect(entry).not.toHaveProperty('transcriptPath');
    }
    expect(raw.join('\n')).not.toContain('P2A-MARKER-DIR');
    expect(raw.join('\n')).not.toContain(remi);
  } finally {
    ws.close();
    await cleanupHub(hub);
  }
}, 30000);
