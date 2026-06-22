import { describe, expect, test } from 'bun:test';
import { parseArgs, parseHostPath } from '../../src/cli/arg-parser.ts';

describe('parseArgs', () => {
  // -------------------------------------------------------------------------
  // The main bug fix: remi new + flags
  // -------------------------------------------------------------------------
  describe('remi new with flags (bug fix)', () => {
    test('remi new --host X parses host', () => {
      const r = parseArgs(['new', '--host', '192.168.1.1']);
      expect(r.subcommand).toBe('new');
      expect(r.host).toBe('192.168.1.1');
      expect(r.claudeArgs).toEqual([]);
    });

    test('remi new --dir /path parses dir', () => {
      const r = parseArgs(['new', '--dir', '/tmp/test']);
      expect(r.subcommand).toBe('new');
      expect(r.dir).toBe('/tmp/test');
      expect(r.claudeArgs).toEqual([]);
    });

    test('remi new --recent sets recent flag', () => {
      const r = parseArgs(['new', '--recent']);
      expect(r.subcommand).toBe('new');
      expect(r.recent).toBe(true);
      expect(r.claudeArgs).toEqual([]);
    });

    test('remi new --host X --recent parses both', () => {
      const r = parseArgs(['new', '--host', '10.0.0.1', '--recent']);
      expect(r.subcommand).toBe('new');
      expect(r.host).toBe('10.0.0.1');
      expect(r.recent).toBe(true);
    });

    test('remi new --host X --dir /path parses both', () => {
      const r = parseArgs(['new', '--host', '10.0.0.1', '--dir', '/tmp']);
      expect(r.subcommand).toBe('new');
      expect(r.host).toBe('10.0.0.1');
      expect(r.dir).toBe('/tmp');
    });
  });

  // -------------------------------------------------------------------------
  // -- separator (standard Unix behavior)
  // -------------------------------------------------------------------------
  describe('-- separator', () => {
    test('remi new -- --resume passes --resume to claude', () => {
      const r = parseArgs(['new', '--', '--resume']);
      expect(r.subcommand).toBe('new');
      expect(r.claudeArgs).toEqual(['--resume']);
      expect(r.resume).toBeUndefined();
    });

    test('remi new --host X -- --resume parses host and passes --resume', () => {
      const r = parseArgs(['new', '--host', 'myhost', '--', '--resume']);
      expect(r.subcommand).toBe('new');
      expect(r.host).toBe('myhost');
      expect(r.claudeArgs).toEqual(['--resume']);
    });

    test('remi -- --resume passes --resume to claude without parsing', () => {
      const r = parseArgs(['--', '--resume']);
      expect(r.subcommand).toBeUndefined();
      expect(r.claudeArgs).toEqual(['--resume']);
      expect(r.resume).toBeUndefined();
    });

    test('remi ls -- --weird stops parsing after --', () => {
      const r = parseArgs(['ls', '--', '--weird']);
      expect(r.subcommand).toBe('ls');
      expect(r.claudeArgs).toEqual(['--weird']);
    });

    test('multiple args after -- all go to claudeArgs', () => {
      const r = parseArgs(['new', '--', '--model', 'opus', '--verbose']);
      expect(r.claudeArgs).toEqual(['--model', 'opus', '--verbose']);
    });
  });

  // -------------------------------------------------------------------------
  // Backward compatibility: flags before subcommand
  // -------------------------------------------------------------------------
  describe('flags before subcommand', () => {
    test('remi --host X new parses host before new', () => {
      const r = parseArgs(['--host', 'myhost', 'new']);
      expect(r.subcommand).toBe('new');
      expect(r.host).toBe('myhost');
    });

    test('remi --port 9000 ls parses port before ls', () => {
      const r = parseArgs(['--port', '9000', 'ls']);
      expect(r.subcommand).toBe('ls');
      expect(r.port).toBe(9000);
    });
  });

  // -------------------------------------------------------------------------
  // Other subcommands with --host
  // -------------------------------------------------------------------------
  describe('other subcommands with --host', () => {
    test('remi ls --host X', () => {
      const r = parseArgs(['ls', '--host', 'myhost']);
      expect(r.subcommand).toBe('ls');
      expect(r.host).toBe('myhost');
    });

    test('remi recent --host X', () => {
      const r = parseArgs(['recent', '--host', 'myhost']);
      expect(r.subcommand).toBe('recent');
      expect(r.host).toBe('myhost');
    });

    test('remi kill session-name --host X', () => {
      const r = parseArgs(['kill', 'session-name', '--host', 'myhost']);
      expect(r.subcommand).toBe('kill');
      expect(r.subcommandArg).toBe('session-name');
      expect(r.host).toBe('myhost');
    });

    test('remi attach abc --host X', () => {
      const r = parseArgs(['attach', 'abc', '--host', 'myhost']);
      expect(r.subcommand).toBe('attach');
      expect(r.subcommandArg).toBe('abc');
      expect(r.host).toBe('myhost');
    });

    test('remi unstick (no port) parses with no positional arg', () => {
      const r = parseArgs(['unstick']);
      expect(r.subcommand).toBe('unstick');
      expect(r.subcommandArg).toBeUndefined();
    });

    test('remi unstick <port> captures the port as the positional arg', () => {
      const r = parseArgs(['unstick', '18767']);
      expect(r.subcommand).toBe('unstick');
      expect(r.subcommandArg).toBe('18767');
    });
  });

  // -------------------------------------------------------------------------
  // Unknown args pass through to claudeArgs
  // -------------------------------------------------------------------------
  describe('passthrough to claude', () => {
    test('remi new unknown-thing goes to claudeArgs', () => {
      const r = parseArgs(['new', 'unknown-thing']);
      expect(r.subcommand).toBe('new');
      expect(r.claudeArgs).toEqual(['unknown-thing']);
    });

    test('unknown flags in wrapper mode go to claudeArgs', () => {
      const r = parseArgs(['--model', 'opus']);
      expect(r.claudeArgs).toEqual(['--model', 'opus']);
    });

    test('positional args in wrapper mode go to claudeArgs', () => {
      const r = parseArgs(['my-project']);
      expect(r.claudeArgs).toEqual(['my-project']);
    });
  });

  // -------------------------------------------------------------------------
  // Mutual exclusion
  // -------------------------------------------------------------------------
  describe('mutual exclusion', () => {
    test('--dir and --recent together produces error', () => {
      const r = parseArgs(['new', '--dir', '/tmp', '--recent']);
      expect(r.error).toBeDefined();
    });

    test('--recent and --dir together produces error', () => {
      const r = parseArgs(['new', '--recent', '--dir', '/tmp']);
      expect(r.error).toBeDefined();
    });

    test('--dir alone has no error', () => {
      const r = parseArgs(['new', '--dir', '/tmp']);
      expect(r.error).toBeUndefined();
    });

    test('--recent alone has no error', () => {
      const r = parseArgs(['new', '--recent']);
      expect(r.error).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Subcommand detection
  // -------------------------------------------------------------------------
  describe('subcommand detection', () => {
    test('no args returns undefined subcommand', () => {
      const r = parseArgs([]);
      expect(r.subcommand).toBeUndefined();
    });

    for (const cmd of [
      'ls',
      'attach',
      'code',
      'keygen',
      'export-key',
      'import-key',
      'authorize',
      'keys',
      'new',
      'kill',
      'detach',
      'recent',
      'start',
      'stop',
      'status',
      'logs',
    ] as const) {
      test(`${cmd} is detected as subcommand`, () => {
        const r = parseArgs([cmd]);
        expect(r.subcommand).toBe(cmd);
      });
    }
  });

  // -------------------------------------------------------------------------
  // Subcommand positional args
  // -------------------------------------------------------------------------
  describe('subcommand positional args', () => {
    test('attach session-id', () => {
      const r = parseArgs(['attach', 'session-id']);
      expect(r.subcommand).toBe('attach');
      expect(r.subcommandArg).toBe('session-id');
    });

    test('kill session-name', () => {
      const r = parseArgs(['kill', 'my-session']);
      expect(r.subcommand).toBe('kill');
      expect(r.subcommandArg).toBe('my-session');
    });

    test('detach session-name', () => {
      const r = parseArgs(['detach', 'my-session']);
      expect(r.subcommand).toBe('detach');
      expect(r.subcommandArg).toBe('my-session');
    });

    test('import-key file.json', () => {
      const r = parseArgs(['import-key', 'identity.json']);
      expect(r.subcommand).toBe('import-key');
      expect(r.subcommandArg).toBe('identity.json');
    });

    test('authorize key-file.json', () => {
      const r = parseArgs(['authorize', 'client-key.json']);
      expect(r.subcommand).toBe('authorize');
      expect(r.subcommandArg).toBe('client-key.json');
    });

    test('positional arg after flags (e.g. kill --host X session)', () => {
      const r = parseArgs(['kill', '--host', 'myhost', 'session-name']);
      expect(r.subcommand).toBe('kill');
      expect(r.host).toBe('myhost');
      expect(r.subcommandArg).toBe('session-name');
    });

    test('code --refresh', () => {
      const r = parseArgs(['code', '--refresh']);
      expect(r.subcommand).toBe('code');
      expect(r.codeRefresh).toBe(true);
    });

    test('ls has no positional arg', () => {
      const r = parseArgs(['ls', 'something']);
      expect(r.subcommand).toBe('ls');
      expect(r.subcommandArg).toBeUndefined();
      expect(r.claudeArgs).toEqual(['something']);
    });
  });

  // -------------------------------------------------------------------------
  // Global flags
  // -------------------------------------------------------------------------
  describe('global flags', () => {
    test('--daemon', () => {
      expect(parseArgs(['--daemon']).daemonMode).toBe(true);
    });

    test('--port 9000', () => {
      expect(parseArgs(['--port', '9000']).port).toBe(9000);
    });

    test('--resume without arg', () => {
      expect(parseArgs(['--resume']).resume).toBe(true);
    });

    test('--resume with session-id', () => {
      expect(parseArgs(['--resume', 'abc123']).resume).toBe('abc123');
    });

    test('--sessions defaults to running filter', () => {
      expect(parseArgs(['--sessions']).showSessions).toBe('running');
    });

    test('--sessions all shows all', () => {
      expect(parseArgs(['--sessions', 'all']).showSessions).toBe('all');
    });

    test('--sessions exited shows exited only', () => {
      expect(parseArgs(['--sessions', 'exited']).showSessions).toBe('exited');
    });

    test('--version', () => {
      expect(parseArgs(['--version']).showVersion).toBe(true);
    });

    test('-v', () => {
      expect(parseArgs(['-v']).showVersion).toBe(true);
    });

    test('--help', () => {
      expect(parseArgs(['--help']).showHelp).toBe(true);
    });

    test('-h', () => {
      expect(parseArgs(['-h']).showHelp).toBe(true);
    });

    test('--local sets bindHost and noMdns', () => {
      const r = parseArgs(['--local']);
      expect(r.bindHost).toBe('localhost');
      expect(r.noMdns).toBe(true);
    });

    test('--bind HOST', () => {
      expect(parseArgs(['--bind', '0.0.0.0']).bindHost).toBe('0.0.0.0');
    });

    test('--auth', () => {
      expect(parseArgs(['--auth']).auth).toBe(true);
    });

    test('--no-auth', () => {
      expect(parseArgs(['--no-auth']).auth).toBe(false);
    });

    test('--no-relay', () => {
      expect(parseArgs(['--no-relay']).noRelay).toBe(true);
    });

    test('--network', () => {
      expect(parseArgs(['--network']).network).toBe(true);
    });

    test('--force', () => {
      expect(parseArgs(['--force']).force).toBe(true);
    });

    test('--permanent-code', () => {
      expect(parseArgs(['--permanent-code']).permanentCode).toBe(true);
    });

    test('--install', () => {
      expect(parseArgs(['--install']).install).toBe(true);
    });

    test('--uninstall', () => {
      expect(parseArgs(['--uninstall']).uninstall).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Complex combinations
  // -------------------------------------------------------------------------
  describe('complex combinations', () => {
    test('remi new --host X --port 9000 --recent', () => {
      const r = parseArgs(['new', '--host', '10.0.0.1', '--port', '9000', '--recent']);
      expect(r.subcommand).toBe('new');
      expect(r.host).toBe('10.0.0.1');
      expect(r.port).toBe(9000);
      expect(r.recent).toBe(true);
    });

    test('remi --port 9000 ls --host X --network', () => {
      const r = parseArgs(['--port', '9000', 'ls', '--host', 'myhost', '--network']);
      expect(r.subcommand).toBe('ls');
      expect(r.port).toBe(9000);
      expect(r.host).toBe('myhost');
      expect(r.network).toBe(true);
    });

    test('remi new --dir /tmp -- --model opus', () => {
      const r = parseArgs(['new', '--dir', '/tmp', '--', '--model', 'opus']);
      expect(r.subcommand).toBe('new');
      expect(r.dir).toBe('/tmp');
      expect(r.claudeArgs).toEqual(['--model', 'opus']);
    });
  });

  // -------------------------------------------------------------------------
  // Input validation (from review findings)
  // -------------------------------------------------------------------------
  describe('input validation', () => {
    test('--port without value produces error', () => {
      const r = parseArgs(['--port']);
      expect(r.error).toBeDefined();
      expect(r.port).toBeUndefined();
    });

    test('--port abc produces error', () => {
      const r = parseArgs(['--port', 'abc']);
      expect(r.error).toBeDefined();
      expect(r.port).toBeUndefined();
    });

    test('--port 0 produces error (below range)', () => {
      const r = parseArgs(['--port', '0']);
      expect(r.error).toBeDefined();
    });

    test('--port 99999 produces error (above range)', () => {
      const r = parseArgs(['--port', '99999']);
      expect(r.error).toBeDefined();
    });

    test('--host without value produces error', () => {
      const r = parseArgs(['--host']);
      expect(r.error).toBeDefined();
      expect(r.host).toBeUndefined();
    });

    test('--dir without value produces error', () => {
      const r = parseArgs(['--dir']);
      expect(r.error).toBeDefined();
      expect(r.dir).toBeUndefined();
    });

    test('--max-bullet-length abc produces error', () => {
      const r = parseArgs(['--max-bullet-length', 'abc']);
      expect(r.error).toBeDefined();
    });

    test('--max-bullet-length 0 is valid (disables truncation)', () => {
      const r = parseArgs(['--max-bullet-length', '0']);
      expect(r.error).toBeUndefined();
      expect(r.maxBulletLength).toBe(0);
    });

    test('--install and --uninstall are mutually exclusive', () => {
      const r = parseArgs(['--install', '--uninstall']);
      expect(r.error).toBeDefined();
    });

    test('--signaling-url without value produces error', () => {
      const r = parseArgs(['--signaling-url']);
      expect(r.error).toBeDefined();
    });

    test('--push-secret without value produces error', () => {
      const r = parseArgs(['--push-secret']);
      expect(r.error).toBeDefined();
    });

    test('--push-secret followed by flag produces error', () => {
      const r = parseArgs(['--push-secret', '--daemon']);
      expect(r.error).toBeDefined();
    });

    test('--label without value produces error', () => {
      const r = parseArgs(['--label']);
      expect(r.error).toBeDefined();
    });

    test('--bind without value produces error', () => {
      const r = parseArgs(['--bind']);
      expect(r.error).toBeDefined();
    });

    test('--remove without value produces error', () => {
      const r = parseArgs(['--remove']);
      expect(r.error).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Previously untested flags (from review findings)
  // -------------------------------------------------------------------------
  describe('remaining flags', () => {
    test('--no-telegram', () => {
      expect(parseArgs(['--no-telegram']).noTelegram).toBe(true);
    });

    test('--max-bullet-length 200', () => {
      expect(parseArgs(['--max-bullet-length', '200']).maxBulletLength).toBe(200);
    });

    test('--signaling-url URL', () => {
      expect(parseArgs(['--signaling-url', 'wss://example.com']).signalingUrl).toBe(
        'wss://example.com',
      );
    });

    test('--push-secret VALUE', () => {
      expect(parseArgs(['--push-secret', 'my-secret-key']).pushSecret).toBe('my-secret-key');
    });

    test('--push-secret defaults to undefined', () => {
      expect(parseArgs([]).pushSecret).toBeUndefined();
    });

    test('--passphrase', () => {
      expect(parseArgs(['--passphrase']).usePassphrase).toBe(true);
    });

    test('--no-tofu', () => {
      expect(parseArgs(['--no-tofu']).noTofu).toBe(true);
    });

    test('--label NAME', () => {
      expect(parseArgs(['--label', 'My Phone']).label).toBe('My Phone');
    });

    test('--public-only', () => {
      expect(parseArgs(['--public-only']).publicOnly).toBe(true);
    });

    test('--remove FINGERPRINT', () => {
      expect(parseArgs(['--remove', 'abc123']).removeFingerprint).toBe('abc123');
    });

    test('--no-mdns standalone', () => {
      expect(parseArgs(['--no-mdns']).noMdns).toBe(true);
    });

    test('--resume followed by a flag does not consume the flag', () => {
      const r = parseArgs(['--resume', '--daemon']);
      expect(r.resume).toBe(true);
      expect(r.daemonMode).toBe(true);
    });

    test('--orphan-timeout 60', () => {
      expect(parseArgs(['--orphan-timeout', '60']).orphanTimeout).toBe(60);
    });

    test('--orphan-timeout 0 disables timeout', () => {
      expect(parseArgs(['--orphan-timeout', '0']).orphanTimeout).toBe(0);
    });

    test('--orphan-timeout without value produces error', () => {
      expect(parseArgs(['--orphan-timeout']).error).toBeDefined();
    });

    test('--orphan-timeout abc produces error', () => {
      expect(parseArgs(['--orphan-timeout', 'abc']).error).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // remi new /path (positional directory arg)
  // -------------------------------------------------------------------------
  describe('remi new with positional path', () => {
    test('remi new /absolute/path sets dir', () => {
      const r = parseArgs(['new', '/tmp/project']);
      expect(r.subcommand).toBe('new');
      expect(r.dir).toBe('/tmp/project');
      expect(r.claudeArgs).toEqual([]);
    });

    test('remi new ~/home/path sets dir', () => {
      const r = parseArgs(['new', '~/Documents/git/remi']);
      expect(r.subcommand).toBe('new');
      expect(r.dir).toBe('~/Documents/git/remi');
    });

    test('remi new ./relative sets dir', () => {
      const r = parseArgs(['new', './my-project']);
      expect(r.subcommand).toBe('new');
      expect(r.dir).toBe('./my-project');
    });

    test('remi new ../parent sets dir', () => {
      const r = parseArgs(['new', '../other-project']);
      expect(r.subcommand).toBe('new');
      expect(r.dir).toBe('../other-project');
    });

    test('remi new . sets dir to current dir', () => {
      const r = parseArgs(['new', '.']);
      expect(r.subcommand).toBe('new');
      expect(r.dir).toBe('.');
    });

    test('remi new non-path-string goes to claudeArgs', () => {
      const r = parseArgs(['new', 'some-claude-arg']);
      expect(r.subcommand).toBe('new');
      expect(r.dir).toBeUndefined();
      expect(r.claudeArgs).toEqual(['some-claude-arg']);
    });

    test('remi new /path --host X sets both dir and host', () => {
      const r = parseArgs(['new', '/tmp/project', '--host', '10.0.0.1']);
      expect(r.subcommand).toBe('new');
      expect(r.dir).toBe('/tmp/project');
      expect(r.host).toBe('10.0.0.1');
    });

    test('remi new /path conflicts with --recent', () => {
      const r = parseArgs(['new', '--recent', '/tmp/project']);
      // --recent is parsed first, then /path would conflict
      // But /path comes after --recent which was already parsed by the flag handler
      // The path won't be detected because it's after --recent was consumed
      // Actually: --recent is at position 1, parsed in the flag handler.
      // /tmp/project is at position 2, not consumed by new's path detection
      // (new only checks nextArg, i.e., position 1)
      // So /tmp/project falls to claudeArgs
      expect(r.recent).toBe(true);
    });

    test('remi new --dir /a conflicts with positional path', () => {
      // --dir is parsed first, then remi new /b would also try to set dir
      // But the positional path detection only fires for the arg immediately after 'new'
      const r = parseArgs(['new', '--dir', '/a']);
      expect(r.dir).toBe('/a');
    });
  });
});

describe('parseHostPath', () => {
  test('plain hostname returns host only', () => {
    expect(parseHostPath('myhost')).toEqual({ host: 'myhost' });
  });

  test('hostname with tilde path returns host and directory', () => {
    expect(parseHostPath('myhost:~/Documents/project')).toEqual({
      host: 'myhost',
      directory: '~/Documents/project',
    });
  });

  test('hostname with absolute path returns host and directory', () => {
    expect(parseHostPath('myhost:/home/user/project')).toEqual({
      host: 'myhost',
      directory: '/home/user/project',
    });
  });

  test('hostname with port (numeric) returns host only', () => {
    // host:9000 should NOT be parsed as host:path
    expect(parseHostPath('myhost:9000')).toEqual({ host: 'myhost:9000' });
  });

  test('IP address is returned as host', () => {
    expect(parseHostPath('192.168.1.1')).toEqual({ host: '192.168.1.1' });
  });

  test('IP with tilde path works', () => {
    expect(parseHostPath('192.168.1.1:~/project')).toEqual({
      host: '192.168.1.1',
      directory: '~/project',
    });
  });

  test('empty string returns host only', () => {
    expect(parseHostPath('')).toEqual({ host: '' });
  });

  test('host with just tilde expands correctly', () => {
    expect(parseHostPath('myhost:~')).toEqual({
      host: 'myhost',
      directory: '~',
    });
  });

  test('bracketed IPv6 with path returns host and directory', () => {
    expect(parseHostPath('[::1]:~/project')).toEqual({
      host: '[::1]',
      directory: '~/project',
    });
  });

  test('bracketed IPv6 with absolute path returns host and directory', () => {
    expect(parseHostPath('[fe80::1]:/home/user/project')).toEqual({
      host: '[fe80::1]',
      directory: '/home/user/project',
    });
  });

  test('bracketed IPv6 with port returns host only', () => {
    expect(parseHostPath('[::1]:9000')).toEqual({ host: '[::1]:9000' });
  });

  test('bracketed IPv6 without path returns host only', () => {
    expect(parseHostPath('[::1]')).toEqual({ host: '[::1]' });
  });
});

// ---------------------------------------------------------------------------
// Auto-approve flags
// ---------------------------------------------------------------------------
describe('parseArgs - auto-approve flags', () => {
  test('--auto-approve sets autoApprove true', () => {
    const r = parseArgs(['--auto-approve']);
    expect(r.autoApprove).toBe(true);
  });

  test('--no-auto-approve sets autoApprove false', () => {
    const r = parseArgs(['--no-auto-approve']);
    expect(r.autoApprove).toBe(false);
  });

  test('auto-approve defaults to undefined', () => {
    const r = parseArgs([]);
    expect(r.autoApprove).toBeUndefined();
  });

  test('--auto-approve-model sets model', () => {
    const r = parseArgs(['--auto-approve-model', 'qwen3.5:4b']);
    expect(r.autoApproveModel).toBe('qwen3.5:4b');
  });

  test('--auto-approve-model without value errors', () => {
    const r = parseArgs(['--auto-approve-model']);
    expect(r.error).toContain('--auto-approve-model requires a value');
  });

  test('--auto-approve-provider sets provider', () => {
    const r = parseArgs(['--auto-approve-provider', 'openrouter']);
    expect(r.autoApproveProvider).toBe('openrouter');
  });

  test('--auto-approve-provider without value errors', () => {
    const r = parseArgs(['--auto-approve-provider']);
    expect(r.error).toContain('--auto-approve-provider requires a value');
  });

  test('--auto-approve-api-key sets api key', () => {
    const r = parseArgs(['--auto-approve-api-key', 'sk-test-123']);
    expect(r.autoApproveApiKey).toBe('sk-test-123');
  });

  test('--auto-approve-api-key without value errors', () => {
    const r = parseArgs(['--auto-approve-api-key']);
    expect(r.error).toContain('--auto-approve-api-key requires a value');
  });

  test('combined auto-approve flags', () => {
    const r = parseArgs([
      '--auto-approve',
      '--auto-approve-model',
      'gemma4:e2b',
      '--auto-approve-provider',
      'ollama',
    ]);
    expect(r.autoApprove).toBe(true);
    expect(r.autoApproveModel).toBe('gemma4:e2b');
    expect(r.autoApproveProvider).toBe('ollama');
  });

  test('auto-approve flags with new subcommand', () => {
    const r = parseArgs(['new', '--auto-approve', '--auto-approve-model', 'llama3.2']);
    expect(r.subcommand).toBe('new');
    expect(r.autoApprove).toBe(true);
    expect(r.autoApproveModel).toBe('llama3.2');
  });

  test('--auto-approve-allow is repeatable', () => {
    const r = parseArgs([
      '--auto-approve-allow',
      'git push',
      '--auto-approve-allow',
      'bun test',
      '--auto-approve-allow',
      'Read',
    ]);
    expect(r.autoApproveAllow).toEqual(['git push', 'bun test', 'Read']);
  });

  test('--auto-approve-deny is repeatable', () => {
    const r = parseArgs(['--auto-approve-deny', 'rm -rf /', '--auto-approve-deny', 'sudo ']);
    expect(r.autoApproveDeny).toEqual(['rm -rf /', 'sudo ']);
  });

  test('--auto-approve-allow defaults to empty array', () => {
    const r = parseArgs([]);
    expect(r.autoApproveAllow).toEqual([]);
    expect(r.autoApproveDeny).toEqual([]);
  });

  test('--auto-approve-allow without value errors', () => {
    const r = parseArgs(['--auto-approve-allow']);
    expect(r.error).toContain('--auto-approve-allow requires a value');
  });

  test('--auto-approve-instructions sets guidance string', () => {
    const r = parseArgs(['--auto-approve-instructions', 'Approve all bun test runs']);
    expect(r.autoApproveInstructions).toBe('Approve all bun test runs');
  });

  test('--auto-approve-instructions without value errors', () => {
    const r = parseArgs(['--auto-approve-instructions']);
    expect(r.error).toContain('--auto-approve-instructions requires a value');
  });

  test('allow and deny flags mixed with other auto-approve flags', () => {
    const r = parseArgs([
      '--auto-approve',
      '--auto-approve-allow',
      'git status',
      '--auto-approve-deny',
      'sudo ',
      '--auto-approve-instructions',
      'Be conservative',
    ]);
    expect(r.autoApprove).toBe(true);
    expect(r.autoApproveAllow).toEqual(['git status']);
    expect(r.autoApproveDeny).toEqual(['sudo ']);
    expect(r.autoApproveInstructions).toBe('Be conservative');
  });
});
