/**
 * #1020: the deny floor and the risk ceiling were blind to any command-executing
 * tool not literally named `Bash`.
 *
 * The measurements in the issue, which these tests now invert:
 *
 *   classifyRisk('Bash',     {command: 'rm -rf /'})  -> critical
 *   classifyRisk('terminal', {command: 'rm -rf /'})  -> moderate     <- the bug
 *   matchesCatastrophicPattern('terminal', {command: 'rm -rf /'}) -> null
 *
 * `moderate` is the tier plain conversation text can supply (ADR 0015), and a
 * null catastrophic match leaves `enforceDenyFloor` nothing to stand on -- so
 * #976's "critical never approves, at any authorization" did not apply to such
 * a tool at all.
 *
 * The pairing is what these assert. The issue is explicit that widening only
 * the risk side would be WORSE than the gap: a `critical` band the floor cannot
 * match is a new inconsistency rather than a fix. So every case below checks
 * both sides on the same input.
 */

import { describe, expect, test } from 'bun:test';
import { extractToolCommand, isCommandTool } from '../../src/auto-approve/command-tools.ts';
import { matchesCatastrophicPattern } from '../../src/auto-approve/deny-floor.ts';
import { classifyRisk } from '../../src/auto-approve/risk-bands.ts';

/** Names a command-executing tool can plausibly ship under. `Bash` is Claude
 *  Code's; the rest are the shapes nothing prevents an MCP server registering,
 *  which is why a name list could never have closed this. */
const COMMAND_TOOL_NAMES = ['Bash', 'terminal', 'bash', 'shell', 'mcp__runner__exec', 'Execute'];

describe('#1020 both guards see every command-carrying tool, not just Bash', () => {
  for (const toolName of COMMAND_TOOL_NAMES) {
    test(`${toolName}: rm -rf / bands critical AND the floor can match it`, () => {
      const input = { command: 'rm -rf /' };
      // Risk side: must reach `critical`, or enforceRiskCeiling cannot cap it.
      expect(classifyRisk(toolName, input)).toBe('critical');
      // Deny side: must match, or enforceDenyFloor has nothing to stand on.
      expect(matchesCatastrophicPattern(toolName, input)).not.toBeNull();
    });
  }

  test('the two sides agree by construction: a critical band always has a floor match', () => {
    // The specific inconsistency the issue warns a partial fix would create.
    const catastrophic = ['rm -rf /', 'mkfs.ext4 /dev/sda', 'dd if=/dev/zero of=/dev/sda'];
    for (const toolName of COMMAND_TOOL_NAMES) {
      for (const command of catastrophic) {
        if (classifyRisk(toolName, { command }) === 'critical') {
          expect(matchesCatastrophicPattern(toolName, { command })).not.toBeNull();
        }
      }
    }
  });
});

describe('#1020 the shape test does not disturb non-command tools', () => {
  test('a Write to a sensitive path still bands high', () => {
    expect(classifyRisk('Write', { file_path: '/etc/hosts', content: 'x' })).toBe('high');
  });

  test('an ordinary Read stays moderate', () => {
    expect(classifyRisk('Read', { file_path: '/tmp/notes.md' })).toBe('moderate');
  });

  test('a tool carrying BOTH a command and a sensitive path takes the MAX, not the command', () => {
    // `classifyRisk` folds the command band with the non-command band rather
    // than choosing. Choosing the command band would silently drop the
    // isSensitiveWritePath elevation this function has always applied.
    const band = classifyRisk('Write', { command: 'echo hi', file_path: '/etc/hosts' });
    expect(band).toBe('high');
  });

  test('Bash with an empty command is inert, exactly as before', () => {
    // Preserved rather than tidied: both guards already treated this as inert,
    // so it is not one of the cases that was blind.
    expect(matchesCatastrophicPattern('Bash', {})).toBeNull();
    expect(classifyRisk('Bash', { command: '' })).toBe('moderate');
  });
});

describe('extractToolCommand', () => {
  test('returns the command for any tool name', () => {
    expect(extractToolCommand({ command: 'ls' })).toBe('ls');
    expect(isCommandTool({ command: 'ls' })).toBe(true);
  });

  test('returns null when there is no command', () => {
    expect(extractToolCommand({ file_path: '/tmp/x' })).toBeNull();
    expect(isCommandTool({ file_path: '/tmp/x' })).toBe(false);
  });

  test('an empty command is not a command tool', () => {
    expect(extractToolCommand({ command: '' })).toBeNull();
  });

  test('a non-string command is not a command tool', () => {
    expect(extractToolCommand({ command: ['rm', '-rf', '/'] })).toBeNull();
  });

  test('`cmd` is deliberately NOT read — precedent.ts depends on that', () => {
    // `precedentMayAuthorize` requires `command` specifically, on the stated
    // grounds that the risk layer reads `command` and nothing else. Reading
    // `cmd` here would make that comment false and hand precedent a bound it
    // was written to refuse. If `cmd` is ever added it must be added to both.
    expect(extractToolCommand({ cmd: 'rm -rf /' })).toBeNull();
  });
});
