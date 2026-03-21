import { describe, expect, test } from 'bun:test';
import { TargetParseError, resolveTarget } from '../../src/cli/target-resolver.ts';

const DEFAULT_PORT = 18765;

describe('resolveTarget', () => {
  // -------------------------------------------------------------------------
  // host:port/session format
  // -------------------------------------------------------------------------
  describe('host:port/session format', () => {
    test('parses IP:port/session', () => {
      const r = resolveTarget({
        subcommandArg: '192.168.1.1:18765/my-session',
        cliHost: undefined,
        cliPort: undefined,
        defaultPort: DEFAULT_PORT,
      });
      expect(r.host).toBe('192.168.1.1');
      expect(r.port).toBe(18765);
      expect(r.targetId).toBe('my-session');
    });

    test('parses hostname:port/session-with-slashes', () => {
      const r = resolveTarget({
        subcommandArg: '100.79.39.98:18766/macbook:remi/main',
        cliHost: undefined,
        cliPort: undefined,
        defaultPort: DEFAULT_PORT,
      });
      expect(r.host).toBe('100.79.39.98');
      expect(r.port).toBe(18766);
      expect(r.targetId).toBe('macbook:remi/main');
    });

    test('inline host:port overrides --host and --port flags', () => {
      const r = resolveTarget({
        subcommandArg: '10.0.0.1:9000/session',
        cliHost: 'other-host',
        cliPort: 8000,
        defaultPort: DEFAULT_PORT,
      });
      expect(r.host).toBe('10.0.0.1');
      expect(r.port).toBe(9000);
      expect(r.targetId).toBe('session');
    });
  });

  // -------------------------------------------------------------------------
  // host:port format (no session, for auto-attach)
  // -------------------------------------------------------------------------
  describe('host:port format', () => {
    test('parses bare host:port', () => {
      const r = resolveTarget({
        subcommandArg: '192.168.1.1:18767',
        cliHost: undefined,
        cliPort: undefined,
        defaultPort: DEFAULT_PORT,
      });
      expect(r.host).toBe('192.168.1.1');
      expect(r.port).toBe(18767);
      expect(r.targetId).toBeUndefined();
    });

    test('throws on copy-paste garbage', () => {
      expect(() =>
        resolveTarget({
          subcommandArg: '192.168.1.1:18767idle',
          cliHost: undefined,
          cliPort: undefined,
          defaultPort: DEFAULT_PORT,
        }),
      ).toThrow(TargetParseError);
    });

    test('copy-paste error includes suggestion', () => {
      try {
        resolveTarget({
          subcommandArg: '192.168.1.1:18767idle',
          cliHost: undefined,
          cliPort: undefined,
          defaultPort: DEFAULT_PORT,
        });
      } catch (err) {
        expect(err).toBeInstanceOf(TargetParseError);
        expect((err as TargetParseError).suggestion).toBe('192.168.1.1:18767');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Plain session name
  // -------------------------------------------------------------------------
  describe('plain session name', () => {
    test('plain name uses defaults', () => {
      const r = resolveTarget({
        subcommandArg: 'my-session',
        cliHost: undefined,
        cliPort: undefined,
        defaultPort: DEFAULT_PORT,
      });
      expect(r.host).toBe('localhost');
      expect(r.port).toBe(DEFAULT_PORT);
      expect(r.targetId).toBe('my-session');
    });

    test('plain name with --host uses flag', () => {
      const r = resolveTarget({
        subcommandArg: 'my-session',
        cliHost: '10.0.0.1',
        cliPort: undefined,
        defaultPort: DEFAULT_PORT,
      });
      expect(r.host).toBe('10.0.0.1');
      expect(r.targetId).toBe('my-session');
    });

    test('plain name with --host and --port', () => {
      const r = resolveTarget({
        subcommandArg: 'my-session',
        cliHost: '10.0.0.1',
        cliPort: 9000,
        defaultPort: DEFAULT_PORT,
      });
      expect(r.host).toBe('10.0.0.1');
      expect(r.port).toBe(9000);
      expect(r.targetId).toBe('my-session');
    });

    test('session name with colon (hostname:dir/branch) is not parsed as remote', () => {
      const r = resolveTarget({
        subcommandArg: 'macbook:remi/main',
        cliHost: undefined,
        cliPort: undefined,
        defaultPort: DEFAULT_PORT,
      });
      // "macbook:remi" has non-numeric segment "remi" between colon and slash
      // so it should NOT be parsed as host:port/session
      expect(r.host).toBe('localhost');
      expect(r.targetId).toBe('macbook:remi/main');
    });
  });

  // -------------------------------------------------------------------------
  // No arg
  // -------------------------------------------------------------------------
  describe('no arg', () => {
    test('no arg returns defaults with undefined targetId', () => {
      const r = resolveTarget({
        subcommandArg: undefined,
        cliHost: undefined,
        cliPort: undefined,
        defaultPort: DEFAULT_PORT,
      });
      expect(r.host).toBe('localhost');
      expect(r.port).toBe(DEFAULT_PORT);
      expect(r.targetId).toBeUndefined();
    });

    test('no arg with --host uses flag', () => {
      const r = resolveTarget({
        subcommandArg: undefined,
        cliHost: '10.0.0.1',
        cliPort: 9000,
        defaultPort: DEFAULT_PORT,
      });
      expect(r.host).toBe('10.0.0.1');
      expect(r.port).toBe(9000);
      expect(r.targetId).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------
  describe('edge cases', () => {
    test('session name that looks like hostname:dir (non-numeric port segment)', () => {
      const r = resolveTarget({
        subcommandArg: 'yahyas-mcm:eventformer/main:2',
        cliHost: undefined,
        cliPort: undefined,
        defaultPort: DEFAULT_PORT,
      });
      // "eventformer" is not numeric, so this is a session name, not host:port
      expect(r.host).toBe('localhost');
      expect(r.targetId).toBe('yahyas-mcm:eventformer/main:2');
    });

    test('session ID prefix (short string)', () => {
      const r = resolveTarget({
        subcommandArg: 'abc123',
        cliHost: undefined,
        cliPort: undefined,
        defaultPort: DEFAULT_PORT,
      });
      expect(r.targetId).toBe('abc123');
    });
  });
});
