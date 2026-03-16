import { describe, expect, test } from 'bun:test';
import { parseArgs } from '../../src/cli/arg-parser.ts';

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

    test('--sessions', () => {
      expect(parseArgs(['--sessions']).showSessions).toBe(true);
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
});
