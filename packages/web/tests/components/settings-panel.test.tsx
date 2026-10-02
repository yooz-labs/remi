/**
 * Render test for the notification toggles in the settings panel (#1153),
 * with the real component rendered to static markup.
 */

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SettingsPanel } from '../../src/components/settings/SettingsPanel';
import { DEFAULT_SETTINGS } from '../../src/types';
import type { AppSettings } from '../../src/types';

function render(settings: AppSettings): string {
  return renderToStaticMarkup(
    <SettingsPanel open settings={settings} onClose={() => {}} onChange={() => {}} />,
  );
}

/** The `aria-checked` state of the switch in the toggle row labeled `label`,
 *  or null when there is no such row. */
function toggleState(html: string, label: string): 'true' | 'false' | null {
  for (const row of html.split('<label').slice(1)) {
    if (row.includes(`>${label}</span>`)) {
      const match = row.match(/aria-checked="(true|false)"/);
      return match ? (match[1] as 'true' | 'false') : null;
    }
  }
  return null;
}

describe('SettingsPanel notification toggles (#1153)', () => {
  test('shows a "Failed turns" toggle, on by default', () => {
    expect(toggleState(render(DEFAULT_SETTINGS), 'Failed turns')).toBe('true');
  });

  test('reflects notifyTurnFailed = false as an off toggle', () => {
    expect(toggleState(render({ ...DEFAULT_SETTINGS, notifyTurnFailed: false }), 'Failed turns')).toBe(
      'false',
    );
  });

  test('is independent of "Turn complete": muting that one leaves failed turns on', () => {
    const html = render({ ...DEFAULT_SETTINGS, notifyTurnComplete: false });
    expect(toggleState(html, 'Turn complete')).toBe('false');
    expect(toggleState(html, 'Failed turns')).toBe('true');
  });

  test('the other notification toggles are still there', () => {
    const html = render(DEFAULT_SETTINGS);
    for (const label of ['Question alerts', 'Turn complete', 'Auto mode blocks']) {
      expect(toggleState(html, label)).toBe('true');
    }
  });
});
