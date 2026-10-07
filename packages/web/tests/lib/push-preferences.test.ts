/**
 * The notification toggles as the daemon is told about them (#968, #1153).
 *
 * The push path never consults the client, so a toggle only mutes anything
 * once it rides up on `register_device_token`; a setting with no field in
 * this mapping is a toggle that does nothing.
 */

import { describe, expect, test } from 'bun:test';
import { pushPreferencesEqual, pushPreferencesFromSettings } from '../../src/lib/push-preferences';
import { DEFAULT_SETTINGS } from '../../src/types';

describe('pushPreferencesFromSettings', () => {
  test('the defaults want every class, including failed turns (#1153)', () => {
    expect(pushPreferencesFromSettings(DEFAULT_SETTINGS)).toEqual({
      questions: true,
      turnComplete: true,
      harnessDenied: true,
      turnFailed: true,
    });
  });

  test('each toggle maps to exactly its own field', () => {
    expect(pushPreferencesFromSettings({ ...DEFAULT_SETTINGS, notifyTurnFailed: false })).toEqual({
      questions: true,
      turnComplete: true,
      harnessDenied: true,
      turnFailed: false,
    });
    expect(pushPreferencesFromSettings({ ...DEFAULT_SETTINGS, notifyTurnComplete: false })).toEqual({
      questions: true,
      turnComplete: false,
      harnessDenied: true,
      turnFailed: true,
    });
    expect(pushPreferencesFromSettings({ ...DEFAULT_SETTINGS, notifyQuestions: false })).toEqual({
      questions: false,
      turnComplete: true,
      harnessDenied: true,
      turnFailed: true,
    });
    expect(pushPreferencesFromSettings({ ...DEFAULT_SETTINGS, notifyHarnessDenied: false })).toEqual({
      questions: true,
      turnComplete: true,
      harnessDenied: false,
      turnFailed: true,
    });
  });

  test('muting "Turn complete" does not mute failed turns: they are independent toggles', () => {
    const prefs = pushPreferencesFromSettings({ ...DEFAULT_SETTINGS, notifyTurnComplete: false });
    expect(prefs.turnComplete).toBe(false);
    expect(prefs.turnFailed).toBe(true);
  });
});

describe('pushPreferencesEqual', () => {
  test('equal preferences are equal', () => {
    expect(
      pushPreferencesEqual(
        pushPreferencesFromSettings(DEFAULT_SETTINGS),
        pushPreferencesFromSettings(DEFAULT_SETTINGS),
      ),
    ).toBe(true);
  });

  test('a change to any single field, including turnFailed, is a difference worth re-registering', () => {
    const base = pushPreferencesFromSettings(DEFAULT_SETTINGS);
    for (const key of [
      'notifyQuestions',
      'notifyTurnComplete',
      'notifyHarnessDenied',
      'notifyTurnFailed',
    ] as const) {
      const changed = pushPreferencesFromSettings({ ...DEFAULT_SETTINGS, [key]: false });
      expect(pushPreferencesEqual(base, changed)).toBe(false);
    }
  });
});
