/**
 * ClaudeHarness (#1163): the Claude values behind the harness seam, each
 * compared with a literal written by hand so a change to the value fails here
 * instead of agreeing with itself.
 */

import { describe, expect, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import { ClaudeHarness, type Harness } from '../../src/harness/index.ts';
import { TranscriptDiscovery } from '../../src/transcript/transcript-discovery.ts';

const ID = '44444444-4444-4444-8444-444444444444';

describe('ClaudeHarness', () => {
  const projectsDir = path.join(os.tmpdir(), 'remi-claude-harness-projects');
  const harness: Harness = new ClaudeHarness(new TranscriptDiscovery({ projectsDir }));

  test('a graceful Stop types /exit', () => {
    expect(harness.gracefulExitInput).toBe('/exit');
  });

  test('resumeArgs is --resume followed by the session id', () => {
    expect(harness.resumeArgs(ID)).toEqual(['--resume', ID]);
  });

  test('resumeArgs returns a new array each call, so a caller may extend it', () => {
    const first = harness.resumeArgs(ID);
    first.push('--extra');
    expect(harness.resumeArgs(ID)).toEqual(['--resume', ID]);
  });

  test('transcriptPath is <projectsDir>/<project path, "/" -> "-">/<id>.jsonl', () => {
    expect(harness.transcriptPath('/Users/x/my.proj', ID)).toBe(
      `${projectsDir}/-Users-x-my.proj/${ID}.jsonl`,
    );
  });

  test('transcriptPath keeps dashes already in the project path (the encoding is lossy)', () => {
    // `/Users/my-project` and `/Users/my/project` collide on purpose: Claude
    // Code's own encoding is lossy, and the harness must reproduce it, not fix it.
    expect(harness.transcriptPath('/Users/my-project', ID)).toBe(
      harness.transcriptPath('/Users/my/project', ID),
    );
  });

  test('transcriptPath follows the projects directory the discovery was built with', () => {
    const other = path.join(os.tmpdir(), 'remi-claude-harness-other');
    const otherHarness = new ClaudeHarness(new TranscriptDiscovery({ projectsDir: other }));
    expect(otherHarness.transcriptPath('/a/b', ID)).toBe(`${other}/-a-b/${ID}.jsonl`);
  });
});
