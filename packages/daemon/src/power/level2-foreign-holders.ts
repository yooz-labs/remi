/**
 * ADR 0050's foreign-holder rule (#1773): which assertions held by another
 * process refuse or pause level 2. Pure; the caller supplies the parsed
 * `pmset -g assertions` holders and remi's own pids.
 */

/**
 * One holder of `pmset -g assertions`. Structurally the same as the readings
 * slice's parsed holder, declared here so this rule does not depend on the
 * parser's module.
 */
export interface Level2AssertionHolder {
  readonly pid: number;
  readonly process: string;
  /** The assertion type, for example `PreventUserIdleSystemSleep`. */
  readonly type: string;
  /** Self-chosen by the holder (an application's or page's text); never copied out. */
  readonly name: string;
  /** From a `Created for PID: N.` detail line, else null. */
  readonly createdForPid: number | null;
}

export type ForeignHolderKind = 'display' | 'system';

/** A foreign holder by process name only; the assertion's `name` never leaves this module. */
export interface ForeignHolder {
  readonly process: string;
  readonly kind: ForeignHolderKind;
}

export interface ForeignHolderClassification {
  /** Foreign holders that refuse or pause level 2. */
  readonly blocking: readonly ForeignHolder[];
  /** Foreign system-sleep holders skipped because their process is on the ignore list. */
  readonly ignored: readonly ForeignHolder[];
}

/** Display-sleep types always block (video, calls, slides). */
export const FOREIGN_DISPLAY_TYPES: ReadonlySet<string> = new Set([
  'PreventUserIdleDisplaySleep',
  'NoDisplaySleepAssertion',
]);

/** System-sleep types block unless the process is on the person's ignore list. */
export const FOREIGN_SYSTEM_TYPES: ReadonlySet<string> = new Set([
  'PreventSystemSleep',
  'PreventUserIdleSystemSleep',
  'NoIdleSleepAssertion',
]);

/**
 * powerd always holds this one while the display is on (ADR 0050, verified on
 * macOS 27.2); exempt only when the process, the type and the name all match.
 */
export const POWERD_DISPLAY_ON_EXEMPTION = Object.freeze({
  process: 'powerd',
  type: 'PreventUserIdleSystemSleep',
  name: 'Prevent sleep while display is on',
});

function isPowerdDisplayOn(holder: Level2AssertionHolder): boolean {
  return (
    holder.process === POWERD_DISPLAY_ON_EXEMPTION.process &&
    holder.type === POWERD_DISPLAY_ON_EXEMPTION.type &&
    holder.name === POWERD_DISPLAY_ON_EXEMPTION.name
  );
}

/**
 * A holder is remi's when its own pid or the pid it was created for (remi's
 * `caffeinate -w PID` reads `Created for PID: PID`) is one of `remiPids`.
 * Display holders always block; system holders block unless their process name
 * is in `ignore` (exact, case-sensitive); every other type (`UserIsActive`,
 * kernel and USB assertions, ...) is ignored. Each list holds one entry per
 * process name and kind, in the order first seen.
 */
export function classifyForeignHolders(
  holders: readonly Level2AssertionHolder[],
  remiPids: ReadonlySet<number> | readonly number[],
  ignore: readonly string[],
): ForeignHolderClassification {
  const remi: ReadonlySet<number> = remiPids instanceof Set ? remiPids : new Set(remiPids);
  const ignoreSet = new Set(ignore);
  const blocking: ForeignHolder[] = [];
  const ignored: ForeignHolder[] = [];
  const seen = new Set<string>();

  const add = (list: ForeignHolder[], tag: string, process: string, kind: ForeignHolderKind) => {
    const key = `${tag}\u0000${kind}\u0000${process}`;
    if (seen.has(key)) return;
    seen.add(key);
    list.push({ process, kind });
  };

  for (const holder of holders) {
    if (remi.has(holder.pid)) continue;
    if (holder.createdForPid !== null && remi.has(holder.createdForPid)) continue;
    if (isPowerdDisplayOn(holder)) continue;
    if (FOREIGN_DISPLAY_TYPES.has(holder.type)) {
      add(blocking, 'b', holder.process, 'display');
    } else if (FOREIGN_SYSTEM_TYPES.has(holder.type)) {
      if (ignoreSet.has(holder.process)) add(ignored, 'i', holder.process, 'system');
      else add(blocking, 'b', holder.process, 'system');
    }
  }
  return { blocking, ignored };
}
