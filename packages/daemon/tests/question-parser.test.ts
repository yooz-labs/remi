/**
 * Tests for question parsing.
 *
 * Detection is gated on real signals (epic #415 / epic #435 Phase 1):
 *  - Claude's selection-box chrome (❯ cursor on a numbered option)
 *  - literal (y/n)/[y/n] from subprocesses
 *  - explicit free-text waiting markers
 * A plain numbered list or prose ending in `?` must NOT be detected.
 *
 * Fixtures under parser/fixtures/ are REAL Claude Code 2.1.156 output captured
 * via a PTY (no mocks): the selection box is the trust dialog (same renderer
 * Claude uses for permission and multi-choice prompts); the negatives are a
 * numbered markdown list and a sentence ending in `?` that Claude printed.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UUID } from '@remi/shared';
import { OutputProcessor } from '../src/parser/output-processor.ts';
import {
  hasQuestionIndicator,
  parseNumberedOptions,
  parseQuestion,
} from '../src/parser/question-parser.ts';
import { WRAPPED_DIRECTORY_DIALOG } from './parser/fixtures/claude-dialogs.ts';

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, 'parser', 'fixtures', name), 'utf8');

describe('parseQuestion() - selection-box chrome (Claude prompts)', () => {
  test('detects a synthetic permission selection box', () => {
    const input = "Do you want to proceed?\n❯ 1. Yes\n  2. Yes, and don't ask again\n  3. No";
    const result = parseQuestion(input);
    expect(result.detected).toBe(true);
    expect(result.type).toBe('numbered');
    expect(result.question?.options.length).toBe(3);
    expect(result.question?.options[0]?.value).toBe('1');
    expect(result.question?.options[2]?.value).toBe('3');
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  test('detects the real captured selection box (collapsed spacing)', () => {
    const result = parseQuestion(fixture('prompt-selection-box.clean.txt'));
    expect(result.detected).toBe(true);
    expect(result.type).toBe('numbered');
    // Trust dialog renders two options: "Yes, I trust this folder" / "No, exit".
    expect(result.question?.options.length).toBeGreaterThanOrEqual(2);
    expect(result.question?.options[0]?.value).toBe('1');
  });

  test('parses N) delimiter inside a box', () => {
    const result = parseQuestion('Pick:\n❯ 1) Alpha\n  2) Beta');
    expect(result.detected).toBe(true);
    expect(result.question?.options.length).toBe(2);
  });

  test('first option is recommended', () => {
    const result = parseQuestion('❯ 1. First\n  2. Second');
    expect(result.question?.options[0]?.isRecommended).toBe(true);
    expect(result.question?.options[1]?.isRecommended).toBe(false);
  });

  test('strips box-drawing borders around option labels', () => {
    const result = parseQuestion('│ ❯ 1. Allow  │\n│   2. Deny   │');
    expect(result.detected).toBe(true);
    expect(result.question?.options.length).toBe(2);
    expect(result.question?.options[0]?.label).toBe('Allow');
    expect(result.question?.options[1]?.label).toBe('Deny');
  });
});

/**
 * #1134: a phone card's numbering now comes from this parse, so an option the
 * parse drops is an option the phone cannot pick, and a 2-option card is sent
 * with the static Yes/No push category whatever its second option says.
 * Claude wraps a label that is wider than the terminal onto the next row(s);
 * that row used to end the option block, losing every later option.
 */
