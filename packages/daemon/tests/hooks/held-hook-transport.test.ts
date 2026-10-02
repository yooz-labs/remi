/**
 * A held PermissionRequest over the real transport (#1126): the real
 * `HookServer` on port 0 with the real `AutoApproveGate` behind it, driven by
 * a real `fetch` the way Claude Code's http hook posts. The gate's outward
 * deps are recording sinks; the registry is real.
 *
 * Pins the two halves the hold model rests on: the phone's answer is the
 * HTTP response Claude receives, and Claude closing the held request (a No
 * or Esc answered in the terminal) dismisses the card.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { generateId } from '@remi/shared';
import type { QuestionOption, UUID } from '@remi/shared';
import { AutoApproveGate } from '../../src/auto-approve/auto-approve-gate.ts';
import { __resetLoggerForTests, configureLogger } from '../../src/cli/logger.ts';
import { HookServer } from '../../src/hooks/hook-server.ts';
import type { PTYSession } from '../../src/pty/pty-session.ts';
import { SessionRegistry } from '../../src/session/session-registry.ts';

const YES: QuestionOption = {
  label: 'Yes',
  value: '1',
  isRecommended: true,
  isYes: true,
  isNo: false,
};
const NO: QuestionOption = {
  label: 'No',
  value: '2',
  isRecommended: false,
  isYes: false,
  isNo: true,
};

describe('held PermissionRequest over the real HookServer (#1126)', () => {
  const SID = generateId() as UUID;
  let server: HookServer;
  let registry: SessionRegistry;
  let gate: AutoApproveGate;
  let ids: UUID[];
  let dismissed: UUID[];
  let writes: string[];

  beforeEach(() => {
    configureLogger({ writeLog: () => {} });
    registry = new SessionRegistry({ orphanTimeoutMs: 60_000 });
    ids = [];
    dismissed = [];
    writes = [];
    registry.registerSession(
      SID,
      '/d',
      {
        id: generateId(),
        isRunning: true,
        write: async (d: string) => {
          writes.push(d);
        },
        submitInput: async (d: string) => {
          writes.push(d);
        },
        close: async () => {},
      } as unknown as PTYSession,
      { handleMessage: () => {}, handleQuestion: () => {}, handleStatusChange: () => {} } as never,
    );
    gate = new AutoApproveGate(
      {
        sessionRegistry: registry,
        isInSubagentContext: () => false,
        holdMs: 60_000,
        escalate: () => {
          const id = generateId() as UUID;
          ids.push(id);
          registry.addQuestion(SID, {
            id,
            text: 'Allow Bash: touch x',
            options: [YES, NO],
            allowsFreeText: false,
            isAnswered: false,
          });
          return id;
        },
        onResolved: (qid) => {
          dismissed.push(qid);
        },
      },
      SID,
    );
    server = new HookServer({ port: 0 });
    server.setPermissionResolver((input, signal) => gate.resolvePermission(input, signal));
    server.start();
  });

  afterEach(async () => {
    server.stop();
    __resetLoggerForTests();
    await registry.shutdown();
  });

  function post(signal?: AbortSignal): Promise<Response> {
    return fetch(server.url, {
      method: 'POST',
      body: JSON.stringify({
        session_id: 'claude-x',
        transcript_path: '/tmp/t.jsonl',
        cwd: '/d',
        permission_mode: 'default',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'touch x' },
      }),
      ...(signal ? { signal } : {}),
    });
  }

  async function waitForHold(): Promise<UUID> {
    const deadline = Date.now() + 2000;
    while (ids.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const qid = ids[0];
    if (!qid) throw new Error('no hold registered');
    return qid;
  }

  test("the phone's answer is the HTTP response Claude receives", async () => {
    const res = post();
    const qid = await waitForHold();
    expect(gate.answerHeld(qid, { kind: 'option', option: NO, message: 'not now' })).toBe(
      'resolved',
    );
    expect(await (await res).json()).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'not now' },
      },
    });
    expect(writes).toEqual([]);
  });

  test('the deadline answers with the empty response, which decides nothing', async () => {
    gate = new AutoApproveGate(
      {
        sessionRegistry: registry,
        isInSubagentContext: () => false,
        holdMs: 30,
        escalate: () => {
          const id = generateId() as UUID;
          ids.push(id);
          return id;
        },
      },
      SID,
    );
    server.setPermissionResolver((input, signal) => gate.resolvePermission(input, signal));
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{}');
  });

  test('Claude closing the held request (No or Esc in the terminal) dismisses the card', async () => {
    const client = new AbortController();
    const res = post(client.signal).catch((err: unknown) => err);
    const qid = await waitForHold();
    expect(registry.getQuestion(SID, qid)).not.toBeNull();

    client.abort();
    expect(await res).toBeInstanceOf(Error);
    const deadline = Date.now() + 2000;
    while (dismissed.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(dismissed).toEqual([qid]);
    expect(registry.getQuestion(SID, qid)).toBeNull();
    expect(gate.hasOpenHookPrompt()).toBe(false);
    // A phone answer arriving after the close is refused, never typed.
    expect(gate.answerHeld(qid, { kind: 'option', option: YES })).toBe('closed');
    expect(writes).toEqual([]);
  });
});
