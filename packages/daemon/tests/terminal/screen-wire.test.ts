/** Actual screen primitive -> strict codec/registry only; NOT a host/transport/client feature. */
import { expect, test } from 'bun:test';
import { deserialize, generateId, now, serialize } from '@remi/shared';
import { b64u } from '../../../shared/src/relay/bytes.ts';
import type { SessionTerminalSnapshot } from '../../../shared/src/terminal-view.ts';
import { BoundedScreen } from '../../src/terminal/screen.ts';

test('real screen redraw/alternate snapshots round-trip through the registered codec', async () => {
  const model = new BoundedScreen(20, 4);
  const viewId = b64u(crypto.getRandomValues(new Uint8Array(16)));
  const sessionId = generateId();
  let revision = 0;
  try {
    for (const [output, firstLine] of [
      ['old\r\x1b[2K界e\u0301', '界e\u0301'],
      ['\x1b[?1049h\x1b[Halternate', 'alternate'],
      ['\x1b[?1049l', '界e\u0301'],
    ]) {
      expect(model.observe(new TextEncoder().encode(output))).toBe(true);
      await model.whenIdle();
      const screen = model.snapshot();
      if (!screen) throw new Error('Owned screen unavailable');
      expect(screen.lines[0]).toBe(firstLine);
      const message: SessionTerminalSnapshot = {
        type: 'session_terminal_snapshot',
        id: generateId(),
        timestamp: now(),
        sessionId,
        requestId: generateId(),
        viewId,
        revision: revision++,
        ...screen,
      };
      expect(deserialize(serialize(message))).toEqual(message);
      expect(Object.isFrozen(screen.lines)).toBe(true);
    }
  } finally {
    model.retire();
  }
});