describe('parseQuestion() - wrapped option labels (#1134)', () => {
  test('the live wrapped dialog parses all three options, "No" included', () => {
    const result = parseQuestion(WRAPPED_DIRECTORY_DIALOG);
    expect(result.detected).toBe(true);
    const options = result.question?.options ?? [];
    expect(options.map((o) => o.value)).toEqual(['1', '2', '3']);
    expect(options[0]?.label).toBe('Yes');
    // Both rows of the wrapped label belong to option 2, joined with ONE
    // space. The path was wrapped mid-token, so the space lands inside it
    // ("-86 66-00"): the documented cost of the join heuristic. The missing
    // spaces between words are the cursor-column spacing loss, #1137.
    expect(options[1]?.label).toBe(
      'Yes,andalwaysallowaccessto/private/tmp/remi-e5/-Users-dev-Documents-git-example-workspace/0f1e2d3c-4b5a-6978-86 66-00a1b2c3d4e5/scratchpad/spike/work/e5-classic-detached-nofromthisproject',
    );
    // The footer after the last option is not absorbed into it.
    expect(options[2]?.label).toBe('No');
  });

  test('a spaced wrap joins the rows with a space', () => {
    const result = parseQuestion(
      [
        'Do you want to proceed?',
        '❯ 1. Yes',
        '  2. Yes, and always allow access to /a/very/long/path',
        '     /continued/here from this project',
        '  3. No',
        ' Esc to cancel',
      ].join('\n'),
    );
    expect(result.question?.options.map((o) => o.label)).toEqual([
      'Yes',
      'Yes, and always allow access to /a/very/long/path /continued/here from this project',
      'No',
    ]);
  });

  test('a non-option line still ends the block when the sequence does not resume', () => {
    // A prose line, then a separate list starting at 1: not a continuation.
    const result = parseQuestion(
      ['❯ 1. Yes', '  2. No', 'Some prose Claude printed', '1. an unrelated list'].join('\n'),
    );
    expect(result.question?.options.map((o) => o.label)).toEqual(['Yes', 'No']);
  });

  test('never joins across the footer: "3.5k tokens used" is not option 3', () => {
    const labels = (s: string) => parseQuestion(s).question?.options.map((o) => o.label);
    expect(
      labels(
        [
          'Do you want to proceed?',
          '❯1. Yes',
          '  2. No',
          'Esc to cancel · Tab to amend',
          '3.5k tokens used',
        ].join('\n'),
      ),
    ).toEqual(['Yes', 'No']);
    // The same with the spacing ANSI stripping collapses.
    expect(labels(['❯1.Yes', '2.No', 'Esctocancel·Tabtoamend', '3.5ktokens'].join('\n'))).toEqual([
      'Yes',
      'No',
    ]);
  });

  test('a footer then prose then "3. ..." adds no option', () => {
    const result = parseQuestion(
      [
        'Do you want to proceed?',
        '❯ 1. Yes',
        '  2. No',
        'Esc to cancel',
        'Next steps:',
        '3. run the tests',
      ].join('\n'),
    );
    expect(result.question?.options.map((o) => o.label)).toEqual(['Yes', 'No']);
  });

  test('divider rows are dropped, not glued into a label', () => {
    const result = parseQuestion(
      ['❯ 1. Yes', '  2. Yes, and always allow', ' ──────────', '  3. No'].join('\n'),
    );
    expect(result.question?.options.map((o) => o.label)).toEqual([
      'Yes',
      'Yes, and always allow',
      'No',
    ]);
  });

  test('more than five rows before the next number end the block', () => {
    const result = parseQuestion(
      ['❯ 1. Yes', '  2. a', '  u', '  v', '  w', '  x', '  y', '  z', '  3. No'].join('\n'),
    );
    expect(result.question?.options.map((o) => o.label)).toEqual(['Yes', 'a']);
  });

  test('a label wrapping onto three more rows keeps the "No" after it', () => {
    const result = parseQuestion(
      [
        'Allow?',
        '❯ 1. Yes',
        '  2. Yes, and always allow access to aaaaaaaaaaaaaaaaaaaaaaaaa',
        '     bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        '     cccccccccccccccccccccccccccc',
        '     ddddddddddddddddddddd from this project',
        '  3. No',
      ].join('\n'),
    );
    expect(result.question?.options.map((o) => o.value)).toEqual(['1', '2', '3']);
    expect(result.question?.options[2]?.label).toBe('No');
  });

  test('an AskUserQuestion description with one "·" is not a footer', () => {
    const result = parseQuestion(
      [
        'Which store?',
        '❯ 1. Redis',
        '     Fast · in-memory',
        '  2. Postgres',
        '     Durable · SQL',
        '  3. Type something.',
        'Enter to select · ↑/↓ to navigate · Esc to cancel',
      ].join('\n'),
    );
    expect(result.question?.options.map((o) => o.label)).toEqual([
      'Redis Fast · in-memory',
      'Postgres Durable · SQL',
      'Type something.',
    ]);
  });

  test('a row of three "·" phrases is a footer wherever it starts', () => {
    const result = parseQuestion(
      ['❯ 1. Yes', '  2. No', 'Saved · 3 files · 12s', '3. run the tests'].join('\n'),
    );
    expect(result.question?.options.map((o) => o.label)).toEqual(['Yes', 'No']);
  });
});

