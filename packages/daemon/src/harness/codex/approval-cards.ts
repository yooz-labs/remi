/**
 * A Codex server request as a phone card (epic #1175, phase 4 #1178), and a
 * phone answer as the result Codex expects.
 *
 * remi RELAYS Codex's approval; Codex decides (ADR 0030). A card therefore only
 * carries what the person needs to decide and what remi may send back.
 *
 * Which requests are answerable from the phone (v1): ONLY a plain command
 * approval of the session's own thread, that is `item/commandExecution/
 * requestApproval` with `kind: 'command'` and nothing beyond the command itself
 * (no `approvalId`, no extra permissions, no network context or policy
 * amendment). Everything else is a `terminalOnly` card: a notification that
 * says what Codex asks, with no answer controls (file change, permissions, user
 * input, MCP elicitation, a command that grants more than itself, a subagent's
 * request, a request whose fields do not parse, a command too long to show in
 * full). A `terminalOnly` card is never answered from here. A method this file
 * does not know is no card at all (`null`), and is never answered either.
 *
 * Options are built by what they MEAN, never by position, and only from what the
 * request itself lists in `availableDecisions` (an absent list allows `accept`
 * and `decline`): `Yes` is `accept`; `Yes, for this session` is `acceptForSession`
 * (Codex remembers it, remi writes nothing); `No` is `cancel` when listed, else
 * `decline`, else the card cannot be answered. The object-form decisions
 * (`acceptWithExecpolicyAmendment`, `applyNetworkPolicyAmendment`) write a
 * persistent policy from a phone tap and are never offered, so the listed
 * entries that are objects are ignored. Every decision sent is one the request
 * listed (or `decline` for a request that lists none), by construction: it is the
 * option's own value.
 *
 * The real frame (`expA-accept.jsonl:47`) lists `cancel` and not `decline`; the
 * spike showed `decline` works although unlisted. Whether `cancel` from a second
 * client behaves like the TUI's own No is unverified (plan LV-3(c)).
 */

import type { Question, QuestionOption, QuestionStep, UUID } from '@remi/shared';

import { truncateSummary } from '../../hooks/tool-summary.ts';
import type { HeldAnswer } from '../decision.ts';
import type { RequestId } from './app-server-protocol.ts';

export interface PendingRequestSpec {
  /**
   * `${threadId}:${requestId}`. Request ids are one daemon-global counter (spike:
   * ids 1, 2, 5, 6 across threads and runs), so an id alone names nothing.
   */
  key: string;
  threadId: string;
  requestId: RequestId;
  method: string;
  /** The card, with a minted UUID. */
  question: Question;
  /** `option.value` to the JSON-RPC result that answers the request that way. */
  responses: ReadonlyMap<string, unknown>;
  /** The result for the No option, which is also what the card's Cancel sends; null when there is none. */
  noResponse: unknown | null;
  /** False means `terminalOnly`: no phone answer is ever applied. */
  actionable: boolean;
}

const COMMAND = 'item/commandExecution/requestApproval';
const FILE_CHANGE = 'item/fileChange/requestApproval';
const PERMISSIONS = 'item/permissions/requestApproval';
const USER_INPUT = 'item/tool/requestUserInput';
const ELICITATION = 'mcpServer/elicitation/request';
const HANDLED = new Set([COMMAND, FILE_CHANGE, PERMISSIONS, USER_INPUT, ELICITATION]);

/**
 * The longest command a card shows. A card that would cut a command short would let a person
 * approve what they could not read, so a longer command makes a `terminalOnly` card instead.
 */
export const COMMAND_TEXT_MAX = 20_000;
/** Codex's stated reason is shown after the command, cut at this many characters. */
const REASON_MAX = 300;

const GENERIC_ASK = 'Codex is asking for approval; answer it in the terminal';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A non-empty string, or null. */
const nonEmpty = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

export const requestKey = (threadId: string, requestId: RequestId): string =>
  `${threadId}:${String(requestId)}`;

/** Is `method` one this file builds a card for? Anything else is never a card and never answered. */
export const isApprovalMethod = (method: string): boolean => HANDLED.has(method);

/** The thread a request is about, or null when its params do not say. */
export function requestThreadId(params: unknown): string | null {
  return isRecord(params) ? nonEmpty(params['threadId']) : null;
}

/** `serverRequest/resolved`: which request of which thread was answered, or null. */
export function parseResolved(params: unknown): { threadId: string; requestId: RequestId } | null {
  if (!isRecord(params)) return null;
  const threadId = nonEmpty(params['threadId']);
  const id = params['requestId'];
  const validId = typeof id === 'number' ? Number.isFinite(id) : nonEmpty(id) !== null;
  return threadId !== null && validId ? { threadId, requestId: id as RequestId } : null;
}

