import { describe, expect, test } from 'bun:test';
import { generateId, now } from '@remi/shared';
import type { RecentDirectory, SessionProfilesResponseMessage } from '@remi/shared/protocol.ts';
import { renderToStaticMarkup } from 'react-dom/server';
import { NewSessionModal } from '../../src/components/session/NewSessionModal';
import { ProfilePicker } from '../../src/components/session/ProfilePicker';
import { createInitialProfileSheetState } from '../../src/lib/profile-sheet-state';
import type { ProfileLookupState } from '../../src/lib/profile-sheet-state';

function profilesResponse(
  overrides: Partial<SessionProfilesResponseMessage> = {},
): SessionProfilesResponseMessage {
  return {
    type: 'session_profiles_response',
    id: generateId(),
    timestamp: now(),
    requestId: generateId(),
    profiles: [
      { id: 'default', label: 'Default sign-in', harnesses: ['claude', 'codex'] },
      { id: 'work', label: 'Work', harnesses: ['claude'] },
      { id: 'codex-only', label: 'Codex only', harnesses: ['codex'] },
    ],
    default: { id: 'work', source: 'folder' },
    ...overrides,
  };
}

function readyLookup(
  response: SessionProfilesResponseMessage,
  directory = '/tmp/project',
): ProfileLookupState {
  return {
    status: 'ready',
    directory,
    requestId: response.requestId,
    connectionId: 'host:19200',
    response,
  };
}

const render = (
  response: SessionProfilesResponseMessage,
  selectedProfile: string | null = null,
  error: string | null = null,
  directory = '/tmp/project',
) =>
  renderToStaticMarkup(
    <ProfilePicker
      directory={directory}
      lookup={readyLookup(response, directory)}
      selectedProfile={selectedProfile}
      creating={false}
      error={error}
      onSelectProfile={() => {}}
      onStart={() => {}}
    />,
  );