/**
 * #1134 review: AskUserQuestion menus parse since the wrapped-label join
 * (their description rows used to end the block). Pinned from the committed
 * live captures, replayed chunk by chunk through the real OutputProcessor
 * exactly as the daemon feeds it, so a parser change that shifts the
 * numbering shows up here. Labels carry the description row and the
 * capture's own render artifacts (partial frames, #1137 spacing loss).
 */
describe('AskUserQuestion captures parse with their own numbering (#1134)', () => {
  function emittedOptions(name: string): string[][] {
    const lines = readFileSync(join(import.meta.dir, 'fixtures', 'auq', name), 'utf8').split('\n');
    const questions: string[][] = [];
    const processor = new OutputProcessor(
      { sessionId: 'auq-fixture' as UUID, streamStatusOnly: true },
      {
        onMessage: () => {},
        onQuestion: (q) => questions.push(q.options.map((o) => `${o.value}:${o.label}`)),
      },
    );
    for (const line of lines) {
      const m = /^OUT \d+ (?:[a-z]+ )?(".*")$/.exec(line);
      if (m) processor.process(JSON.parse(m[1] as string) as string);
    }
    processor.flush();
    return questions;
  }

  test('one question, single select', () => {
    expect(emittedOptions('one-question-single-select.txt')).toEqual([
      ['1:Red A warm color.', '2:Green Acoolcolor.', '3:Blue Acoolcolor.', '4:Typesomething.'],
    ]);
  });

  test('one question, multi select', () => {
    expect(emittedOptions('one-question-multi-select.txt')).toEqual([
      [
        '1:[ ] Apple Crisp andclassic',
        '2:[ ] Banana Sweetandsoft',
        '3:[]Cherry Smallandtart-sweet',
        '4:[]Date Richandcaramel-like',
        '5:[]Typesomething',
      ],
    ]);
  });

  test('two questions, single and multi', () => {
    expect(emittedOptions('two-questions-single-and-multi.txt')).toEqual([
      [
        '1:Red The color red.',
        '2:Green Thecolorgreen.',
        '3:Blue Thecolorblue.',
        '4:Typesomething.',
      ],
    ]);
  });

  test('three questions, multi select in the middle', () => {
    expect(emittedOptions('three-questions-multi-middle.txt')).toEqual([
      ['1:Red Thcolorred', '2:Green Thecolorgreen', '3:Typesomething.'],
      ['1:Submit answers', '2:Cancel'],
    ]);
  });

  test('three questions, single select', () => {
    expect(emittedOptions('three-questions-single-select.txt')).toEqual([
      ['1:1 Option 1 for A', '2:2 Option2forA', '3:3 Option3forA', '4:Typesomething.'],
      ['1:Submit answers', '2:Cancel'],
    ]);
  });
});

describe('parseQuestion() - literal yes/no (subprocess prompts)', () => {
  test('detects (y/n) pattern', () => {
    const result = parseQuestion('Do you want to continue? (y/n)');
    expect(result.detected).toBe(true);
    expect(result.type).toBe('yes_no');
    expect(result.question?.text).toBe('Do you want to continue?');
    expect(result.question?.options.length).toBe(2);
    expect(result.question?.options[0]?.isYes).toBe(true);
    expect(result.question?.options[1]?.isNo).toBe(true);
    // #718: explicitly NOT the daemon's synthetic Yes/No fallback, even
    // though the labels now coincide post-#718 (see question-merge.ts).
    expect(result.question?.optionsAreFallback).toBe(false);
  });

  test('detects [y/n] pattern', () => {
    expect(parseQuestion('Proceed with installation? [y/n]').type).toBe('yes_no');
  });

  test('detects (yes/no) pattern', () => {
    expect(parseQuestion('Are you sure? (yes/no)').type).toBe('yes_no');
  });

  test('case insensitive matching', () => {
    expect(parseQuestion('Continue? (Y/N)').type).toBe('yes_no');
  });

  test('handles multiline with y/n at end', () => {
    const result = parseQuestion('This will delete all files.\nAre you sure? (y/n)');
    expect(result.detected).toBe(true);
    expect(result.type).toBe('yes_no');
  });

  test('yes/no has high confidence', () => {
    expect(parseQuestion('Continue? (y/n)').confidence).toBeGreaterThanOrEqual(0.9);
  });
});

