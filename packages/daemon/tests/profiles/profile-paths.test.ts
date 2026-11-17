import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ClaudeHarness } from '../../src/harness/claude.ts';
import { TranscriptDiscovery } from '../../src/transcript/transcript-discovery.ts';
import {
  downloadProtectionRoots,
  profileDownloadProtectionRoots,
} from '../../src/tunnel/file-download-session-host.ts';

test('profile transcript discovery excludes the default home project', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-transcript-'));
  try {
    const project = path.join(root, 'work');
    const profileProjects = path.join(root, 'profile', 'projects');
    const defaultProjects = path.join(root, 'home', '.claude', 'projects');
    const id = '77777777-7777-4777-8777-777777777777';
    const profile = new TranscriptDiscovery({ projectsDir: profileProjects });
    const standard = new TranscriptDiscovery({ projectsDir: defaultProjects });
    fs.mkdirSync(standard.getProjectTranscriptDir(project), { recursive: true });
    const synthetic = path.join(standard.getProjectTranscriptDir(project), `${id}.jsonl`);
    fs.writeFileSync(synthetic, `${JSON.stringify({ cwd: project })}\n`);
    expect(profile.findTranscriptBySessionId(id)).toBeNull();
    const expected = new ClaudeHarness(profile).transcriptPath(project, id);
    expect(expected).toBe(path.join(profileProjects, project.replace(/\//g, '-'), `${id}.jsonl`));
    fs.mkdirSync(path.dirname(expected), { recursive: true });
    fs.writeFileSync(expected, `${JSON.stringify({ cwd: project })}\n`);
    expect(profile.findTranscriptBySessionId(id)).toBe(expected);
    expect(profile.findTranscriptBySessionId(id)).not.toBe(synthetic);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('profile download roots select the profile or inherited environment', () => {
  const base = {
    home: '/tmp/remi-test',
    userHome: '/tmp/user-test',
    workingDirectory: '/tmp/work-test',
    harness: 'claude' as const,
  };
  const env = { CLAUDE_CONFIG_DIR: '/tmp/inherited-claude', CODEX_HOME: '/tmp/inherited-codex' };
  expect(profileDownloadProtectionRoots(base, undefined, env)).toEqual(
    downloadProtectionRoots({
      ...base,
      claudeConfigDirectory: env.CLAUDE_CONFIG_DIR,
      codexHome: env.CODEX_HOME,
    }),
  );
  const plain = downloadProtectionRoots(base);
  expect(plain).toContainEqual({ pathname: '/tmp/user-test/.claude', required: true });
  expect(plain).toContainEqual({ pathname: '/tmp/user-test/.codex', required: false });
  const profile = profileDownloadProtectionRoots(
    base,
    { claude: { dir: '/tmp/profile-claude' }, codex: { dir: '/tmp/profile-codex' } },
    env,
  );
  expect(profile).toContainEqual({ pathname: '/tmp/profile-claude', required: true });
  expect(profile).toContainEqual({ pathname: '/tmp/profile-codex', required: true });
});
