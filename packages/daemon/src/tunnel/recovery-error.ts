export class RecoveryError extends Error {
  constructor(readonly code: 'busy' | 'unavailable') {
    super(`recovery ${code}`);
  }
}
