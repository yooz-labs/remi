import { describe, expect, test } from 'bun:test';
import { parseThread, parseThreadStatus } from '../../../src/harness/codex/thread-protocol.ts';
import { fixtureFrameAt, placeholderUuid } from '../../helpers/codex-fixtures.ts';

type Json = Record<string, unknown>;

/** The `thread` of a real `thread/started` frame (`expB.jsonl:7` is the TUI's, `:12` the title helper's). */
function realThread(line: 7 | 12): Json {
  const params = fixtureFrameAt('expB.jsonl', line).frame['params'] as { thread: Json };
  return JSON.parse(JSON.stringify(params.thread)) as Json;
}

describe('parseThread', () => {
  test('reads the TUI thread of the real spike frame', () => {
    expect(parseThread(realThread(7))).toEqual({
      id: placeholderUuid(9),
      cwd: '/work/project',
      ephemeral: false,
      createdAtSec: 1700000000,
      parentThreadId: null,
      threadSource: 'user',
      path: '/work/codex-home/sessions/rollout-T3.jsonl',
      environmentCount: 1,
      status: { type: 'idle' },
    });
  });

  test('reads the title helper of the real spike frame: ephemeral, no environments, no path', () => {
    expect(parseThread(realThread(12))).toMatchObject({
      id: placeholderUuid(10),
      ephemeral: true,
      threadSource: 'thread_title',
      environmentCount: 0,
      path: null,
    });
  });

  test('a thread whose `ephemeral` is missing or not a boolean reads as ephemeral (fail closed)', () => {
    for (const ephemeral of [null, 0, 'false', {}]) {
      expect(parseThread({ ...realThread(7), ephemeral })?.ephemeral, String(ephemeral)).toBe(true);
    }
    const { ephemeral: _omitted, ...withoutFlag } = realThread(7);
    expect(parseThread(withoutFlag)?.ephemeral).toBe(true);
    expect(parseThread({ ...realThread(7), ephemeral: false })?.ephemeral).toBe(false);
  });

  test('an id that is not a UUID is not a thread: it is stored and printed in a command line (R3)', () => {
    const hostile = [
      'x; rm -rf ~',
      '$(id)',
      'a',
      ' ',
      '00000000-0000-7000-8000-00000000000g',
      `${placeholderUuid(7)}\n`,
      `${placeholderUuid(7)} && id`,
      placeholderUuid(7).slice(1),
    ];
    for (const id of hostile) {
      expect(parseThread({ ...realThread(7), id }), JSON.stringify(id)).toBeNull();
    }
    // The shape is what counts, not the letter case.
    const upper = placeholderUuid(7).toUpperCase();
    expect(parseThread({ ...realThread(7), id: upper })?.id).toBe(upper);
  });

  test('it is null unless the value is an object with a non-empty string id', () => {
    for (const value of [null, undefined, 'x', 7, [], [realThread(7)], {}, { id: '' }, { id: 5 }]) {
      expect(parseThread(value), JSON.stringify(value)).toBeNull();
    }
  });

  test('a parentThreadId that is neither a string nor null makes the frame unusable', () => {
    expect(parseThread({ ...realThread(7), parentThreadId: 5 })).toBeNull();
    expect(parseThread({ ...realThread(7), parentThreadId: {} })).toBeNull();
    expect(parseThread({ ...realThread(7), parentThreadId: 'parent-1' })?.parentThreadId).toBe(
      'parent-1',
    );
    const { parentThreadId: _omitted, ...withoutParent } = realThread(7);
    expect(parseThread(withoutParent)?.parentThreadId).toBeNull();
  });

  test('missing or mistyped optional fields become null or zero, never a throw', () => {
    expect(
      parseThread({
        id: placeholderUuid(3),
        cwd: 5,
        createdAt: 'now',
        path: 7,
        threadSource: [],
        environments: 3,
      }),
    ).toEqual({
      id: placeholderUuid(3),
      cwd: null,
      ephemeral: true,
      createdAtSec: null,
      parentThreadId: null,
      threadSource: null,
      path: null,
      environmentCount: 0,
      status: null,
    });
    const id = placeholderUuid(3);
    expect(parseThread({ id, createdAt: Number.NaN })?.createdAtSec).toBeNull();
    expect(parseThread({ id, createdAt: Number.POSITIVE_INFINITY })?.createdAtSec).toBeNull();
  });
});

describe('parseThreadStatus', () => {
  test('the three flat statuses and an active one with its flags', () => {
    expect(parseThreadStatus({ type: 'notLoaded' })).toEqual({ type: 'notLoaded' });
    expect(parseThreadStatus({ type: 'idle' })).toEqual({ type: 'idle' });
    expect(parseThreadStatus({ type: 'systemError' })).toEqual({ type: 'systemError' });
    expect(parseThreadStatus({ type: 'active', activeFlags: [] })).toEqual({
      type: 'active',
      activeFlags: [],
    });
    expect(parseThreadStatus({ type: 'active', activeFlags: ['waitingOnApproval'] })).toEqual({
      type: 'active',
      activeFlags: ['waitingOnApproval'],
    });
  });

  test('an unknown flag is kept, because it still means the thread waits on someone', () => {
    expect(
      parseThreadStatus({ type: 'active', activeFlags: ['waitingOnApproval', 'someNewFlag', 5] }),
    ).toEqual({ type: 'active', activeFlags: ['waitingOnApproval', 'someNewFlag'] });
  });

  test('an active status with no usable flag list has no flags', () => {
    expect(parseThreadStatus({ type: 'active' })).toEqual({ type: 'active', activeFlags: [] });
    expect(parseThreadStatus({ type: 'active', activeFlags: 'waitingOnApproval' })).toEqual({
      type: 'active',
      activeFlags: [],
    });
  });

  test('the status of the real spike frames', () => {
    const status = (line: number): unknown =>
      (fixtureFrameAt('expB.jsonl', line).frame['params'] as Json)['status'];
    expect(parseThreadStatus(status(8))).toEqual({ type: 'active', activeFlags: [] });
    expect(parseThreadStatus(status(68))).toEqual({ type: 'idle' });
    expect(parseThreadStatus(status(70))).toEqual({ type: 'notLoaded' });
  });

  test('an unknown type, a missing type and a non-object are null', () => {
    for (const value of [{ type: 'paused' }, { type: 5 }, {}, null, undefined, 'idle', [], 3]) {
      expect(parseThreadStatus(value), JSON.stringify(value)).toBeNull();
    }
  });
});