describe('parseQuestion() - explicit free-text waiting (subprocess prompts)', () => {
  test('detects "waiting for input"', () => {
    const result = parseQuestion('Waiting for input...');
    expect(result.detected).toBe(true);
    expect(result.type).toBe('free_text');
  });

  test('detects "enter your response"', () => {
    const result = parseQuestion('Please enter your response:');
    expect(result.detected).toBe(true);
    expect(result.type).toBe('free_text');
  });

  test('free text has lower confidence and empty options', () => {
    const result = parseQuestion('Waiting for input:');
    expect(result.confidence).toBeLessThan(0.7);
    expect(result.question?.options.length).toBe(0);
    expect(result.question?.allowsFreeText).toBe(true);
  });
});

describe('parseQuestion() - NOT a prompt (false-positive guards)', () => {
  test('plain numbered list without cursor is NOT detected', () => {
    const input = 'Here are three frameworks:\n1. React\n2. Vue\n3. Angular';
    expect(parseQuestion(input).detected).toBe(false);
  });

  test('prose ending in a question mark is NOT detected', () => {
    expect(parseQuestion('What is the project name?').detected).toBe(false);
    expect(parseQuestion('Is this a question?').detected).toBe(false);
  });

  test('permission-style prose without a box is NOT detected', () => {
    expect(parseQuestion('Allow file access?').detected).toBe(false);
    expect(parseQuestion('Do you want to install dependencies?').detected).toBe(false);
  });

  test('the empty input box (❯ with no option) is NOT detected', () => {
    expect(parseQuestion('❯ \n────').detected).toBe(false);
  });

  test('a single cursor option (no second option) is NOT detected', () => {
    // Guards the >=2 requirement: a lone "❯ 1. ..." is not a selection prompt.
    expect(parseQuestion('❯ 1. Only one option').detected).toBe(false);
  });

  test('cursor line and a separate list line do NOT combine across lines', () => {
    // The input box "❯ " on one line and a list "1. Foo" elsewhere must not pair.
    expect(parseQuestion('❯ Try "write a test"\n────\n1. Foo\n2. Bar').detected).toBe(false);
  });

  test('plain text / empty / whitespace', () => {
    expect(parseQuestion('This is just regular output.').detected).toBe(false);
    expect(parseQuestion('').detected).toBe(false);
    expect(parseQuestion('   \n   ').detected).toBe(false);
    expect(parseQuestion('Just some output').confidence).toBe(0);
  });

  test('REAL captured numbered list is NOT detected', () => {
    expect(parseQuestion(fixture('numbered-list-not-a-prompt.clean.txt')).detected).toBe(false);
  });

  test('REAL captured prose-ending-in-? is NOT detected', () => {
    expect(parseQuestion(fixture('prose-ending-question.clean.txt')).detected).toBe(false);
  });
});

describe('parseQuestion() - ANSI handling and properties', () => {
  test('strips ANSI codes before parsing y/n', () => {
    const result = parseQuestion('\x1b[1mDo you want to continue?\x1b[0m (y/n)');
    expect(result.detected).toBe(true);
    expect(result.type).toBe('yes_no');
  });

  test('detects a box with ANSI-colored options', () => {
    const input = '\x1b[33mPick:\x1b[0m\n\x1b[36m❯ 1.\x1b[0m First\n  \x1b[32m2.\x1b[0m Second';
    expect(parseQuestion(input).detected).toBe(true);
  });

  test('question has unique id and starts unanswered', () => {
    const a = parseQuestion('Q1? (y/n)');
    const b = parseQuestion('Q2? (y/n)');
    expect(a.question?.id).not.toBe(b.question?.id);
    expect(a.question?.isAnswered).toBe(false);
    expect(a.question?.answer).toBeUndefined();
  });

  test('every parsed question carries source "pty" (#888/#920)', () => {
    // The shared type's own doc says "PTY-parsed prompts are 'pty'", but
    // nothing ever set it -- this is the one-line #920 fix that makes the
    // hook-less cohort visible in the question-lifecycle trace at all. All
    // three parser paths (selection-box chrome, literal y/n, free-text
    // waiting) go through createQuestion, so one assertion per path.
    const chrome = parseQuestion('❯ 1. Yes\n  2. No');
    expect(chrome.question?.source).toBe('pty');

    const yesNo = parseQuestion('Continue? (y/n)');
    expect(yesNo.question?.source).toBe('pty');

    const waiting = parseQuestion('Please enter your response');
    expect(waiting.question?.source).toBe('pty');
  });
});