const option = (
  label: string,
  value: string,
  flags: Partial<Pick<QuestionOption, 'isRecommended' | 'isYes' | 'isNo' | 'standingGrant'>>,
): QuestionOption => ({
  label,
  value,
  isRecommended: false,
  isYes: false,
  isNo: false,
  ...flags,
});

/** The decisions a request lists as plain strings, or null when it lists none at all. */
function listedDecisions(v: unknown): Set<string> | 'unreadable' | null {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v)) return 'unreadable';
  return new Set(v.filter((d): d is string => typeof d === 'string'));
}

interface Context {
  req: { id: RequestId; method: string };
  threadId: string;
  params: Record<string, unknown>;
  mintId: () => UUID;
  agentId: string | undefined;
}

/** A card nobody can answer from the phone: it says what Codex asks and where to answer. */
function terminalOnly(
  c: Context,
  ask: string,
  extra: Partial<Question> = {},
  note = true,
): PendingRequestSpec {
  const who = c.agentId === undefined ? '' : 'Subagent · ';
  return {
    key: requestKey(c.threadId, c.req.id),
    threadId: c.threadId,
    requestId: c.req.id,
    method: c.req.method,
    question: {
      id: c.mintId(),
      text: note ? `${who}${ask}. Answer it in the terminal.` : `${who}${ask}`,
      options: [],
      allowsFreeText: false,
      isAnswered: false,
      kind: 'permission',
      terminalOnly: true,
      ...(c.agentId === undefined ? {} : { agentId: c.agentId }),
      ...extra,
    },
    responses: new Map(),
    noResponse: null,
    actionable: false,
  };
}

const generic = (c: Context): PendingRequestSpec => terminalOnly(c, GENERIC_ASK, {}, false);

function commandCard(c: Context): PendingRequestSpec {
  const { params } = c;
  const command = nonEmpty(params['command']);
  if (command === null) return generic(c);
  if (command.length > COMMAND_TEXT_MAX) {
    return terminalOnly(
      c,
      `Codex asks to run a command too long to show (${command.length} characters)`,
    );
  }
  const listed = listedDecisions(params['availableDecisions']);
  const plain =
    params['kind'] === 'command' &&
    params['approvalId'] == null &&
    params['additionalPermissions'] == null &&
    params['networkApprovalContext'] == null &&
    params['proposedNetworkPolicyAmendments'] == null &&
    listed !== 'unreadable';
  const decisions = listed === 'unreadable' ? null : listed;
  const yes = decisions === null || decisions.has('accept');
  const forSession = decisions?.has('acceptForSession') === true;
  // No is `cancel` when listed (what the TUI's own No sends), else `decline`, else nothing.
  const noDecision = decisions?.has('cancel')
    ? 'cancel'
    : decisions === null || decisions.has('decline')
      ? 'decline'
      : null;
  if (!(plain && yes && noDecision !== null) || c.agentId !== undefined) {
    return terminalOnly(c, `Codex asks to run: ${command}`);
  }

  const options = [
    option('Yes', 'accept', { isRecommended: true, isYes: true }),
    ...(forSession
      ? [
          option('Yes, for this session', 'acceptForSession', {
            isYes: true,
            standingGrant: 'session',
          }),
        ]
      : []),
    option('No', noDecision, { isNo: true }),
  ];
  // A command longer than a lock screen shows is cut the way Claude's cards cut it (head, a count
  // of what is hidden, tail: a command's dangerous part is as likely at its end), and the whole
  // command goes in `detail`, which the app shows in full and the dispatcher never turns into
  // lock-screen buttons (`pushCategoryFor`).
  const shown = truncateSummary(command);
  const stated = nonEmpty(params['reason']);
  const reason =
    stated === null
      ? ''
      : `\nCodex's stated reason: ${stated.length > REASON_MAX ? `${stated.slice(0, REASON_MAX)}...` : stated}`;
  return {
    key: requestKey(c.threadId, c.req.id),
    threadId: c.threadId,
    requestId: c.req.id,
    method: c.req.method,
    question: {
      id: c.mintId(),
      text: `Allow Codex to run: ${shown}${reason}`,
      options,
      allowsFreeText: false,
      isAnswered: false,
      kind: 'permission',
      ...(shown === command ? {} : { detail: command }),
    },
    responses: new Map(options.map((o) => [o.value, { decision: o.value }])),
    noResponse: { decision: noDecision },
    actionable: true,
  };
}

