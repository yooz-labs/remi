/**
 * Codex server request -> `Question` card (epic #1175, phase 4 #1178), written
 * against plan section 2.4 before `approval-cards.ts` existed.
 *
 * The first two groups are the PINS:
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
import { buildApprovalCard } from '../../../src/harness/codex/approval-cards.ts';
import {
  pushCategoryFor,
  selectDynOptions,
} from '../../../src/notifications/notification-dispatcher.ts';
import { fixtureFrameAt, loadFixtureFrames } from '../../helpers/codex-fixtures.ts';

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
