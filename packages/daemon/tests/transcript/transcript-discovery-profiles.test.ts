import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { __resetLoggerForTests, configureLogger } from '../../src/cli/logger.ts';
import { TranscriptDiscovery } from '../../src/transcript/transcript-discovery.ts';

test('discovers profile roots, with stable duplicate precedence and private paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-profiles-'));
  const primary = path.join(root, 'primary');
  const work = path.join(root, 'work');
  const home = path.join(root, 'home');
  const logs: string[] = [];
  configureLogger({ writeLog: (line) => logs.push(line) });
  function write(dir: string, id: string, seconds: number): string {
    const project = path.join(dir, '-project');
    fs.mkdirSync(project, { recursive: true });
    const file = path.join(project, `${id}.jsonl`);
    fs.writeFileSync(
      file,
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: id } })}\n`,
    );
    fs.utimesSync(file, seconds, seconds);
    return file;
  }
  try {
    const p = write(primary, 'primary-id', 10);
    write(work, 'work-id', 30);
    const h = write(home, 'home-id', 20);
    let roots = [{ profile: 'work', projectsDir: work }];
    const discovery = new TranscriptDiscovery({
      projectsDir: primary,
      profileRoots: () => roots,
      maxResults: 2,
    });
    expect(discovery.discoverSessions().map((s) => s.sessionId)).toEqual(['work-id', 'primary-id']);
    roots = [
      ...roots,
      { profile: 'home', projectsDir: home },
      { profile: 'missing', projectsDir: path.join(root, 'absent') },
    ];
    expect(discovery.discoverSessions().map((s) => s.sessionId)).toEqual(['work-id', 'home-id']);
    const all = new TranscriptDiscovery({ projectsDir: primary, profileRoots: () => roots });
    const sessions = all.discoverSessions();
    expect(sessions.map((s) => s.sessionId)).toEqual(['work-id', 'home-id', 'primary-id']);
    expect(sessions[0]).not.toHaveProperty('transcriptPath');
    expect(sessions[1]).not.toHaveProperty('transcriptPath');
    expect(sessions[2]?.transcriptPath).toBe(p);
    expect(all.profileOfTranscript('work-id')).toBe('work');
    expect(all.profileOfTranscript('home-id')).toBe('home');
    expect(all.profileOfTranscript('primary-id')).toBeUndefined();
    expect(all.findTranscriptBySessionId('home-id')).toBe(h);
    const solo = new TranscriptDiscovery({ projectsDir: primary, primaryProfile: 'solo' });
    expect(solo.profileOfTranscript('primary-id')).toBe('solo');
    expect(solo.discoverSessions()[0]).not.toHaveProperty('transcriptPath');
    write(work, 'primary-id', 40);
    const workWinner = write(work, 'shared-id', 1);
    write(home, 'shared-id', 50);
    logs.length = 0;
    const duplicates = all.discoverSessions();
    expect(duplicates.filter((s) => s.sessionId === 'primary-id')).toHaveLength(1);
    expect(duplicates.find((s) => s.sessionId === 'primary-id')?.transcriptPath).toBe(p);
    expect(duplicates.filter((s) => s.sessionId === 'shared-id')).toHaveLength(1);
    expect(logs).toHaveLength(2);
    expect(logs.join('\n')).toContain('primary-');
    expect(logs.join('\n')).toContain('shared-i');
    expect(logs.join('\n')).not.toContain(root);
    expect(all.profileOfTranscript('primary-id')).toBeUndefined();
    expect(all.findTranscriptBySessionId('shared-id')).toBe(workWinner);
    expect(all.profileOfTranscript('shared-id')).toBe('work');
    expect(logs).toHaveLength(2);
  } finally {
    __resetLoggerForTests();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('keeps both same-root duplicates and finds the newest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'same-root-'));
  try {
    const id = 'same-root-id';
    for (const folder of ['first', 'second']) {
      fs.mkdirSync(path.join(root, folder));
      const file = path.join(root, folder, `${id}.jsonl`);
      fs.writeFileSync(
        file,
        `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } })}\n`,
      );
    }
    const [older, newer] = fs.readdirSync(root);
    if (!older || !newer) throw new Error('missing fixture directories');
    fs.utimesSync(path.join(root, older, `${id}.jsonl`), 10, 10);
    fs.utimesSync(path.join(root, newer, `${id}.jsonl`), 20, 20);
    const discovery = new TranscriptDiscovery({ projectsDir: root });
    expect(discovery.findTranscriptBySessionId(id)).toBe(path.join(root, newer, `${id}.jsonl`));
    expect(discovery.discoverSessions().filter((s) => s.sessionId === id)).toHaveLength(2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
