import { describe, expect, test } from 'bun:test';
import {
  type Level2AssertionHolder,
  classifyForeignHolders,
} from '../../src/power/level2-foreign-holders.ts';

const REMI_PID = 4242;

function holder(overrides: Partial<Level2AssertionHolder>): Level2AssertionHolder {
  return {
    pid: 900,
    process: 'someapp',
    type: 'PreventUserIdleSystemSleep',
    name: 'Example assertion text',
    createdForPid: null,
    ...overrides,
  };
}

const POWERD_DISPLAY_ON = holder({
  pid: 120,
  process: 'powerd',
  type: 'PreventUserIdleSystemSleep',
  name: 'Prevent sleep while display is on',
});

describe('level 2 foreign-holder rule', () => {
  test("powerd's display-on assertion is exempt", () => {
    expect(classifyForeignHolders([POWERD_DISPLAY_ON], [REMI_PID], [])).toEqual({
      blocking: [],
      ignored: [],
    });
  });

  test.each([
    ['another name', { name: 'Prevent sleep while display is on (copy)' }, 'system'],
    ['another process', { process: 'powerdx' }, 'system'],
    ['another type', { type: 'PreventSystemSleep' }, 'system'],
    ['a display type', { type: 'PreventUserIdleDisplaySleep' }, 'display'],
  ] as const)('a near miss of the powerd exemption (%s) is not exempt', (_label, change, kind) => {
    const near = { ...POWERD_DISPLAY_ON, ...change };
    expect(classifyForeignHolders([near], [REMI_PID], []).blocking).toEqual([
      { process: near.process, kind },
    ]);
  });

  // One holder per case: a remi holder and a foreign one of the same process
  // name and kind would collapse into one entry and hide a broken rule.
  test("a holder created for a remi pid is remi's", () => {
    const caffeinateForRemi = holder({ pid: 5000, process: 'caffeinate', createdForPid: REMI_PID });
    expect(classifyForeignHolders([caffeinateForRemi], [REMI_PID], [])).toEqual({
      blocking: [],
      ignored: [],
    });
  });

  test('a holder created for another pid is foreign', () => {
    const caffeinateForOther = holder({ pid: 5001, process: 'caffeinate', createdForPid: 77 });
    expect(classifyForeignHolders([caffeinateForOther], [REMI_PID], [])).toEqual({
      blocking: [{ process: 'caffeinate', kind: 'system' }],
      ignored: [],
    });
  });

  test("a holder whose own pid is remi's is remi's", () => {
    const remiItself = holder({ pid: REMI_PID, process: 'bun', type: 'PreventSystemSleep' });
    expect(classifyForeignHolders([remiItself], new Set([REMI_PID]), [])).toEqual({
      blocking: [],
      ignored: [],
    });
  });

  test('a display holder in the ignore list still blocks', () => {
    const video = holder({ process: 'VideoApp', type: 'PreventUserIdleDisplaySleep' });
    const slides = holder({ pid: 901, process: 'Slides', type: 'NoDisplaySleepAssertion' });
    expect(classifyForeignHolders([video, slides], [], ['VideoApp', 'Slides'])).toEqual({
      blocking: [
        { process: 'VideoApp', kind: 'display' },
        { process: 'Slides', kind: 'display' },
      ],
      ignored: [],
    });
  });

  test('a system holder in the ignore list is ignored; matching is exact and case-sensitive', () => {
    const holders = [
      holder({ process: 'ChatApp', type: 'NoIdleSleepAssertion' }),
      holder({ pid: 902, process: 'screensharingd', type: 'PreventSystemSleep' }),
      holder({ pid: 903, process: 'chatapp', type: 'PreventUserIdleSystemSleep' }),
    ];
    expect(classifyForeignHolders(holders, [], ['ChatApp', 'screensharingd'])).toEqual({
      blocking: [{ process: 'chatapp', kind: 'system' }],
      ignored: [
        { process: 'ChatApp', kind: 'system' },
        { process: 'screensharingd', kind: 'system' },
      ],
    });
  });

  test('UserIsActive and kernel types are ignored', () => {
    const holders = [
      holder({ process: 'WindowServer', type: 'UserIsActive' }),
      holder({ pid: 0, process: 'kernel_task', type: 'ExternalMedia' }),
      holder({ pid: 0, process: 'kernel_task', type: 'ApplePushServiceTask' }),
    ];
    expect(classifyForeignHolders(holders, [], [])).toEqual({ blocking: [], ignored: [] });
  });

  test('one entry per process and kind', () => {
    const holders = [
      holder({ pid: 1, process: 'caffeinate' }),
      holder({ pid: 2, process: 'caffeinate' }),
      holder({ pid: 3, process: 'caffeinate', type: 'PreventUserIdleDisplaySleep' }),
    ];
    expect(classifyForeignHolders(holders, [], []).blocking).toEqual([
      { process: 'caffeinate', kind: 'system' },
      { process: 'caffeinate', kind: 'display' },
    ]);
  });

  test("the result never contains a holder's name", () => {
    const planted = 'Watching: Secret Document Title.mov';
    const holders = [
      holder({ process: 'VideoApp', type: 'PreventUserIdleDisplaySleep', name: planted }),
      holder({ pid: 2, process: 'Ignored', type: 'PreventSystemSleep', name: planted }),
    ];
    const result = classifyForeignHolders(holders, [], ['Ignored']);
    expect(JSON.stringify(result)).not.toContain(planted);
    for (const entry of [...result.blocking, ...result.ignored]) {
      expect(Object.keys(entry).sort()).toEqual(['kind', 'process']);
    }
  });
});
