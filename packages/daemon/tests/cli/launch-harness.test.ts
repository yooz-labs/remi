import { expect, test } from 'bun:test';
import { DEFAULT_HARNESS, createCreateSessionRequest } from '@remi/shared';
import { parseArgs } from '../../src/cli/arg-parser';
import { isSessionLaunch, resolveLaunchHarness } from '../../src/cli/launch-harness';

const cases = [
  { args: [], config: 'claude', local: 'claude', remote: undefined },
  { args: [], config: 'codex', local: 'codex', remote: 'codex' },
  { args: ['new'], config: 'codex', local: 'codex', remote: 'codex' },
  { args: ['--daemon'], config: 'codex', local: 'codex', remote: 'codex' },
  { args: ['claude'], config: 'codex', local: 'claude', remote: 'claude' },
  { args: ['codex'], config: 'claude', local: 'codex', remote: 'codex' },
  { args: ['--harness', 'claude'], config: 'codex', local: 'claude', remote: 'claude' },
  { args: ['--harness', 'codex'], config: 'claude', local: 'codex', remote: 'codex' },
  { args: ['serve'], config: 'codex', local: 'claude', remote: undefined },
  { args: ['status'], config: 'codex', local: 'claude', remote: undefined },
  { args: ['--install'], config: 'codex', local: 'claude', remote: undefined },
  { args: ['--uninstall'], config: 'codex', local: 'claude', remote: undefined },
  { args: ['--sessions'], config: 'codex', local: 'claude', remote: undefined },
  { args: ['--harness', 'opencode'], config: 'codex', local: 'opencode', remote: 'opencode' },
] as const;

for (const scenario of cases) {
  test(`launch choice ${scenario.config}: ${scenario.args.join(' ') || 'plain remi'}`, () => {
    const parsed = parseArgs(scenario.args);
    expect(parsed.error).toBeUndefined();
    expect(resolveLaunchHarness(parsed, scenario.config)).toEqual({
      harnessId: scenario.local,
      remoteHarness: scenario.remote,
    });
  });
}

test('all four launch forms retain host, recent and directory routing', () => {
  for (const command of [[], ['new'], ['claude'], ['codex']]) {
    for (const flags of [['--host', 'host'], ['--recent'], ['--dir', '/owned/project']]) {
      expect(isSessionLaunch(parseArgs([...command, ...flags]))).toBe(true);
    }
  }
  expect(isSessionLaunch(parseArgs(['serve']))).toBe(false);
});

test('actual remote factory preserves legacy omission and explicit/configured selection', () => {
  for (const scenario of cases.slice(0, 8)) {
    const parsed = parseArgs([...scenario.args, '--host', 'host', '--', '--model', 'model']);
    const { remoteHarness } = resolveLaunchHarness(parsed, scenario.config);
    const message = createCreateSessionRequest('/owned/project', {
      harness: remoteHarness,
      args: parsed.explicitArgs,
    });
    expect(message.harness).toBe(scenario.remote);
    expect(message.args).toEqual(['--model', 'model']);
    if (scenario.remote === undefined) expect(Object.hasOwn(message, 'harness')).toBe(false);
  }
  expect(DEFAULT_HARNESS).toBe('claude');
});
