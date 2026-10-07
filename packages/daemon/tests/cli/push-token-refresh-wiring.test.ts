/**
 * Source pins (#1259 review): every push path in `cli.ts` reads the shared
 * device-token store fresh, so a mute or an expired lease recorded by a sibling
 * daemon (#1258, #1254) applies to it; and the store knows which tokens have a
 * live connection here, so a connected phone never expires. The repo pins
 * `cli.ts` wiring by its source (as `claude-session.test.ts` does).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const cli = readFileSync(join(import.meta.dir, '../../src/cli.ts'), 'utf8');

function between(start: string, end: string): string {
  const from = cli.indexOf(start);
  expect(from).toBeGreaterThanOrEqual(0);
  const to = cli.indexOf(end, from + start.length);
  expect(to).toBeGreaterThan(from);
  return cli.slice(from, to);
}

describe('cli.ts reads the device tokens fresh on every push path (#1259 review)', () => {
  test('the turn-event sink (turn_complete, turn_failed) refreshes before it reads', () => {
    const sink = between('createTurnEventSink({', '\n});');
    expect(sink).toMatch(/deviceTokens: \(\) => \{\s*deviceTokenStore\.refreshFromDisk\(\);/);
  });

  test('the subagent alert refreshes before it reads', () => {
    const alert = between(
      'log(`[SubagentAlert] ${title} - ${body}`);',
      'for (const dt of deviceTokens.values())',
    );
    expect(alert).toContain('deviceTokenStore.refreshFromDisk();');
  });

  test('the foreign-session escalator is handed the refresh', () => {
    const escalator = between('new ForeignSessionEscalator({', '\n});');
    expect(escalator).toContain('refreshDeviceTokens: () => deviceTokenStore.refreshFromDisk()');
  });

  test('the store is told which tokens have a live connection here', () => {
    const store = between('const deviceTokenStore = new DeviceTokenStore(', '});');
    expect(store).toContain('isLive:');
  });
});
