/** Real tracker subprocesses keep diagnostic capture separate from the sink. */
import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const trackerUrl = new URL('../../src/api/question-presence-tracker.ts', import.meta.url).href;
const sentinel = 'PRIVATE-TRACKER-QUESTION-SENTINEL';
const cases = [
  ['keep', 'Keeping richer pending permission_request'],
  ['replace', 'Replacing pending hook'],
  ['render', 'Marked question'],
  ['suppress', 'Orphan PTY prompt suppressed (gate owns this cycle)'],
  ['debounce', 'Orphan PTY prompt suppressed at debounce fire'],
] as const;

for (const [mode, operation] of cases) {
  test(`real tracker ${mode} preserves its behavior without logging private question text`, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-tracker-log-home-'));
    const program = `
      import { QuestionPresenceTracker } from ${JSON.stringify(trackerUrl)};
      const sentinel = ${JSON.stringify(sentinel)};
      const mode = ${JSON.stringify(mode)};
      const make = (suffix, source = 'permission_request') => ({
        id: crypto.randomUUID(), text: sentinel + suffix, options: [],
        allowsFreeText: false, isAnswered: false, source, agentId: 'probe-agent',
      });
      const first = make('-first');
      const next = make('-next');
      const pushed = [], rendered = [];
      const tracker = new QuestionPresenceTracker((q) => { pushed.push(q); }, { orphanDebounceMs: 20 });
      const check = (condition) => { if (!condition) throw new Error('Tracker behavior changed'); };
      if (mode === 'keep') {
        tracker.recordPendingHook(first);
        tracker.recordPendingHook(make('-generic', 'notification'));
        check(tracker.pushHeldHook(first.id));
        check(pushed.length === 1 && pushed[0].text === first.text);
      } else if (mode === 'replace') {
        tracker.recordPendingHook(first);
        tracker.recordPendingHook(next);
        check(tracker.pushHeldHook(next.id));
        check(pushed.length === 1 && pushed[0].text === next.text);
      } else if (mode === 'render') {
        tracker.parkAwaitingPTY(first, { onRender: (q) => rendered.push(q) });
        tracker.onOrphanPTYPrompt(next);
        check(rendered.length === 1 && rendered[0].text === first.text && pushed.length === 0);
      } else if (mode === 'suppress') {
        tracker.setHookPromptProbe(() => true);
        tracker.onOrphanPTYPrompt(first);
        check(pushed.length === 0);
      } else {
        tracker.onOrphanPTYPrompt(first);
        tracker.setHookPromptProbe(() => true);
        await Bun.sleep(80);
        check(pushed.length === 0);
      }
      tracker.clearPending();
      console.log('TRACKER-BEHAVIOR-CONFIRMED');
    `;
    const proc = Bun.spawn([process.execPath, '--eval', program], {
      env: { ...process.env, HOME: home, REMI_HOME: home },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    try {
      const [stdout, stderr, exit] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exit).toBe(0);
      expect(stderr).toBe('');
      expect(stdout).toContain('TRACKER-BEHAVIOR-CONFIRMED');
      expect(stdout).toContain(operation);
      expect(stdout).not.toContain(sentinel);
    } finally {
      if (proc.exitCode === null) {
        proc.kill('SIGKILL');
        await proc.exited;
      }
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}
