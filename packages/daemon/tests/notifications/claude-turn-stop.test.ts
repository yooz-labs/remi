/**
 * Claude's way into the turn-event sink (#1180 review rework): the `Stop` hook handler that
 * `cli.ts` registers as `onTurnStop`. It was a function inside `cli.ts`, which only source pins
 * could reach, so the hand-off to the sink was weakly pinned: the elapsed time, the unbound
 * session's title, the re-entry flag and the order of the #914 session filter against the timer
 * were all mutants that survived. It is now `createClaudeTurnStop`, built with what it needs.
 *
 * Everything here is real: the handler, the REAL `TurnTimer` (with a clock a test moves), and the
 * REAL sink, whose gates, text and fan-out decide what is pushed. The doubles are the #914
 * filter's answer (what the harness says; its own tests are `harness/claude-session.test.ts`) and
 * the network (a recording `send`).
 */

import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { UUID } from '@remi/shared';
import type { DeviceTokenEntry } from '../../src/cli/handlers/trivial-events.ts';
import type { StopHookInput } from '../../src/hooks/hook-types.ts';
import { createClaudeTurnStop } from '../../src/notifications/claude-turn-stop.ts';
import type { PushTriggerOptions } from '../../src/notifications/push-client.ts';
import { DEFAULT_PUSH_PREFERENCES } from '../../src/notifications/push-preferences.ts';
import { createTurnEventSink } from '../../src/notifications/turn-events.ts';
import { TurnTimer } from '../../src/notifications/turn-timer.ts';

const SID = 's0000000-0000-0000-0000-000000000000' as UUID;
const PROMPT = 'prompt-1';

interface Sent {
  token: string;
  opts: PushTriggerOptions;
}

