import { runReading } from './run-reading.ts';

export interface RootDomainReading {
  /** `"SleepDisabled"`: yes only while `pmset disablesleep 1` (or similar) is in force. */
  readonly sleepDisabled: 'yes' | 'no' | 'unknown';
  /**
   * `"AppleClamshellState"`.
   * `absent` means the key is not listed in a complete read (true of a Mac mini); it is not proof
   * that the Mac has no lid, and a laptop whose key goes missing would read the same.
   */
  readonly clamshell: 'open' | 'closed' | 'absent' | 'unknown';
}

const UNKNOWN: RootDomainReading = { sleepDisabled: 'unknown', clamshell: 'unknown' };

const ROOT_LINE = /^\+-o IOPMrootDomain\b/m;
// The property block of `ioreg -r` ends with a lone closing brace, before an optional blank line.
const CLOSING_LINE = /^\s*\}\s*$/;

function singleBoolean(
  lines: readonly string[],
  key: string,
  absent: 'absent' | 'unknown',
): 'Yes' | 'No' | 'absent' | 'unknown' {
  const keyed = lines.filter((line) => line.trimStart().startsWith(`"${key}"`));
  if (keyed.length === 0) return absent;
  if (keyed.length > 1) return 'unknown';
  const match = new RegExp(`^\\s*"${key}" = (Yes|No)$`).exec(keyed[0] ?? '');
  return match ? (match[1] as 'Yes' | 'No') : 'unknown';
}

/**
 * Reads `ioreg -r -c IOPMrootDomain -d 1`.
 * A key that appears twice, or with another value, is unknown; output with no `IOPMrootDomain`
 * header, or cut before the property block's closing brace, is unknown for both fields (so an
 * empty or truncated read is never "no lid").
 */
export function parseRootDomain(text: string): RootDomainReading {
  if (!ROOT_LINE.test(text)) return UNKNOWN;
  const lines = text.split(/\r?\n/);
  const lastContent = [...lines].reverse().find((line) => line.trim() !== '');
  if (lastContent === undefined || !CLOSING_LINE.test(lastContent)) return UNKNOWN;
  const sleep = singleBoolean(lines, 'SleepDisabled', 'unknown');
  const clamshell = singleBoolean(lines, 'AppleClamshellState', 'absent');
  return {
    sleepDisabled: sleep === 'Yes' ? 'yes' : sleep === 'No' ? 'no' : 'unknown',
    clamshell:
      clamshell === 'Yes'
        ? 'closed'
        : clamshell === 'No'
          ? 'open'
          : clamshell === 'absent'
            ? 'absent'
            : 'unknown',
  };
}

/** `ioreg -r -c IOPMrootDomain -d 1`; a failed run makes both fields unknown. */
export async function readRootDomain(): Promise<RootDomainReading> {
  const run = await runReading('/usr/sbin/ioreg', ['-r', '-c', 'IOPMrootDomain', '-d', '1']);
  if (!run.ok) return UNKNOWN;
  return parseRootDomain(run.stdout);
}
