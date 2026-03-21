/**
 * Check if a process is alive by sending signal 0.
 * Returns false for invalid PIDs (0, negative, non-integer).
 * EPERM means the process exists but is owned by a different user.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    return false;
  }
}
