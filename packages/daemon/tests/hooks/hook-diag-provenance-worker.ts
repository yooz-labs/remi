/**
 * Worker for hook-diag-provenance.test.ts (#934).
 *
 * `os.homedir()` in Bun resolves once at process startup and does not track
 * a later mutation of `process.env.HOME` within the SAME process (verified;
 * mirrors the reasoning in `session/question-trace-worker.ts`) -- so the
 * only reliable way to point `HookServer`'s `~/.remi/hook-diag.jsonl` write
 * at a throwaway directory is a FRESH subprocess with `HOME` set in its
 * spawn env. This worker starts a real `HookServer`, POSTs one hook payload
 * at it exactly like `hook-server.test.ts` does, and exits; the parent test
 * reads the resulting file and asserts on it.
 */
import { HookServer } from '../../src/hooks/hook-server.ts';

const server = new HookServer({ port: 0 });
server.start();

const res = await fetch(`http://127.0.0.1:${server.port}/hooks`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    hook_event_name: 'Stop',
    session_id: 'test-session',
    transcript_path: '/tmp/test.jsonl',
    cwd: '/tmp',
    permission_mode: 'default',
  }),
});
if (res.status !== 200) {
  throw new Error(`worker POST failed: ${res.status}`);
}

server.stop();
