/**
 * #959: the destination axis for write-side permission groups.
 *
 * Two failure directions, and the second is the one that gets skipped:
 *
 *  - Too narrow -> a write group covers `/etc/hosts` or `~/.remi/config.toml`.
 *  - Too broad  -> the group covers nothing useful, everything escalates, and
 *    the level that was supposed to reduce interruptions does not. A denylist
 *    that over-blocks looks identical to one that works if you only ever test
 *    the things it should catch.
 *
 * So every block here is paired with its negative.
 */

import { describe, expect, test } from 'bun:test';
import {
  isSensitiveWritePath,
  segmentTouchesSensitivePath,
} from '../../src/auto-approve/sensitive-paths.ts';

describe('system trees', () => {
  for (const p of [
    '/etc',
    '/etc/hosts',
    '/etc/cron.d/job',
    '/usr/local/bin/remi',
    '/bin/sh',
    '/sbin/reboot',
    '/var/root/x',
    '/opt/homebrew/bin/remi',
    '/System/Library/x',
    '/Library/LaunchAgents/x.plist',
    '/private/etc/hosts',
  ]) {
    test(`sensitive: ${p}`, () => expect(isSensitiveWritePath(p)).toBe(true));
  }

  for (const p of [
    // Prefix matching must be path-aware, not substring: these are ordinary
    // project paths that merely START with the same letters.
    '/etcetera/notes.md',
    '/usrdata/file.txt',
    '/binaries/out',
    '/Users/x/project/src/etc.ts',
    '/tmp/build/output',
    '/Users/yahya/Documents/git/yooz/remi/packages/daemon/src/x.ts',
  ]) {
    test(`ordinary: ${p}`, () => expect(isSensitiveWritePath(p)).toBe(false));
  }
});

describe('credentials and keys', () => {
  for (const p of [
    '~/.ssh/authorized_keys',
    '~/.ssh/config',
    '/Users/x/.aws/credentials',
    '~/.gnupg/secring.gpg',
    '~/.kube/config',
    '~/.npmrc',
    '$HOME/.ssh/id_ed25519',
    // Relative traversal must be caught the same as an absolute path.
    '../../.ssh/authorized_keys',
    './.aws/credentials',
  ]) {
    test(`sensitive: ${p}`, () => expect(isSensitiveWritePath(p)).toBe(true));
  }

  for (const p of ['/Users/x/project/ssh-helper.ts', '/Users/x/project/docs/aws-setup.md']) {
    test(`ordinary: ${p}`, () => expect(isSensitiveWritePath(p)).toBe(false));
  }
});

describe('config governing this mechanism', () => {
  // The privilege-escalation loop: an auto-approved write that widens what is
  // auto-approved next.
  for (const p of [
    '~/.remi/config.toml',
    '$HOME/.remi/config.toml',
    '/Users/yahya/.remi/config.toml',
    '~/.claude/settings.json',
    '/Users/yahya/.claude/settings.json',
    '~/.claude/CLAUDE.md',
  ]) {
    test(`sensitive: ${p}`, () => expect(isSensitiveWritePath(p)).toBe(true));
  }

  test('a project file merely NAMED like them is ordinary', () => {
    expect(isSensitiveWritePath('/Users/x/project/claude-helper.ts')).toBe(false);
    expect(isSensitiveWritePath('/Users/x/project/docs/remi.md')).toBe(false);
    // AGENTS.md / CLAUDE.md in a project root are edited constantly.
    expect(isSensitiveWritePath('/Users/x/project/CLAUDE.md')).toBe(false);
  });
});

describe('.git internals', () => {
  for (const p of ['.git/hooks/pre-commit', '/Users/x/project/.git/config', '~/repo/.git/HEAD']) {
    test(`sensitive: ${p}`, () => expect(isSensitiveWritePath(p)).toBe(true));
  }

  test('.gitignore and .github are NOT .git', () => {
    // Both are ordinary tracked files people edit all the time; catching them
    // would be the over-block failure.
    expect(isSensitiveWritePath('/Users/x/project/.gitignore')).toBe(false);
    expect(isSensitiveWritePath('/Users/x/project/.github/workflows/ci.yml')).toBe(false);
    expect(isSensitiveWritePath('.gitattributes')).toBe(false);
  });
});

