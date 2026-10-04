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
 * and `decline`): `Yes` is `accept`; `Yes, and don't ask again for this command
 * this session` is `acceptForSession` (remi writes nothing; none of 7 real command
 * approvals on Codex 0.160.0 listed it, so it is unreachable in practice and what
 * Codex does with it is unknown, LV-3 (f));
 * `No` is `cancel` when listed, else
 * `decline`, else the card cannot be answered. The object-form decisions
 * (`acceptWithExecpolicyAmendment`, `applyNetworkPolicyAmendment`) write a
 * persistent policy from a phone tap and are never offered, so the listed
 * entries that are objects are ignored. Every decision sent is one the request
 * listed (or `decline` for a request that lists none), by construction: it is the
 * option's own value.
 *
 * The real frame (`expA-accept.jsonl:47`) lists `cancel` and not `decline`; the
 * spike showed `decline` works although unlisted. A client's `cancel` is the TUI's
 * own No: Codex declines the command and interrupts the turn (verified live, Codex
 * 0.160.0, 2026-10-04, LV-3 (c)).
 */

import { resolve } from 'node:path';

import { escapeUnsafeText } from '@remi/shared';
import type { Question, QuestionOption, QuestionStep, UUID } from '@remi/shared';

import { HEAD_KEEP, SUMMARY_MAX, TAIL_KEEP, cutSummary } from '../../hooks/tool-summary.ts';
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
/** Codex's stated reason is shown after the command, cut at this many characters (marked like every other cut field). */
const REASON_MAX = 300;

const GENERIC_ASK = 'Codex is asking for approval; answer it in the terminal';

/**
 * What the live-sessions file, the hub census and the menu-bar notifications show of a card
 * (`Question.pendingLabel`): a fixed phrase, because the card's text is the command Codex asks to
 * run, or text the server chose, and none of it belongs in a file on disk.
 */
const COMMAND_LABEL = 'Permission: Codex command';
const OTHER_LABEL = 'Codex asks for approval';

/**
 * Bounds on what the server chooses. A frame may be 32 MiB, and a card goes to every client, into
 * the replay history and through the relay, so a hostile MCP server's message must not become a
 * multi-megabyte card. A cut says how much it hid, and is made before escaping so it never lands
 * inside a `\uXXXX`. Worst case, a user-input card is under 120 thousand characters.
 */
const TEXT_MAX = 2000;
const LABEL_MAX = 200;
const DESCRIPTION_MAX = 500;
const MAX_STEPS = 8;
const MAX_STEP_OPTIONS = 12;
const MAX_PERMISSION_NAMES = 20;
const DIRECTORY_MAX = 500;

/** An escape `escapeUnsafeText` writes: `\\uXXXX`, or `\\u{XXXXX}` above the Basic Multilingual Plane. */
const ESCAPE = /\\u(?:[0-9A-F]{4}|\{[0-9A-F]{1,6}\})/g;
/** The longest escape, `\\u{E007F}`: nine characters, so one that straddles an index starts at most 8 before it. */
const ESCAPE_MAX = 9;

/** `index`, or the end of the escape it falls inside (an escape is never cut in the middle). */
function outOfEscape(text: string, index: number): number {
  ESCAPE.lastIndex = Math.max(0, index - (ESCAPE_MAX - 1));
  for (let m = ESCAPE.exec(text); m !== null && m.index < index; m = ESCAPE.exec(text)) {
    const end = m.index + m[0].length;
    if (end > index) return end;
  }
  return index;
}

/**
 * A command (already escaped) cut the way Claude's cards cut one, head and tail around a count of
 * what is hidden, but never in the middle of an escape: the head is extended to the end of one
 * that straddles its boundary and the tail starts after one that straddles its own, and the count
 * is what lies between. A command with nothing to snap is cut exactly as `truncateSummary` does.
 */