describe('profile picker', () => {
  test('the sheet has no profile picker without the capability', () => {
    const directory: RecentDirectory = {
      directory: '/tmp/project',
      lastUsed: now(),
      sessionCount: 1,
      displayName: 'project',
    };
    const markup = renderToStaticMarkup(
      <NewSessionModal
        open
        directories={[directory]}
        onClose={() => {}}
        onStartSession={() => {}}
        profileState={createInitialProfileSheetState(true)}
      />,
    );
    expect(markup).not.toContain('Profile');
    expect(markup).toContain('Start session in project');
  });

  test('offers only Claude profiles and preselects the mapped profile with its reason', () => {
    const markup = render(profilesResponse());
    expect(markup).toContain('Directory: /tmp/project');
    expect(markup).toContain('<option value="default">Default sign-in</option>');
    expect(markup).toContain('<option value="work" selected="">Work</option>');
    expect(markup).not.toContain('Codex only');
    expect(markup).toContain('From this folder&#x27;s mapping');
    expect(markup).not.toMatch(/<button\b[^>]*disabled=""/);
  });

  test.each([
    ['folder', 'From this folder&#x27;s mapping'],
    ['machine_default', 'This machine&#x27;s default'],
    ['built_in', 'Built-in default sign-in'],
  ] as const)('shows the reason for source %s', (source, reason) => {
    const markup = render(profilesResponse({ default: { id: 'work', source } }));
    expect(markup).toContain(reason);
  });

  test('an unknown resolution source uses machine wording', () => {
    const markup = render(
      profilesResponse({ default: { id: 'work', source: 'future' as 'folder' } }),
    );
    expect(markup).toContain('This machine&#x27;s resolution');
  });

  test('without a default it asks the person to choose and disables Start', () => {
    const markup = render(profilesResponse({ default: undefined }));
    expect(markup).toContain(
      'This folder&#x27;s own profile does not accept sessions from your devices. Choose a profile.',
    );
    expect(markup).toContain('<option value="" disabled="" selected="">Choose a profile</option>');
    expect(markup).not.toContain('<option value="default" selected="">');
    expect(markup).toMatch(/<button\b[^>]*disabled=""/);
  });

  test.each([
    ['missing from the response', 'missing'],
    ['listed without Claude support', 'codex-only'],
  ] as const)('a default %s asks the person to choose', (_description, defaultId) => {
    const response = profilesResponse({ default: { id: defaultId, source: 'folder' } });
    const markup = render(response);
    expect(markup).toContain(
      'This folder&#x27;s profile cannot start a Claude session here. Choose a profile.',
    );
    if (defaultId === 'codex-only') expect(markup).not.toContain('Codex only');
    expect(markup).toMatch(/<button\b[^>]*disabled=""/);
  });

  test('a person can choose a Claude profile when the listed default is not offered', () => {
    const markup = render(
      profilesResponse({ default: { id: 'codex-only', source: 'folder' } }),
      'work',
    );
    expect(markup).toContain('<option value="work" selected="">Work</option>');
    expect(markup).toContain('Chosen by you');
    expect(markup).not.toMatch(/<button\b[^>]*disabled=""/);
  });

  test.each([
    ['directory_invalid', 'That folder is not a valid directory on this machine.'],
    [
      'profiles_invalid',
      'This machine&#x27;s profile settings have an error. Run remi profile ls on the machine.',
    ],
  ] as const)('renders the %s refusal and disables Start', (refused, text) => {
    const markup = render(profilesResponse({ profiles: [], default: undefined, refused }));
    expect(markup).toContain(text);
    expect(markup).toMatch(/<button\b[^>]*disabled=""/);
  });

  test('an unknown refusal displays the safe fallback and disables Start', () => {
    const markup = render(
      profilesResponse({
        profiles: [],
        default: undefined,
        refused: 'future_refusal' as SessionProfilesResponseMessage['refused'],
      }),
    );
    expect(markup).toContain('The machine refused this request.');
    expect(markup).toMatch(/<button\b[^>]*disabled=""/);
  });

  test('a failed lookup shows its text and keeps Start disabled', () => {
    const markup = renderToStaticMarkup(
      <ProfilePicker
        directory="/tmp/project"
        lookup={{
          status: 'failed',
          directory: '/tmp/project',
          message: 'The connection to this machine closed. Try again.',
        }}
        selectedProfile={null}
        creating={false}
        error={null}
        onSelectProfile={() => {}}
        onStart={() => {}}
      />,
    );
    expect(markup).toContain('The connection to this machine closed. Try again.');
    expect(markup).toMatch(/<button\b[^>]*disabled=""/);
  });

  test('Start stays disabled through a retry and is enabled only after a new lookup succeeds', () => {
    const failed = renderToStaticMarkup(
      <ProfilePicker
        directory="/tmp/project"
        lookup={{ status: 'failed', directory: '/tmp/project', message: 'Lookup failed.' }}
        selectedProfile={null}
        creating={false}
        error={null}
        onSelectProfile={() => {}}
        onStart={() => {}}
      />,
    );
    const loading = renderToStaticMarkup(
      <ProfilePicker
        directory="/tmp/project"
        lookup={{
          status: 'loading',
          directory: '/tmp/project',
          requestId: generateId(),
          connectionId: 'host:19200',
        }}
        selectedProfile={null}
        creating={false}
        error={null}
        onSelectProfile={() => {}}
        onStart={() => {}}
      />,
    );
    expect(failed).toMatch(/<button\b[^>]*disabled=""/);
    expect(loading).toMatch(/<button\b[^>]*disabled=""/);
    expect(render(profilesResponse())).not.toMatch(/<button\b[^>]*disabled=""/);
  });

  test('a create refusal stays visible with the chosen profile still selected', () => {
    const markup = render(profilesResponse(), 'work', 'Profile Work was refused.');
    expect(markup).toContain('<option value="work" selected="">Work</option>');
    expect(markup).toContain('Profile Work was refused.');
  });

  test('a changed selection shows that it was chosen by the person', () => {
    const markup = render(profilesResponse(), 'default');
    expect(markup).toContain('Chosen by you');
  });
});
