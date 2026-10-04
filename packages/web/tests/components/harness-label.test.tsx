/**
 * The harness label on the session card and the chat header (#1179), rendered
 * with the real components to static markup.
 *
 * A Claude session, and a session whose daemon names no harness, shows what it
 * showed before harnesses existed: the markup is identical. A Codex session
 * differs by one label and nothing else.
 */

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { HarnessId } from '@remi/shared';
import { ChatHeader } from '../../src/components/chat/ChatHeader';
import { SessionCard } from '../../src/components/session/SessionCard';
import { harnessLabel } from '../../src/lib/session-display';
import type { ConnectionId, UISession } from '../../src/types';

const session = (harness?: HarnessId): UISession => ({
  id: '11111111-1111-4111-8111-111111111111' as UISession['id'],
  name: 'host/project/main',
  connectionId: 'host:18765' as ConnectionId,
  createdAt: '2026-10-04T00:00:00.000Z',
  lastActiveAt: '2026-10-04T00:00:00.000Z',
  status: 'idle',
  connectionStatus: 'connected',
  unreadCount: 0,
  ...(harness !== undefined && { harness }),
});

const card = (harness?: HarnessId): string =>
  renderToStaticMarkup(
    <SessionCard session={session(harness)} isActive={false} onClick={() => {}} />,
  );
const header = (harness?: HarnessId): string =>
  renderToStaticMarkup(<ChatHeader session={session(harness)} />);

/** The one label chip, which is all a Codex session may add. */
const CHIP = /<span class="[^"]*">Codex<\/span>/;

describe('harnessLabel', () => {
  test('names a harness other than Claude, and nothing for Claude or no harness', () => {
    expect(harnessLabel(undefined)).toBeNull();
    expect(harnessLabel('claude')).toBeNull();
    expect(harnessLabel('codex')).toBe('Codex');
    expect(harnessLabel('opencode')).toBe('OpenCode');
  });
});

describe.each([
  ['the session card', card],
  ['the chat header', header],
])('%s', (_name, render) => {
  test('a Codex session shows its label', () => {
    expect(render('codex')).toMatch(CHIP);
  });

  test('a Claude session, and one with no harness, is exactly what it was: no label, identical markup', () => {
    expect(render('claude')).toBe(render(undefined));
    expect(render(undefined)).not.toContain('Codex');
    expect(render(undefined)).not.toContain('Claude');
  });

  test('a Codex session differs from a Claude one by the label and nothing else', () => {
    expect(render('codex').replace(CHIP, '')).toBe(render('claude'));
  });
});
