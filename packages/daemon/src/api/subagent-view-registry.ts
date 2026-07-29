/**
 * SubagentViewRegistry — tracks the subagent conversations a session has
 * spawned, so the client can switch the displayed view to a subagent's chat
 * (epic #499, phase 3).
 *
 * Claude Code stores each subagent's transcript at a DETERMINISTIC path:
 *   <mainTranscriptDir>/<mainSessionId>/subagents/agent-<agentId>.jsonl
 * i.e. the main session's `.jsonl` path with its extension replaced by a
 * per-session `subagents/` subdir. `agentId` is exactly the hook's `agent_id`.
 * So we derive the path from the SubagentStart hook (which carries the MAIN
 * `transcript_path` + the subagent's `agent_id`) with no scanning/correlation.
 *
 * `SubagentStop` later hands over the same path directly as
 * `agent_transcript_path` (#891) — `recordStop` prefers that carried value
 * over the START-time derivation (it's read after the file is guaranteed to
 * exist), falling back to the derivation when the field is absent or
 * malformed. Verified against 18 real `SubagentStop` captures
 * (`~/.remi/hook-diag.jsonl`, 2026-07-29): the carried path matched the
 * derived one in every single case, so the two sources have not been
 * observed to disagree — the derivation stays as a fallback on principle,
 * not because a divergence has ever been seen.
 */

export interface SubagentView {
  /** The subagent's agent_id (matches the on-disk `agent-<id>.jsonl`). */
  readonly agentId: string;
  /** e.g. "general-purpose", "Explore", "pr-review-toolkit:code-reviewer". */
  readonly agentType: string;
  /** Absolute path to the subagent's transcript file. */
  readonly transcriptPath: string;
  /** false once SubagentStop fired; the transcript stays viewable. */
  readonly active: boolean;
}

/**
 * Derive a subagent transcript path from the main transcript path + agent_id.
 * `/a/b/<mainId>.jsonl` + `agent-x` -> `/a/b/<mainId>/subagents/agent-x.jsonl`.
 */
export function deriveSubagentTranscriptPath(mainTranscriptPath: string, agentId: string): string {
  const base = mainTranscriptPath.replace(/\.jsonl$/, '');
  return `${base}/subagents/agent-${agentId}.jsonl`;
}

/**
 * Shape guard for a carried `agent_transcript_path` (#891): must be an
 * absolute path ending in `.jsonl` with no `..` traversal segment. This is a
 * transcript-load key (`transcript-events.ts` reads whatever `resolvePath`
 * returns off disk and sends it to the client), so a value straight off the
 * wire is validated the same way `recordStart` already validates `agentId`
 * before it becomes a path segment, rather than trusted outright.
 */
function isPlausibleTranscriptPath(p: string | undefined): p is string {
  if (!p) return false;
  if (!p.startsWith('/')) return false;
  if (!p.endsWith('.jsonl')) return false;
  if (p.split('/').includes('..')) return false;
  return true;
}

export class SubagentViewRegistry {
  private readonly views = new Map<
    string,
    { agentType: string; transcriptPath: string; active: boolean }
  >();
  /** The parent main-transcript path the current views belong to. When the
   *  parent session rotates (/clear) its path changes, so we drop the old
   *  session's subagents — robust regardless of which binding path drives the
   *  rotation (the drive-mode onRotation also clears+pushes for immediacy). */
  private currentMain: string | null = null;

  /** Record (or refresh) a subagent from a SubagentStart event. No-op without an agentId. */
  recordStart(agentId: string | undefined, agentType: string, mainTranscriptPath: string): void {
    if (!agentId || !mainTranscriptPath) return;
    // agentId becomes a filesystem path segment (agent-<id>.jsonl), so reject
    // anything that could escape the subagents dir. Real values are hex like
    // "ab2e2dd0b25acb847"; a path-traversal payload must never reach the FS.
    if (!/^[A-Za-z0-9_-]+$/.test(agentId)) return;
    // The path is derived by replacing the `.jsonl` suffix with a subdir; if a
    // future Claude format drops it, the derivation would be wrong, so require it.
    if (!mainTranscriptPath.endsWith('.jsonl')) return;
    if (this.currentMain !== null && this.currentMain !== mainTranscriptPath) {
      this.views.clear();
    }
    this.currentMain = mainTranscriptPath;
    this.views.set(agentId, {
      agentType,
      transcriptPath: deriveSubagentTranscriptPath(mainTranscriptPath, agentId),
      active: true,
    });
  }

  /**
   * Mark a subagent inactive (SubagentStop); keep it listed so its chat stays
   * viewable.
   *
   * `carriedTranscriptPath` is `SubagentStop.agent_transcript_path` (#891):
   * Claude Code hands the real path over directly at stop time, rather than
   * remi having to derive it from `SubagentStart.transcript_path` + `agentId`
   * (the module-doc derivation above). Preferred over the START-time guess
   * when present and well-formed — by STOP the file is guaranteed to exist,
   * so this is the more authoritative of the two. Validated with the same
   * shape checks `recordStart` applies to its own inputs (must end in
   * `.jsonl`, absolute, no `..` traversal segment) so a malformed or hostile
   * value can never override a good derived path; falls back to whatever
   * path is already stored when absent or invalid (derivation, or start
   * hasn't been recorded at all, in which case this is a no-op).
   */
  recordStop(agentId: string | undefined, carriedTranscriptPath?: string): void {
    if (!agentId) return;
    const v = this.views.get(agentId);
    if (!v) return;
    const transcriptPath = isPlausibleTranscriptPath(carriedTranscriptPath)
      ? carriedTranscriptPath
      : v.transcriptPath;
    this.views.set(agentId, { ...v, transcriptPath, active: false });
  }

  /** The transcript path for a known subagent, or null. */
  resolvePath(agentId: string): string | null {
    return this.views.get(agentId)?.transcriptPath ?? null;
  }

  /** All known subagent views (active first, then by insertion order). */
  list(): SubagentView[] {
    const entries = [...this.views.entries()].map(([agentId, v]) => ({
      agentId,
      agentType: v.agentType,
      transcriptPath: v.transcriptPath,
      active: v.active,
    }));
    // Active subagents first so the client surfaces what's running now.
    return entries.sort((a, b) => Number(b.active) - Number(a.active));
  }

  get size(): number {
    return this.views.size;
  }

  /** Forget all views (call on session rotation / clear). */
  clear(): void {
    this.views.clear();
    this.currentMain = null;
  }
}