function rig(over: { admits?: (input: StopHookInput) => boolean; primary?: UUID | null } = {}) {
  let now = 1_000_000;
  const timer = new TurnTimer({ nowMs: () => now });
  const sent: Sent[] = [];
  const admitted: StopHookInput[] = [];
  const names = new Map<UUID, string>([[SID, 'my-project']]);
  let primary: UUID | null = over.primary === undefined ? SID : over.primary;
  const device: DeviceTokenEntry = {
    token: 'device-a',
    platform: 'ios',
    registeredAt: 1,
    connectionId: 'c0000000-0000-0000-0000-000000000000' as UUID,
    pushPrefs: DEFAULT_PUSH_PREFERENCES,
  };
  const sink = createTurnEventSink({
    config: () => ({ onTurnComplete: true, turnCompleteMinSeconds: 60 }),
    deviceTokens: () => [device],
    sessionName: (id) => names.get(id),
    notifiers: new Map(),
    signalingUrl: () => 'https://signal.test',
    pushSecret: () => 'owned-test-secret',
    legacyPolicy: () => ({ legacyEnabled: true }),
    send: (_url, token, opts) => {
      sent.push({ token, opts });
      return Promise.resolve();
    },
    log: () => {},
    onError: () => {},
  });
  const stop = createClaudeTurnStop({
    admits: (input) => {
      admitted.push(input);
      return over.admits === undefined ? true : over.admits(input);
    },
    timer,
    primarySessionId: () => primary,
    sink,
  });
  const input = (o: Partial<StopHookInput> = {}): StopHookInput => ({
    session_id: 'claude-session',
    transcript_path: '/t.jsonl',
    cwd: '/work',
    permission_mode: 'default',
    hook_event_name: 'Stop',
    stop_hook_active: false,
    prompt_id: PROMPT,
    last_assistant_message: 'All done, the tests pass.',
    ...o,
  });
  return {
    stop,
    timer,
    sent,
    admitted,
    input,
    advance: (ms: number) => {
      now += ms;
    },
    setPrimary: (id: UUID | null) => {
      primary = id;
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('createClaudeTurnStop', () => {
  test('the elapsed time of the turn reaches the gate: a long turn pushes, a short one does not', async () => {
    const long = rig();
    long.timer.observe(PROMPT);
    long.advance(120_000);
    long.stop(long.input());
    await flush();
    expect(long.sent).toHaveLength(1);
    expect(long.sent[0]?.opts.kind).toBe('turn_complete');

    const short = rig();
    short.timer.observe(PROMPT);
    short.advance(30_000);
    short.stop(short.input());
    await flush();
    expect(short.sent).toEqual([]);
  });

  test('a turn the timer never saw is of unknown length and fails toward silence', async () => {
    const r = rig();
    r.stop(r.input());
    await flush();

    expect(r.sent).toEqual([]);
  });

  test("the push is titled with the primary session's name, and with Agent while no session is primary", async () => {
    const bound = rig();
    bound.timer.observe(PROMPT);
    bound.advance(120_000);
    bound.stop(bound.input());

    const unbound = rig({ primary: null });
    unbound.timer.observe(PROMPT);
    unbound.advance(120_000);
    unbound.stop(unbound.input());
    await flush();

    expect(bound.sent[0]?.opts.title).toBe('my-project: turn complete');
    expect(unbound.sent[0]?.opts.title).toBe('Agent: turn complete');
  });

  test('the primary session is asked when the Stop arrives, not when the handler is built', async () => {
    const r = rig({ primary: null });
    r.timer.observe(PROMPT);
    r.advance(120_000);
    r.stop(r.input());
    await flush();
    expect(r.sent[0]?.opts.title).toBe('Agent: turn complete');

    r.setPrimary(SID);
    r.timer.observe(PROMPT);
    r.advance(120_000);
    r.stop(r.input());
    await flush();
    expect(r.sent[1]?.opts.title).toBe('my-project: turn complete');
  });

  test("the hook's last message is the push body", async () => {
    const r = rig();
    r.timer.observe(PROMPT);
    r.advance(120_000);
    r.stop(r.input({ last_assistant_message: 'The migration finished.' }));
    await flush();

    expect(r.sent[0]?.opts.body).toBe('The migration finished.');
  });

  test('a turn the #914 filter does not claim is a sibling’s: nothing is pushed, and its timer mark is left alone', async () => {
    const r = rig({ admits: () => false });
    r.timer.observe(PROMPT);
    r.advance(120_000);

    r.stop(r.input());
    await flush();

    expect(r.sent).toEqual([]);
    // The filter ran first: a sibling's Stop neither read nor cleared this session's mark.
    expect(r.timer.size).toBe(1);
    expect(r.timer.elapsedMs(PROMPT)).toBe(120_000);
  });

  test('the filter is asked about the very hook input, before anything else is read', () => {
    const r = rig({ admits: () => false });
    const input = r.input({ session_id: 'a-siblings-claude-id' });

    r.stop(input);

    expect(r.admitted).toEqual([input]);
  });

  test('a finished turn clears its mark; a re-entry does not, and notifies nobody', async () => {
    const r = rig();
    r.timer.observe(PROMPT);
    r.advance(100_000);

    r.stop(r.input({ stop_hook_active: true }));
    await flush();
    expect(r.sent).toEqual([]);
    expect(r.timer.size).toBe(1);

    // The real Stop still measures the turn from its first-seen time.
    r.advance(20_000);
    r.stop(r.input());
    await flush();
    expect(r.sent).toHaveLength(1);
    expect(r.timer.size).toBe(0);
  });

  test('a mark is cleared whether or not the turn was long enough to push', async () => {
    const r = rig();
    r.timer.observe(PROMPT);
    r.advance(5_000);

    r.stop(r.input());
    await flush();

    expect(r.sent).toEqual([]);
    expect(r.timer.elapsedMs(PROMPT)).toBeUndefined();
  });

  test('a Stop with no prompt id has no turn to measure and pushes nothing', async () => {
    const r = rig();
    r.advance(120_000);
    const { prompt_id: _promptId, ...withoutPrompt } = r.input();
    r.stop(withoutPrompt);
    await flush();

    expect(r.sent).toEqual([]);
  });
});

describe('createClaudeTurnStop (source order)', () => {
  const SRC = fs.readFileSync(
    path.join(import.meta.dir, '..', '..', 'src', 'notifications', 'claude-turn-stop.ts'),
    'utf8',
  );

  test('the #914 session filter is an early return that comes before the timer is read or cleared', () => {
    const body = SRC.slice(SRC.indexOf('return (input'));
    const filtered = body.indexOf('if (!deps.admits(input)) return;');
    const read = body.indexOf('deps.timer.elapsedMs(');
    const cleared = body.indexOf('deps.timer.clear(');
    expect(filtered).toBeGreaterThanOrEqual(0);
    expect(read).toBeGreaterThan(filtered);
    expect(cleared).toBeGreaterThan(read);
  });
});