describe('secret basenames', () => {
  for (const p of [
    '.env',
    '/Users/x/project/.env',
    '.env.local',
    '.env.production',
    'id_rsa',
    '/Users/x/keys/id_ed25519',
    'credentials',
    'authorized_keys',
    '.htpasswd',
  ]) {
    test(`sensitive: ${p}`, () => expect(isSensitiveWritePath(p)).toBe(true));
  }

  for (const p of [
    // The classic over-block: a directory or file whose name merely CONTAINS
    // the secret name.
    '/Users/x/project/environment.ts',
    '/Users/x/project/src/env.ts',
    '/Users/x/project/docs/credentials-guide.md',
    '/Users/x/project/test/id_rsa_parser.test.ts',
  ]) {
    test(`ordinary: ${p}`, () => expect(isSensitiveWritePath(p)).toBe(false));
  }

  test('every `.env.`-prefixed basename is sensitive, deliberately over-broad', () => {
    // The rule refuses the whole `.env.*` family rather than guessing which
    // suffixes hold real secrets. That knowingly catches documentation
    // (`.env.example`, `.env.example.md`), which costs one escalation on a
    // file people edit rarely -- cheaper than reasoning per-suffix about
    // which one holds a live credential.
    expect(isSensitiveWritePath('.env.example')).toBe(true);
    expect(isSensitiveWritePath('/Users/x/project/.env.example.md')).toBe(true);
    // The boundary: the `.env.` prefix is on the BASENAME, so a normal file
    // whose name merely contains "env" is unaffected.
    expect(isSensitiveWritePath('/Users/x/project/envelope.ts')).toBe(false);
  });
});

describe('input handling', () => {
  test('quotes are stripped', () => {
    expect(isSensitiveWritePath('"/etc/hosts"')).toBe(true);
    expect(isSensitiveWritePath("'~/.ssh/config'")).toBe(true);
  });

  test('duplicate slashes do not defeat the match', () => {
    expect(isSensitiveWritePath('/etc//hosts')).toBe(true);
    expect(isSensitiveWritePath('//etc/hosts')).toBe(true);
  });

  test('empty and whitespace are not sensitive', () => {
    expect(isSensitiveWritePath('')).toBe(false);
    expect(isSensitiveWritePath('   ')).toBe(false);
  });

  test('a bare `~` is the home dir, not a literal name', () => {
    // `~foo` is a USERNAME expansion, not the home dir, so it must not be
    // rewritten into `/HOME foo`.
    expect(isSensitiveWritePath('~/.ssh')).toBe(true);
    expect(isSensitiveWritePath('~project/notes.md')).toBe(false);
  });
});

describe('segmentTouchesSensitivePath', () => {
  test('finds a sensitive path in any argument position', () => {
    expect(segmentTouchesSensitivePath('cp evil /etc/hosts')).toBe(true);
    expect(segmentTouchesSensitivePath('cp /etc/hosts /tmp/backup')).toBe(true);
    expect(segmentTouchesSensitivePath('tee -a ~/.ssh/authorized_keys')).toBe(true);
  });

  test('finds one behind a --flag= form', () => {
    expect(segmentTouchesSensitivePath('curl --output=/etc/hosts https://x')).toBe(true);
    expect(segmentTouchesSensitivePath('wget --output-document=/usr/local/bin/x https://y')).toBe(
      true,
    );
  });

  test('an ordinary project command is untouched', () => {
    expect(segmentTouchesSensitivePath('mkdir -p packages/web/dist')).toBe(false);
    expect(segmentTouchesSensitivePath('cp src/a.ts src/b.ts')).toBe(false);
    expect(segmentTouchesSensitivePath('git commit -m "fix: the thing"')).toBe(false);
  });

  test('checks EVERY token, not a guessed destination position', () => {
    // Telling an argument from a destination needs each command's flag
    // grammar; getting that wrong fails open. Checking all tokens can only
    // fail closed.
    expect(segmentTouchesSensitivePath('mv -t /etc src.txt')).toBe(true);
    expect(segmentTouchesSensitivePath('cp a b c d /etc/dest')).toBe(true);
  });
});
