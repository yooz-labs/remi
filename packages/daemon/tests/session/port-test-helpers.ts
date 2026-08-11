/**
 * Port selection for tests that exercise real TCP binding (#823, #848).
 *
 * The rule these exist to enforce: **never guess a port and then assert it is
 * free.** A test that picks `base = 44000 + random()` and asserts the probe
 * returns `base` is not testing the code, it is betting that nothing else on
 * the machine holds that port. On a developer laptop the bet wins; on a shared
 * CI runner it eventually loses, and the failure looks like a bug in the code
 * under test rather than in the test's setup.
 *
 * That bet cost a release: the flake blocked `auto-release` on `main` during
 * the 0.7.1 cut, and a red Test gate makes that job SKIP rather than fail, so a
 * missed release announces itself only as a tag that never appeared (#848).
 *
 * #823 fixed this for `port-utils.test.ts`; these helpers were extracted here
 * so `session-registry-file.test.ts` — which had been left on the old guessing
 * pattern — uses the same one implementation rather than a second copy that can
 * drift back.
 */

import * as net from 'node:net';
import { isPortAvailable } from '../../src/session/port-utils.ts';

/**
 * The host these helpers occupy on, and the host the tests using them must
 * probe with. A holder and a probe on DIFFERENT hosts do not answer the same
 * question -- that mismatch was #880 -- so it is one named constant here
 * rather than a `'0.0.0.0'` literal repeated at each call site.
 */
export const TEST_BIND_HOST = '0.0.0.0';

/** Bind to an OS-assigned port and report which one. Never collides. */
export function occupyEphemeral(host = TEST_BIND_HOST): Promise<{
  server: net.Server;
  port: number;
}> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    // biome-ignore lint/suspicious/noExplicitAny: Bun's net.Server type is incomplete
    (srv as any).on('error', reject);
    srv.listen({ port: 0, host, exclusive: true }, () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('no address assigned'));
        return;
      }
      resolve({ server: srv, port: addr.port });
    });
  });
}

/** Bind one specific port; rejects if it is taken (callers must have checked). */
export function occupyPort(port: number, host = TEST_BIND_HOST): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    // biome-ignore lint/suspicious/noExplicitAny: Bun's net.Server type is incomplete
    (srv as any).on('error', reject);
    srv.listen({ port, host, exclusive: true }, () => resolve(srv));
  });
}

/**
 * Find a base such that `[base, base + count)` are ALL free right now, by
 * probing each. Retries on a fresh random base when the run is contended.
 * Throws only if the machine is so busy that no run of `count` ports is free
 * across `attempts` tries, which is a genuine environment problem worth
 * failing loudly on rather than papering over.
 */
export async function reserveRange(count: number, attempts = 50): Promise<number> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const base = 45000 + Math.floor(Math.random() * 5000);
    let allFree = true;
    for (let i = 0; i < count; i++) {
      if (!(await isPortAvailable(base + i, TEST_BIND_HOST))) {
        allFree = false;
        break;
      }
    }
    if (allFree) return base;
  }
  throw new Error(`no free run of ${count} ports found after ${attempts} attempts`);
}
