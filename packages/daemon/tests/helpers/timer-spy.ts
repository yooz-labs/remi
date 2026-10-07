/**
 * Records the timers a test starts and clears, delegating every call to the real
 * `setTimeout` and `clearTimeout` (nothing is replaced: timers fire as usual). Used to pin
 * defaults that would take seconds to observe by waiting (a 15 s request timeout), and to show a
 * timer is cleared when its work is done, which no result-based assertion can see.
 */
export interface RecordedTimer {
  ms: number;
  cleared: boolean;
  fired: boolean;
}

export interface TimerSpy {
  timers: RecordedTimer[];
  /** The timers started with exactly `ms`. */
  withDelay(ms: number): RecordedTimer[];
  restore(): void;
}

export function spyTimers(): TimerSpy {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const timers: RecordedTimer[] = [];
  const byHandle = new Map<unknown, RecordedTimer>();
  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const record: RecordedTimer = { ms: ms ?? 0, cleared: false, fired: false };
    timers.push(record);
    const handle = realSet(
      (...a: unknown[]) => {
        record.fired = true;
        return fn(...a);
      },
      ms,
      ...args,
    );
    byHandle.set(handle, record);
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle?: unknown) => {
    const record = byHandle.get(handle);
    if (record) record.cleared = true;
    return realClear(handle as Parameters<typeof clearTimeout>[0]);
  }) as typeof clearTimeout;
  return {
    timers,
    withDelay: (ms) => timers.filter((t) => t.ms === ms),
    restore: () => {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    },
  };
}
