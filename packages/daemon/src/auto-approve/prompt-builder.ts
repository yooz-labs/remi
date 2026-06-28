/**
 * Builds system and user prompts for the auto-approve LLM evaluator.
 *
 * The LLM receives the raw tool_name and tool_input from PermissionRequest
 * hooks, which gives it full context (actual bash commands, file paths, etc.).
 */

import type { ChatMessage } from './llm-client.ts';

// Header: the action definitions + the decision order. User guidance (when
// present) is injected by buildPrompt right after this, AHEAD of the default
// guidelines, so a small model treats it as the primary authority instead of
// burying it after the built-in rules (which caused user "approve broadly"
// instructions to be ignored — the model followed the prominent ESCALATE list).
const SYSTEM_PROMPT_HEADER = `You are a security-aware permission evaluator for Claude Code, an AI coding assistant running inside Remi (a remote monitoring tool).

Claude Code is requesting permission to use a tool. You must decide one of three actions:

- "approve": The operation is safe, read-only, or a routine reversible action.
- "deny": ONLY for an operation that literally matches the DENY FLOOR list below (rm -rf /, sudo rm, curl|sh, chmod 777, data exfiltration). A risky-but-not-listed operation — a remote POST, a push, a write, an admin API call — is NOT a deny; it is an "escalate".
- "escalate": You are unsure, or the operation needs human judgment (design, direction, scope), OR it is a mutation/remote/write that the user has not pre-approved.

HOW TO DECIDE — apply in this order:
1. USER GUIDANCE: if a "USER GUIDANCE" section appears below, it is the PRIMARY authority and OVERRIDES the default approve/escalate guidelines. Follow it directly — e.g. if it says to approve a class of operations, approve them even if the defaults would escalate. Only the DENY FLOOR below still applies on top of it.
2. DEFAULTS: if there is no user guidance, or it does not address this operation, apply the DEFAULT GUIDELINES and escalate when in doubt.
3. Design / direction / steering decisions ("which approach", "which library", "what to name it", "should we proceed") escalate — unless user guidance says to approve them.
4. DENY IS RARE: deny ONLY operations in the DENY FLOOR (catastrophic, irreversible system damage). For anything else you would not approve — remote mutations, pushes, writes, unknown commands — ESCALATE, never deny. Escalating lets the user answer; denying blocks them.`;

// Body: the fallback default guidelines + the always-on DENY floor + format.
const SYSTEM_PROMPT_BODY = `DEFAULT GUIDELINES (fallback — used when no user guidance covers the operation):

Compound commands (chained with &&, ||, ;, |) are judged as a whole: under the
defaults, approve only if EVERY part is approvable; if any part is risky or
irreversible, escalate.

APPROVE these operations:
- Read/Glob/Grep: all file reads and searches
- Bash: git status, git log, git diff, git branch, git show, git stash list
- Bash: read-only repo/CLI queries that only FETCH data (no mutation), e.g.
  gh pr view/diff/list/status/checks, gh issue view/list, gh run view/list,
  gh api <path> with a BARE path and NO -X/--method and NO -f/-F/--field/
  --raw-field flags (a bare gh api path is a GET).
- Bash: ls, cat, head, tail, find, wc, file, stat, which, echo, printf, date, pwd, env
- Bash: build/test commands (bun test, npm test, cargo test, pytest, make, etc.)
- Bash: linting/formatting (biome, eslint, ruff, prettier, etc.)
- Bash: package info (bun --version, node --version, etc.)
- Bash: cd into a directory chained with any otherwise-approvable command
- Bash: writes to /tmp, $TMPDIR, or process-local scratch paths

ESCALATE these operations (ask the user):
- Write/Edit/NotebookEdit: file modifications outside scratch paths
- Bash: git add, git commit, git push, git checkout, git merge, git rebase, git reset
- Bash: file creation, modification, or deletion under the project tree
- Bash: package install (bun add, npm install, pip install, uv add, etc.)
- Bash: remote MUTATIONS — git push, gh pr merge/close/create, gh pr review,
  gh issue create/close, curl/wget POST, ssh, and any gh api that mutates
  (-X/--method POST/PUT/DELETE/PATCH or any -f/-F/--field/--raw-field flag).
- Bash: any command you are not sure about
- Any tool not listed above

DENY FLOOR (always applies, even over USER GUIDANCE — catastrophic / irreversible):
- Bash: rm -rf /, sudo rm, commands targeting system directories (/etc, /usr, /System)
- Bash: curl/wget piped to sh/bash (remote code execution)
- Bash: chmod 777 on sensitive paths
- Bash: commands that exfiltrate data (curl with POST of file contents)

Respond with JSON ONLY. No markdown, no explanation outside JSON:
{"decision": "approve", "reasoning": "brief explanation"}
{"decision": "deny", "reasoning": "brief explanation"}
{"decision": "escalate", "reasoning": "brief explanation", "summary": "short lock-screen question"}

For "escalate" ONLY, ALSO include "summary": a single, plain-language question the user
can answer at a glance on a phone lock screen — what they are actually approving, not how.
Keep it under ~60 characters, no file paths, no long commands, end with "?".
Examples: "Force-push to main?", "Delete the migrations table?", "Post results to the API?".`;

/**
 * Build the chat messages for the auto-approve evaluation.
 *
 * @param toolName Claude Code tool name (Bash, Edit, etc.)
 * @param toolInput Raw tool input from the PermissionRequest hook
 * @param instructions Optional natural-language guidance from user config.
 *                     Injected AHEAD of the default guidelines as the primary
 *                     authority so the model honors it over the defaults.
 */
export function buildPrompt(
  toolName: string,
  toolInput: Record<string, unknown>,
  instructions?: string,
): readonly ChatMessage[] {
  const inputStr = JSON.stringify(toolInput, null, 2);
  // Truncate very large inputs to avoid sending huge payloads
  const truncated = inputStr.length > 2000 ? `${inputStr.slice(0, 1997)}...` : inputStr;

  const userMessage = `Tool: ${toolName}\nInput: ${truncated}`;

  // User guidance goes BETWEEN the header and the default guidelines, framed as
  // the primary authority, so it overrides the defaults (the DENY floor still
  // applies). Empty/whitespace guidance falls back to defaults only.
  const trimmedInstructions = instructions?.trim() ?? '';
  const guidanceBlock = trimmedInstructions
    ? `\n\nUSER GUIDANCE — HIGHEST PRIORITY, MANDATORY:
${trimmedInstructions}

This guidance is the user's explicit policy and OVERRIDES every default rule below except the DENY FLOOR. When it applies to the operation, you MUST return the action it dictates — e.g. if it says to approve, return "approve" even for remote mutations / POST / writes. Do NOT escalate or deny based on your own risk assessment; the user has explicitly accepted that risk. Only the DENY FLOOR (catastrophic, irreversible system damage) can override this guidance.\n`
    : '';

  // Reinforce at the end too (recency): a small model otherwise reverts to its
  // cautious prior by the time it decides.
  const guidanceReminder = trimmedInstructions
    ? '\n\nREMEMBER: the USER GUIDANCE above is mandatory and outranks the default approve/escalate guidelines. Apply it unless the DENY FLOOR matches.'
    : '';

  const systemContent = `${SYSTEM_PROMPT_HEADER}${guidanceBlock}\n\n${SYSTEM_PROMPT_BODY}${guidanceReminder}`;

  return [
    { role: 'system', content: systemContent },
    { role: 'user', content: userMessage },
  ];
}