function userInputCard(c: Context): PendingRequestSpec {
  const raw = Array.isArray(c.params['questions']) ? c.params['questions'] : [];
  const steps: QuestionStep[] = [];
  for (const q of raw) {
    const text = isRecord(q) ? nonEmpty(q['question']) : null;
    if (!isRecord(q) || text === null) return generic(c);
    const header = nonEmpty(q['header']);
    const choices = Array.isArray(q['options']) ? q['options'].filter(isRecord) : [];
    steps.push({
      ...(header === null ? {} : { header }),
      text,
      multiSelect: false,
      options: choices.flatMap((o) => {
        const label = nonEmpty(o['label']);
        const description = nonEmpty(o['description']);
        if (label === null) return [];
        return [{ ...option(label, label, {}), ...(description === null ? {} : { description }) }];
      }),
    });
  }
  const first = steps[0];
  if (first === undefined) return generic(c);
  return terminalOnly(c, first.text, { kind: 'multi_question', questions: steps }, false);
}

const reasonSuffix = (reason: string | null): string => (reason === null ? '' : `: ${reason}`);

function fileChangeCard(c: Context): PendingRequestSpec {
  const root = nonEmpty(c.params['grantRoot']);
  return terminalOnly(
    c,
    `Codex asks to change files${reasonSuffix(nonEmpty(c.params['reason']))}${root === null ? '' : ` (write access under ${root})`}`,
  );
}

function permissionsCard(c: Context): PendingRequestSpec {
  const asked = isRecord(c.params['permissions'])
    ? Object.entries(c.params['permissions'])
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([name]) => name)
    : [];
  return terminalOnly(
    c,
    `Codex asks for extra permissions${asked.length === 0 ? '' : ` (${asked.join(', ')})`}${reasonSuffix(nonEmpty(c.params['reason']))}`,
  );
}

/** The host of a URL, which is all an elicitation's `url` mode shows; null when it does not parse. */
function hostOf(url: unknown): string | null {
  try {
    return typeof url === 'string' ? new URL(url).host : null;
  } catch {
    return null;
  }
}

function elicitationCard(c: Context): PendingRequestSpec {
  const server = nonEmpty(c.params['serverName']);
  const message = nonEmpty(c.params['message']);
  if (server === null || message === null) return generic(c);
  const host = c.params['mode'] === 'url' ? hostOf(c.params['url']) : null;
  return terminalOnly(
    c,
    `MCP server ${server} asks: ${message}${host === null ? '' : ` (${host})`}`,
  );
}

/**
 * The card for one server request, or null when the method is not one remi builds a card for, or
 * when the request does not say which thread it is about (nothing could then say it is the
 * session's). A method it knows with fields it cannot read is a generic `terminalOnly` card.
 * `opts.agentId` marks a subagent's request: its card is always `terminalOnly`.
 */
export function buildApprovalCard(
  req: { id: RequestId; method: string; params: unknown },
  mintId: () => UUID,
  opts: { agentId?: string },
): PendingRequestSpec | null {
  if (!HANDLED.has(req.method)) return null;
  const threadId = requestThreadId(req.params);
  if (threadId === null || !isRecord(req.params)) return null;
  const c: Context = { req, threadId, params: req.params, mintId, agentId: opts.agentId };
  switch (req.method) {
    case COMMAND:
      return commandCard(c);
    case FILE_CHANGE:
      return fileChangeCard(c);
    case PERMISSIONS:
      return permissionsCard(c);
    case USER_INPUT:
      return userInputCard(c);
    default:
      return elicitationCard(c);
  }
}

/**
 * What to send for a phone answer: the result of the option the answer names, or the No result for
 * Cancel. Anything else is refused: a card that is not actionable takes nothing, an option the card
 * does not carry (unknown value, or a label that does not match it) is `unknown-option`, and free
 * text, a structured answer or an ambiguous one is `not-an-option`.
 */
export function responseFor(
  spec: PendingRequestSpec,
  answer: HeldAnswer,
):
  | { ok: true; result: unknown }
  | { ok: false; why: 'unknown-option' | 'terminal-only' | 'not-an-option' } {
  if (!spec.actionable) return { ok: false, why: 'terminal-only' };
  if (answer.kind === 'cancel') {
    return spec.noResponse === null
      ? { ok: false, why: 'terminal-only' }
      : { ok: true, result: spec.noResponse };
  }
  if (answer.kind !== 'option') return { ok: false, why: 'not-an-option' };
  const own = spec.question.options.find((o) => o.value === answer.option.value);
  const result = own === undefined ? undefined : spec.responses.get(own.value);
  if (own === undefined || own.label !== answer.option.label || result === undefined) {
    return { ok: false, why: 'unknown-option' };
  }
  return { ok: true, result };
}