function cutCommand(command: string): string {
  if (command.length <= SUMMARY_MAX) return command;
  return cutSummary(
    command,
    outOfEscape(command, HEAD_KEEP),
    outOfEscape(command, command.length - TAIL_KEEP),
  );
}

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)} [${text.length - max} characters hidden]` : text;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A non-empty string, or null. */
const nonEmpty = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/**
 * A non-empty string a peer chose, cut to `max` and then made safe to show: a character of the set
 * `escapeUnsafeText` lists (terminal controls, bidi and invisible characters, the Tags block) comes
 * out as visible text, because a card's text reaches the attach client's terminal, the web card,
 * Telegram and a push, and a hostile command would otherwise act on each. The cut comes first, so
 * it never lands inside an escape. Everything a card shows from the request goes through here or
 * through `escapeUnsafeText` itself (the thread and request ids, which are matched and never
 * shown, do not).
 */
const display = (v: unknown, max = TEXT_MAX): string | null => {
  const text = nonEmpty(v);
  return text === null ? null : escapeUnsafeText(clip(text, max));
};

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
  sessionDirectory: string;
}

/** A card nobody can answer from the phone: it says what Codex asks and where to answer. */
function terminalOnly(
  c: Context,
  ask: string,
  extra: Partial<Question> = {},
  note = true,
  pendingLabel = OTHER_LABEL,
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
      // A phone Cancel clears the card and answers nothing (`CodexDecisions.answerHeld`), so the
      // app must not say it declines anything.
      cancelDismissesOnly: true,
      pendingLabel,
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
  const asked = nonEmpty(params['command']);
  if (asked === null) return generic(c);
  // The bound is on what would be shown: escaping makes a bidi control six characters long.
  const command = escapeUnsafeText(asked);
  if (command.length > COMMAND_TEXT_MAX) {
    return terminalOnly(
      c,
      `Codex asks to run a command too long to show (${asked.length} characters)`,
      {},
      true,
      COMMAND_LABEL,
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
  // Where the command runs is part of what the person approves, so a request that does not say
  // (every real frame of the spike does, as a non-empty string) or says it in a form that is not
  // text cannot be answered from the phone, like an unreadable list of decisions.
  const where = nonEmpty(params['cwd']);
  const yes = decisions === null || decisions.has('accept');
  const forSession = decisions?.has('acceptForSession') === true;
  // No is `cancel` when listed (what the TUI's own No sends), else `decline`, else nothing.
  const noDecision = decisions?.has('cancel')
    ? 'cancel'
    : decisions === null || decisions.has('decline')
      ? 'decline'
      : null;
  if (!(plain && yes && noDecision !== null) || c.agentId !== undefined || where === null) {
    return terminalOnly(c, `Codex asks to run: ${command}`, {}, true, COMMAND_LABEL);
  }

  const options = [
    option('Yes', 'accept', { isRecommended: true, isYes: true }),
    ...(forSession
      ? [
          option("Yes, and don't ask again for this command this session", 'acceptForSession', {
            isYes: true,
            standingGrant: 'session',
          }),
        ]
      : []),
    option('No', noDecision, { isNo: true }),
  ];
  // A command longer than a lock screen shows is cut the way Claude's cards cut it (head, a count
  // of what is hidden, tail: a command's dangerous part is as likely at its end), but off any
  // escape (`cutCommand`), and the whole command goes in `detail`, which the app shows in full and
  // the dispatcher never turns into lock-screen buttons (`pushCategoryFor`).
  const shown = cutCommand(command);
  // A command is judged by where it runs as much as by its text (a relative path, a recursive
  // delete in the wrong tree): the directory is on the card, in the app and in the push, whenever
  // it is not the session's own. It then also goes in `detail`, so a card that names another
  // directory gets no lock-screen buttons. Never in a log.
  const place =
    resolve(where) !== resolve(c.sessionDirectory)
      ? `\nIn directory: ${escapeUnsafeText(clip(where, DIRECTORY_MAX))}`
      : '';
  const reason = display(params['reason'], REASON_MAX);
  // `display` cuts before escaping, so a cut never lands inside a `\uXXXX`, and says what it cut.
  const reasonLine = reason === null ? '' : `\nCodex's stated reason: ${reason}`;
  return {
    key: requestKey(c.threadId, c.req.id),
    threadId: c.threadId,
    requestId: c.req.id,
    method: c.req.method,
    question: {
      id: c.mintId(),
      text: `Allow Codex to run: ${shown}${place}${reasonLine}`,
      options,
      allowsFreeText: false,
      isAnswered: false,
      kind: 'permission',
      pendingLabel: COMMAND_LABEL,
      ...(shown === command && place === '' ? {} : { detail: `${command}${place}` }),
    },
    responses: new Map(options.map((o) => [o.value, { decision: o.value }])),
    noResponse: { decision: noDecision },
    actionable: true,
  };
}

