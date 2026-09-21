import type { UUID } from '@remi/shared';
import type { PrecedentAgentScope, PrecedentStore } from '../auto-approve/precedent.ts';
import { recordHumanAnswer } from '../auto-approve/precedent.ts';

export type SessionPrecedentRecorder = (
  sessionId: UUID,
  toolName: string,
  signature: string,
  decision: 'approved' | 'denied',
  workingDirectory: string,
  agentScope: PrecedentAgentScope,
) => void;

/**
 * Record a client-confirmed precedent in the owning session's store.
 *
 * Kept separate from the CLI entrypoint so the production callback that
 * `createInputHandlers` receives can be exercised without importing the
 * side-effectful CLI module. `agentScope` is required here: dropping it would
 * make the #1019 measurement silently report an unknown origin.
 */
export function recordSessionPrecedent(
  stores: ReadonlyMap<UUID, PrecedentStore>,
  sessionId: UUID,
  toolName: string,
  signature: string,
  decision: 'approved' | 'denied',
  workingDirectory: string,
  agentScope: PrecedentAgentScope,
): void {
  const store = stores.get(sessionId);
  if (store) recordHumanAnswer(store, toolName, signature, decision, workingDirectory, agentScope);
}

/** Build the callback passed to `createInputHandlers` by the production CLI. */
export function createSessionPrecedentRecorder(
  stores: ReadonlyMap<UUID, PrecedentStore>,
): SessionPrecedentRecorder {
  return (sessionId, toolName, signature, decision, workingDirectory, agentScope) =>
    recordSessionPrecedent(
      stores,
      sessionId,
      toolName,
      signature,
      decision,
      workingDirectory,
      agentScope,
    );
}
