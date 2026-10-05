/**
 * What a Codex message says about where to answer or look (#1179 review, G12).
 *
 * A wrapper session has the person's own terminal. A session a hub starts, or that `remi codex
 * --daemon` runs, has none: Codex runs in a PTY nobody watches, and `remi attach` is the only way
 * to reach it. A message that sends the person to "the terminal" there sends them looking for one
 * that does not exist, so each message takes its wording from here. The phrases are written to
 * read in their sentences: "Answer it {where}.", "check {look}", "{works}".
 */

import { attachCommand } from './attach-hint.ts';

export interface TerminalWords {
  /** "Answer it {where}." and "or answer {where}". */
  readonly where: string;
  /** "check {look}". */
  readonly look: string;
  /** What a link notice says of the session itself. */
  readonly works: string;
  /** The notice for a session that never learns its Codex thread. */
  readonly noThread: string;
}

/** A session with a terminal: the wording these messages had before there was another. */
export const TERMINAL: TerminalWords = {
  where: 'in the terminal',
  look: 'the terminal',
  works: 'the session still works in the terminal',
  noThread: "remi could not find this session's Codex thread",
};

/**
 * A session with no terminal, named by the address `remi attach` accepts. A thread that never
 * binds is as likely an Update or Trust prompt that only a terminal can answer as anything else
 * (Codex stops at one before it creates a thread), so the text says so.
 */
export function attachWords(port: number, sessionId: string): TerminalWords {
  const command = `\`${attachCommand(port, sessionId)}\``;
  return {
    where: `with ${command}`,
    look: `the session with ${command}`,
    works: `the session still runs, and ${command} shows it`,
    noThread: `remi could not find this session's Codex thread: Codex may be waiting at an Update or Trust prompt that only a terminal can answer; ${command} shows it`,
  };
}