function userInputCard(c: Context): PendingRequestSpec {
  const asked = Array.isArray(c.params['questions']) ? c.params['questions'] : [];
  const raw = asked.slice(0, MAX_STEPS);
  const steps: QuestionStep[] = [];
  for (const q of raw) {
    const text = isRecord(q) ? display(q['question']) : null;
    if (!isRecord(q) || text === null) return generic(c);
    const header = display(q['header'], LABEL_MAX);
    const choices = Array.isArray(q['options']) ? q['options'].filter(isRecord) : [];
    const hiddenChoices = Math.max(0, choices.length - MAX_STEP_OPTIONS);
    steps.push({
      ...(header === null ? {} : { header }),
      text: hiddenChoices === 0 ? text : `${text} [${hiddenChoices} more options hidden]`,
      multiSelect: false,
      options: choices.slice(0, MAX_STEP_OPTIONS).flatMap((o) => {
        const label = display(o['label'], LABEL_MAX);
        const description = display(o['description'], DESCRIPTION_MAX);
        if (label === null) return [];
        return [{ ...option(label, label, {}), ...(description === null ? {} : { description }) }];
      }),
    });
  }
  const first = steps[0];
  const last = steps.at(-1);
  if (first === undefined || last === undefined) return generic(c);
  if (asked.length > MAX_STEPS) {
    steps[steps.length - 1] = {
      ...last,
      text: `${last.text} [${asked.length - MAX_STEPS} more questions hidden]`,
    };
  }
  return terminalOnly(
    c,
    (steps[0] as QuestionStep).text,
    { kind: 'multi_question', questions: steps },
    false,
  );
}

const reasonSuffix = (reason: string | null): string => (reason === null ? '' : `: ${reason}`);

function fileChangeCard(c: Context): PendingRequestSpec {
  const root = display(c.params['grantRoot']);
  return terminalOnly(
    c,
    `Codex asks to change files${reasonSuffix(display(c.params['reason']))}${root === null ? '' : ` (write access under ${root})`}`,
  );
}

function permissionsCard(c: Context): PendingRequestSpec {
  const names = isRecord(c.params['permissions'])
    ? Object.entries(c.params['permissions'])
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([name]) => name)
    : [];
  const shown = names
    .slice(0, MAX_PERMISSION_NAMES)
    .map((name) => escapeUnsafeText(clip(name, LABEL_MAX)));
  const hidden = names.length - shown.length;
  const list = hidden > 0 ? [...shown, `[${hidden} more hidden]`] : shown;
  return terminalOnly(
    c,
    `Codex asks for extra permissions${list.length === 0 ? '' : ` (${list.join(', ')})`}${reasonSuffix(display(c.params['reason']))}`,
  );
}

/**
 * The host of a URL, which is all an elicitation's `url` mode shows; null when it does not parse.
 * A host has no length limit in a URL, so it is cut like any other label.
 */
function hostOf(url: unknown): string | null {
  try {
    return typeof url === 'string' ? escapeUnsafeText(clip(new URL(url).host, LABEL_MAX)) : null;
  } catch {
    return null;
  }
}

function elicitationCard(c: Context): PendingRequestSpec {
  const server = display(c.params['serverName'], LABEL_MAX);
  const message = display(c.params['message']);
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
  opts: { agentId?: string; sessionDirectory: string },
): PendingRequestSpec | null {
  if (!HANDLED.has(req.method)) return null;
  const threadId = requestThreadId(req.params);
  if (threadId === null || !isRecord(req.params)) return null;
  const c: Context = {
    req,
    threadId,
    params: req.params,
    mintId,
    agentId: opts.agentId,
    sessionDirectory: opts.sessionDirectory,
  };
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