describe('hasQuestionIndicator()', () => {
  test('true for selection-box chrome', () => {
    expect(hasQuestionIndicator('❯ 1. Yes\n  2. No')).toBe(true);
  });

  test('true for (y/n) and [y/n]', () => {
    expect(hasQuestionIndicator('Continue (y/n)')).toBe(true);
    expect(hasQuestionIndicator('Continue [y/n]')).toBe(true);
  });

  test('true for explicit waiting marker', () => {
    expect(hasQuestionIndicator('Waiting for input')).toBe(true);
  });

  test('FALSE for a bare question mark', () => {
    expect(hasQuestionIndicator('What is this?')).toBe(false);
  });

  test('FALSE for a plain numbered list', () => {
    expect(hasQuestionIndicator('1. First\n2. Second')).toBe(false);
    expect(hasQuestionIndicator('1) First\n2) Second')).toBe(false);
  });

  test('FALSE for plain text', () => {
    expect(hasQuestionIndicator('Just some text')).toBe(false);
  });

  test('handles ANSI codes around chrome', () => {
    expect(hasQuestionIndicator('\x1b[36m❯ 1. Yes\x1b[0m\n  2. No')).toBe(true);
  });
});

describe('parseNumberedOptions()', () => {
  test('parses multiline N) format', () => {
    const result = parseNumberedOptions('Question?\n1) Yes\n2) No');
    expect(result).not.toBeNull();
    expect(result?.questionText).toBe('Question?');
    expect(result?.options.length).toBe(2);
    expect(result?.options[0]?.label).toBe('Yes');
    expect(result?.options[0]?.value).toBe('1');
    expect(result?.options[1]?.label).toBe('No');
    expect(result?.options[1]?.value).toBe('2');
  });

  test('parses multiline N. format', () => {
    const result = parseNumberedOptions('Pick one:\n1. Alpha\n2. Beta');
    expect(result).not.toBeNull();
    expect(result?.questionText).toBe('Pick one:');
    expect(result?.options.length).toBe(2);
    expect(result?.options[0]?.label).toBe('Alpha');
    expect(result?.options[1]?.label).toBe('Beta');
  });

  test('parses inline (N) format', () => {
    const result = parseNumberedOptions('Allow? (1) Yes (2) Always (3) No');
    expect(result).not.toBeNull();
    expect(result?.questionText).toBe('Allow?');
    expect(result?.options.length).toBe(3);
    expect(result?.options[0]?.label).toBe('Yes');
    expect(result?.options[1]?.label).toBe('Always');
    expect(result?.options[2]?.label).toBe('No');
  });

  test('returns null for empty string', () => {
    expect(parseNumberedOptions('')).toBeNull();
  });

  test('returns null for text without numbered options', () => {
    expect(parseNumberedOptions('Just some plain text')).toBeNull();
  });

  test('returns null for single option', () => {
    expect(parseNumberedOptions('1) Only one')).toBeNull();
  });

  test('first option is marked recommended', () => {
    const result = parseNumberedOptions('Choose:\n1) A\n2) B');
    expect(result?.options[0]?.isRecommended).toBe(true);
    expect(result?.options[1]?.isRecommended).toBe(false);
  });

  test('handles three options with long labels', () => {
    const msg =
      "Do you want to proceed?\n1) Yes\n2) Yes, and don't ask again for this session\n3) No";
    const result = parseNumberedOptions(msg);
    expect(result).not.toBeNull();
    expect(result?.options.length).toBe(3);
    expect(result?.options[0]?.label).toBe('Yes');
    expect(result?.options[1]?.label).toBe("Yes, and don't ask again for this session");
    expect(result?.options[2]?.label).toBe('No');
  });
});
