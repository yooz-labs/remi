import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ClaudeHarness } from '../../src/harness/claude.ts';
import { TranscriptDiscovery } from '../../src/transcript/transcript-discovery.ts';
import {
  downloadProtectionRoots,
  launchDownloadRoots,
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

test("a profile daemon's download roots protect the profile directories, not only the defaults", () => {
  const launch = {
    home: '/tmp/remi-test',
    userHome: '/tmp/user-test',
    harness: 'claude' as const,
    env: {},
  };
  const profile = { claude: { dir: '/tmp/profile-claude' }, codex: { dir: '/tmp/profile-codex' } };
  const protectedRoots = launchDownloadRoots({ ...launch, profile })('/tmp/work-test');
  expect(protectedRoots).toContainEqual({ pathname: '/tmp/profile-claude', required: true });
  expect(protectedRoots).toContainEqual({ pathname: '/tmp/profile-codex', required: true });
  // Without the profile those directories are not protected: this is what passing no profile loses.
  const unprotected = launchDownloadRoots({ ...launch, profile: undefined })('/tmp/work-test');
  expect(unprotected.map((root) => root.pathname)).not.toContain('/tmp/profile-claude');
  expect(unprotected.map((root) => root.pathname)).not.toContain('/tmp/profile-codex');
});

test("cli.ts builds the download host's roots from the daemon's selected profile", () => {
  const source = fs.readFileSync(path.join(import.meta.dir, '../../src/cli.ts'), 'utf8');
  const call = /rootsFor: launchDownloadRoots\(\{([^}]*)\}\)/.exec(source);
  expect(call, 'cli.ts builds rootsFor with launchDownloadRoots').not.toBeNull();
  expect(call?.[1]).toContain('profile: selectedProfile,');
  expect(call?.[1]).toContain('env: process.env,');
  expect(call?.[1]).toContain('configuredProfiles: currentProfiles,');
  // No second, hand-built route to the same roots.
  expect(source).not.toContain('profileDownloadProtectionRoots(');
});

test('cli uses the same profile status line launch helper at both sites', () => {
  const source = fs.readFileSync(path.join(import.meta.dir, '../../src/cli.ts'), 'utf8');
  expect(
    source.match(
      /installStatusLineForLaunch\(selectedProfile, REMI_DIR, isRemiHomeOverridden\(\)\)/g,
    ),
  ).toHaveLength(2);
  expect(source.match(/installStatusLine\(/g) ?? []).toHaveLength(0);
  expect(source).toContain('primaryProfile: profileMetadata?.profile,');
  expect(source).toContain('...(serveMode && {\n    profileRoots:');
});
