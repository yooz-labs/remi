/**
 * Which tool calls execute a shell command (#1020).
 *
 * Three functions used to answer this by testing `toolName !== 'Bash'` against
 * the literal string, each independently. ALL THREE now consult this module:
 *
 *   - `classifyRisk`             (risk-bands.ts)  -> the RISK side
 *   - `matchesCatastrophicPattern` (deny-floor.ts) -> the DENY side
 *   - `matchSubstringPattern`    (pattern-matcher.ts) -> user deny/alert lists
 *
 * The third was left behind in the first cut of this change, and the PR review
 * caught the comment claiming otherwise. It is user-facing (it backs
 * `auto_approve.deny` and `subagent_alert`), so it takes the command scan as a
 * UNION with the existing tool-name match rather than a replacement: a bare
 * `deny = ["terminal"]` matches by NAME today and must keep doing so. `Bash`
 * keeps its command-only branch, since folding a name match in there would
 * newly make `deny = ["Bash"]` refuse every Bash call.
 *
 * For any command-executing tool NOT literally named `Bash`, the first two both
 * fell through to their non-command branches and the operation became
 * unreachable by the two guards that are supposed to be unconditional:
 *
 *   classifyRisk('Bash',     {command: 'rm -rf /'})  -> critical
 *   classifyRisk('terminal', {command: 'rm -rf /'})  -> moderate
 *   matchesCatastrophicPattern('terminal', {command: 'rm -rf /'}) -> null
 *
 * `moderate` is the tier plain conversation text can supply (ADR 0015), and a
 * null catastrophic match means `enforceDenyFloor` has nothing to stand on. So
 * #976's central guarantee -- "`critical` never approves, at any authorization"
 * -- simply did not apply to such a tool.
 *
 * ## Why a shape test and not a name list
 *
 * The obvious fix is a `COMMAND_TOOLS` name set. It cannot be complete: nothing
 * restricts tool names, and an MCP server can register a tool with any name at
 * all, including one whose input is a shell command. A list is exactly as good
 * as whoever last remembered to update it, and this is a security floor.
 *
 * So the test is the INPUT SHAPE: a call carrying a non-empty `command` string
 * is treated as executing that command, whatever it is called. That is total
 * over tool names by construction.
 *
 * The cost is over-classification -- a tool whose `command` means something
 * other than a shell command (`SlashCommand`'s `/deploy`, an MCP git wrapper's
 * `"status"`) gets its text read as one. No consequence is a silent approval,
 * but "more escalation" is NOT uniformly true and an earlier draft of this
 * comment said it was. Per consumer:
 *
 *   - `enforceRiskCeiling` -- higher band, so `approve -> escalate`. More
 *     escalation.
 *   - `enforceAuthorityBoundary` (authority.ts) -- a catastrophic match
 *     downgrades `approve -> escalate`. More escalation.
 *   - `enforceDenyFloor` -- the OTHER direction. It downgrades `deny ->
 *     escalate` only when NOTHING matches, so a broader match makes a model
 *     `deny` STICK where the user would previously have got an answerable
 *     card. Strictly fewer escalations, and a hard deny is silent (that is the
 *     whole reason the floor exists, #953). Safe, but user-visible.
 *
 * Measured against this machine's `~/.remi/hook-diag.jsonl` (111 hook events),
 * no tool other than `Bash` carries a `command` field at all, so the live cost
 * today is zero either way.
 *
 * ## Why `command` and nothing else
 *
 * `summarizeToolInput` (hooks/tool-summary.ts) also accepts `cmd` as a
 * fallback. This deliberately does NOT, because `precedent.ts` documents the
 * matching invariant from the other side: `precedentMayAuthorize` requires
 * `command` specifically, on the grounds that "the risk layer reads `command`
 * and nothing else -- so a `cmd`-only call has an unclassifiable band and must
 * not be authorizable." Reading `cmd` here would silently make that comment
 * false and hand precedent a bound it was written to refuse. If `cmd` is ever
 * added, it must be added to BOTH in one change.
 */

/**
 * The shell command this call will execute, or `null` if it is not a
 * command-executing call.
 *
 * Callers must treat a non-null result as executable text. Both the risk side
 * and the deny side consult this one function, so widening it can never widen
 * one without the other -- which is the specific inconsistency #1020 warns
 * about, since a `critical` band the deny floor cannot match is worse than the
 * gap it replaces.
 */
export function extractToolCommand(toolInput: Record<string, unknown>): string | null {
  const command = toolInput['command'];
  if (typeof command !== 'string' || command.length === 0) return null;
  return command;
}

/**
 * True if this call executes a shell command.
 *
 * Note the asymmetry with `extractToolCommand`: a `Bash` call with an empty or
 * absent `command` is NOT a command tool by this test, and both guards already
 * treated that case as inert (`classifyRisk` returned `moderate`,
 * `matchesCatastrophicPattern` returned null). Preserved rather than tidied, so
 * this change moves only the cases that were actually blind.
 */
export function isCommandTool(toolInput: Record<string, unknown>): boolean {
  return extractToolCommand(toolInput) !== null;
}
