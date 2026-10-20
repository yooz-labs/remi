/** Standalone acceptance wrapper; ordinary operands dispatch the real production entry. */
if (process.argv[2] === '--owned-spike') await import('./insertion-dispatch-probe');
else await import('../../packages/daemon/src/entry');

export {};
