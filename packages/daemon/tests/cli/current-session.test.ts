import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { UUID } from '@remi/shared';
import { makeCurrentSessionResolver } from '../../src/cli/current-session.ts';
import { SessionStore } from '../../src/session/session-store.ts';
import { TranscriptDiscovery } from '../../src/transcript/transcript-discovery.ts';

let tmpDir: string;
let projectsDir: string;
let sessionStore: SessionStore;
let transcriptDiscovery: TranscriptDiscovery;

const REMI = 'aaaaaaaa-0000-0000-0000-000000000000' as UUID;
const CLAUDE = '22222222-2222-2222-2222-222222222222';
const PROJECT = '/Users/test/project';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-current-session-'));
  projectsDir = path.join(tmpDir, 'claude-projects');
  fs.mkdirSync(projectsDir, { recursive: true });
  sessionStore = new SessionStore(path.join(tmpDir, 'sessions.json'));
  transcriptDiscovery = new TranscriptDiscovery({ projectsDir });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function resolver(primary: UUID | null) {
  return makeCurrentSessionResolver({
    getPrimarySessionId: () => primary,
    sessionStore,
    transcriptDiscovery,
  });
}

test('returns null when there is no primary session', () => {
  expect(resolver(null)()).toBeNull();
});

test('resolves claudeSessionId + transcriptPath from the stored binding', () => {
  sessionStore.save({
    remiSessionId: REMI,
    claudeSessionId: CLAUDE,
    projectPath: PROJECT,
    port: 18765,
    pid: 1,
    startedAt: new Date(0).toISOString(),
    exitedAt: null,
    exitCode: null,
  });

  const current = resolver(REMI)();
  expect(current).not.toBeNull();
  expect(current?.sessionId).toBe(REMI);
  expect(current?.claudeSessionId).toBe(CLAUDE as UUID);
  // <projectTranscriptDir>/<claudeSessionId>.jsonl, dirs encoded with '-'.
  expect(current?.transcriptPath).toBe(
    `${transcriptDiscovery.getProjectTranscriptDir(PROJECT)}/${CLAUDE}.jsonl`,
  );
});

test('claudeSessionId + transcriptPath are null when the binding is unbound', () => {
  sessionStore.save({
    remiSessionId: REMI,
    claudeSessionId: null,
    projectPath: PROJECT,
    port: 18765,
    pid: 1,
    startedAt: new Date(0).toISOString(),
    exitedAt: null,
    exitCode: null,
  });

  const current = resolver(REMI)();
  expect(current?.sessionId).toBe(REMI);
  expect(current?.claudeSessionId).toBeNull();
  expect(current?.transcriptPath).toBeNull();
});

test('claude id present but no stored record -> null binding (sessionId still returned)', () => {
  const current = resolver(REMI)();
  expect(current?.sessionId).toBe(REMI);
  expect(current?.claudeSessionId).toBeNull();
  expect(current?.transcriptPath).toBeNull();
});
