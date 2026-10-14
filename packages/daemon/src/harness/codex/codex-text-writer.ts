/**
 * Internal #1207 RPC writer. No production caller/capability yet.
 *
 * The future caller owns device authority, request replay and correlated delivery.
 * This writer performs at most one selected turn RPC per call, with no PTY or
 * retry/fallback path. Acceptance is not model completion. Requests omit every
 * sandbox/approval/cwd override, preserving the thread's configured posture.
 */
import type { AppServerClient } from './app-server-client.ts';
import { UUID_PATTERN } from './codex-args.ts';

export const CODEX_CHAT_TEXT_BYTES = 16 * 1024;

export interface CodexTextContext {
  readonly threadId: string;
  /** Replaced on runtime, app-server connection or main-thread identity change. */
  readonly epoch: object;
}

export interface CodexTextRequest {
  readonly id: string;
  readonly threadId: string;
  readonly text: string;
}

export type CodexTextResult =
  | {
      readonly outcome: 'accepted';
      readonly method: 'turn/start' | 'turn/steer';
      readonly turnId: string;
    }
  | {
      readonly outcome: 'refused';
      readonly code: 'malformed' | 'unavailable' | 'binding_changed' | 'prompt_up' | 'busy';
    }
  | { readonly outcome: 'uncertain'; readonly code: 'delivery_unknown' };

export interface CodexTextWriterDeps {
  readonly client: AppServerClient;
  /** Only the live session's bound main thread, never an arbitrary app-server thread. */
  readonly current: () => CodexTextContext | null;
  readonly blocked: () => boolean;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && value === value.toLowerCase() && UUID_PATTERN.test(value);
const refused = (
  code: Extract<CodexTextResult, { outcome: 'refused' }>['code'],
): CodexTextResult => ({
  outcome: 'refused',
  code,
});

function valid(request: CodexTextRequest): boolean {
  if (
    !uuid(request.id) ||
    !uuid(request.threadId) ||
    typeof request.text !== 'string' ||
    request.text.length > CODEX_CHAT_TEXT_BYTES ||
    request.text.trim().length === 0 ||
    request.text.includes('\0')
  )
    return false;
  const bytes = new TextEncoder().encode(request.text);
  return (
    bytes.byteLength <= CODEX_CHAT_TEXT_BYTES &&
    new TextDecoder('utf-8', { fatal: true }).decode(bytes) === request.text
  );
}

/** Main-thread metadata only: first-turn histories need not be materialized (#1207). */
function status(response: unknown, threadId: string): 'idle' | 'active' | 'blocked' | null {
  const thread = record(record(response)?.['thread']);
  if (
    thread?.['id'] !== threadId ||
    thread['ephemeral'] !== false ||
    thread['parentThreadId'] !== null
  )
    return null;
  const state = record(thread['status']);
  if (state?.['type'] === 'idle') return 'idle';
  if (state?.['type'] !== 'active') return null;
  const flags = state['activeFlags'];
  if (!Array.isArray(flags) || flags.length > 16 || flags.some((flag) => typeof flag !== 'string'))
    return null;
  return flags.length ? 'blocked' : 'active';
}

export class CodexTextWriter {
  private readonly deps: CodexTextWriterDeps;
  private closed = false;
  private sending = false;

  constructor(deps: CodexTextWriterDeps) {
    this.deps = deps;
  }

  close(): void {
    this.closed = true;
  }

  async send(request: CodexTextRequest, guard: () => boolean): Promise<CodexTextResult> {
    // Capture caller-owned values before any await; later mutation cannot retarget a call.
    const captured = { id: request.id, threadId: request.threadId, text: request.text };
    if (!valid(captured)) return refused('malformed');
    if (this.sending) return refused('busy');
    let context: CodexTextContext | null;
    try {
      context = this.deps.current();
    } catch {
      return refused('unavailable');
    }
    if (!context || this.closed || this.deps.client.state !== 'ready')
      return refused('unavailable');
    if (context.threadId !== captured.threadId) return refused('binding_changed');
    const epoch = context.epoch;
    const current = (): CodexTextResult | null => {
      try {
        if (this.closed || this.deps.client.state !== 'ready' || guard() !== true)
          return refused('unavailable');
        const now = this.deps.current();
        if (!now || now.epoch !== epoch || now.threadId !== captured.threadId)
          return refused('binding_changed');
        if (this.deps.blocked()) return refused('prompt_up');
      } catch {
        return refused('unavailable');
      }
      return null;
    };
    const initial = current();
    if (initial) return initial;
    this.sending = true;
    let possibleEffect = false;
    try {
      const metadata = await this.deps.client.request('thread/read', {
        threadId: captured.threadId,
        includeTurns: false,
      });
      const invalid = current();
      if (invalid) return invalid;
      const state = status(metadata, captured.threadId);
      if (state === null) return refused('unavailable');
      if (state === 'blocked') return refused('prompt_up');
      let turnId: string | null = null;
      if (state === 'active') {
        const page = record(
          await this.deps.client.request('thread/turns/list', {
            threadId: captured.threadId,
            limit: 1,
            sortDirection: 'desc',
            itemsView: 'summary',
          }),
        );
        const lost = current();
        if (lost) return lost;
        const data = page?.['data'];
        const turn = Array.isArray(data) && data.length === 1 ? record(data[0]) : null;
        if (!uuid(turn?.['id']) || turn?.['status'] !== 'inProgress') return refused('busy');
        turnId = turn['id'];
        // The atomic expectedTurnId on steer guards a later completion/new-turn race.
        const latest = await this.deps.client.request('thread/read', {
          threadId: captured.threadId,
          includeTurns: false,
        });
        const latestState = status(latest, captured.threadId);
        if (latestState === 'blocked') return refused('prompt_up');
        if (latestState !== 'active') return refused('busy');
      }
      const lost = current();
      if (lost) return lost;
      const method = turnId ? 'turn/steer' : 'turn/start';
      // This exact boundary may enqueue input. Every later fault is uncertain, not retry authority.
      possibleEffect = true;
      const response = record(
        await this.deps.client.request(method, {
          threadId: captured.threadId,
          clientUserMessageId: captured.id,
          input: [{ type: 'text', text: captured.text }],
          ...(turnId ? { expectedTurnId: turnId } : {}),
        }),
      );
      const acceptedId =
        method === 'turn/start' ? record(response?.['turn'])?.['id'] : response?.['turnId'];
      if (!uuid(acceptedId) || (turnId !== null && acceptedId !== turnId) || current())
        return { outcome: 'uncertain', code: 'delivery_unknown' };
      // turn/start may append to a turn that became active meanwhile; method is not proof of a new turn.
      return { outcome: 'accepted', method, turnId: acceptedId };
    } catch {
      return possibleEffect
        ? { outcome: 'uncertain', code: 'delivery_unknown' }
        : refused('unavailable');
    } finally {
      this.sending = false;
    }
  }
}
