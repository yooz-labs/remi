/** Actual elapsed lease control; no clock injection or provider process. */
import assert from 'node:assert/strict';
import { terminalServiceFixture } from '../packages/daemon/tests/helpers/terminal-service-fixture.ts';

const fixture = await terminalServiceFixture();
try {
  const peer = await fixture.client();
  const opened = await peer.submit(peer.open());
  assert(opened.type === 'session_terminal_opened');
  const records = Reflect.get(fixture.service, 'records') as Map<object, { until: number }>;
  const connection = peer.connection();
  assert(connection);
  const record = records.get(connection);
  assert(record);
  const started = record.until - 300000;
  await Bun.sleep(Math.max(0, record.until - performance.now() + 50));
  const elapsed = performance.now() - started;
  assert(elapsed >= 300000, 'five actual monotonic minutes elapsed');
  const result = await peer.submit(peer.read(opened.viewId));
  assert(result.type === 'session_terminal_refused');
  assert(result.code === 'expired' || result.code === 'unavailable');
  const fresh = await peer.submit(peer.open());
  assert(fresh.type === 'session_terminal_opened' && fresh.viewId !== opened.viewId);
  console.log(
    JSON.stringify({
      status: 'passed',
      version: Bun.version,
      revision: Bun.revision,
      elapsedMonotonicMs: elapsed,
      oldViewOutcome: result.code,
      explicitOpenCreatedFreshView: true,
      scope:
        'real five-minute source signed-WSS lease; no compiled/service-resource or hardware acceptance',
    }),
  );
} finally {
  await fixture.close();
}
