import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatHeader } from '../../src/components/chat/ChatHeader';
import { SessionCard } from '../../src/components/session/SessionCard';
import type { ConnectionId, UISession } from '../../src/types';

const baseSession = (overrides: Partial<UISession> = {}): UISession => ({
  id: '11111111-1111-4111-8111-111111111111' as UISession['id'],
  name: 'host/project/main',
  connectionId: 'host:19200' as ConnectionId,
  createdAt: '2026-10-04T00:00:00.000Z',
  lastActiveAt: '2026-10-04T00:00:00.000Z',
  status: 'idle',
  connectionStatus: 'connected',
  unreadCount: 0,
  ...overrides,
});

const card = (session: UISession) =>
  renderToStaticMarkup(<SessionCard session={session} isActive={false} onClick={() => {}} />);
const header = (session: UISession) => renderToStaticMarkup(<ChatHeader session={session} />);

describe('profile badge', () => {
  test('a profile ref does not change either component without the capability', () => {
    const withoutProfile = baseSession();
    const withProfile = baseSession({ profile: { id: 'work', label: 'Work' } });
    expect(card(withProfile)).toBe(card(withoutProfile));
    expect(header(withProfile)).toBe(header(withoutProfile));
  });

  test('the card stays quiet for a default-only machine while the chat header names the default', () => {
    const session = baseSession({ sessionProfilesEnabled: true, sharesProfiles: false });
    expect(card(session)).not.toContain('Default sign-in');
    expect(header(session)).toContain('Default sign-in');
  });

  test('a shared profile is labeled on the card and chat header with an accessible name', () => {
    const session = baseSession({
      profile: { id: 'work', label: 'Work' },
      sessionProfilesEnabled: true,
      sharesProfiles: true,
    });
    for (const markup of [card(session), header(session)]) {
      expect(markup).toContain('>Work</span>');
      expect(markup).toContain('aria-label="Profile Work"');
    }
  });

  test('a shared default session says Default sign-in on the card', () => {
    const session = baseSession({ sessionProfilesEnabled: true, sharesProfiles: true });
    expect(card(session)).toContain('>Default sign-in</span>');
    expect(card(session)).toContain('aria-label="Profile Default sign-in"');
  });

  test('a removed profile has a removed label and accessible name', () => {
    const session = baseSession({
      profile: { id: 'work', label: 'Work', state: 'removed' },
      sessionProfilesEnabled: true,
      sharesProfiles: true,
    });
    for (const markup of [card(session), header(session)]) {
      expect(markup).toContain('>Work (removed)</span>');
      expect(markup).toContain('aria-label="Profile Work, removed"');
    }
  });

  test('changed settings are explained in the chat header', () => {
    const session = baseSession({
      profile: { id: 'work', label: 'Work', state: 'changed' },
      sessionProfilesEnabled: true,
      sharesProfiles: true,
    });
    expect(header(session)).toContain(
      "This profile&#x27;s settings changed after the session started; the session keeps the settings it started with",
    );
  });

  test('an unknown profile state keeps its label and adds no note', () => {
    const session = baseSession({
      profile: { id: 'work', label: 'Work', state: 'future' as 'current' },
      sessionProfilesEnabled: true,
      sharesProfiles: true,
    });
    expect(header(session)).toContain('>Work</span>');
    expect(header(session)).not.toContain('settings changed');
  });
});
