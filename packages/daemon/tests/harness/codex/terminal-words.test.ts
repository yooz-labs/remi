/**
 * What a Codex message says about where to answer or look (#1179 review, G12). A wrapper session
 * has the person's own terminal; a session a hub or `remi codex --daemon` starts has none, and
 * `remi attach` is the only way to reach it. Claiming a terminal that does not exist sends the
 * person looking for it.
 */

import { describe, expect, test } from 'bun:test';
import { TERMINAL, attachWords } from '../../../src/harness/codex/terminal-words.ts';

const SESSION_ID = '55555555-5555-4555-8555-555555555555';
const ADDRESS = '`remi attach <host>:19999/55555555`';

describe('TERMINAL, the wording of a session with a terminal', () => {
  test('is the wording these messages have always had', () => {
    expect(TERMINAL).toEqual({
      where: 'in the terminal',
      look: 'the terminal',
      works: 'the session still works in the terminal',
      noThread: "remi could not find this session's Codex thread",
    });
  });
});

describe('attachWords, the wording of a session with none', () => {
  const words = attachWords(19999, SESSION_ID);

  test('every phrase names this session by the address remi attach accepts', () => {
    for (const phrase of Object.values(words)) expect(phrase).toContain(ADDRESS);
  });

  test('the phrases read in the sentences they are put in', () => {
    expect(`Answer it ${words.where}.`).toBe(`Answer it with ${ADDRESS}.`);
    expect(`check ${words.look}`).toBe(`check the session with ${ADDRESS}`);
    expect(words.works).toBe(`the session still runs, and ${ADDRESS} shows it`);
  });

  test('nothing in them claims a terminal the session does not have', () => {
    for (const phrase of Object.values(words)) {
      expect(phrase).not.toContain('in the terminal');
      expect(phrase).not.toContain('the terminal');
    }
  });

  test('the missing-thread text also says it may be an Update or Trust prompt, which only a terminal answers', () => {
    expect(words.noThread).toStartWith("remi could not find this session's Codex thread");
    expect(words.noThread).toContain('Update or Trust prompt');
  });
});
