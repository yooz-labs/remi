/**
 * Shared fixtures for the #1140 handler tests: a terminal that records what
 * reaches it, and the real captured Claude permission dialog parsed by the
 * real parser. Nothing here replaces business logic; the PTY is the transport
 * boundary the daemon's own handler tests also double.
 */

import type { ErrorMessage, ProtocolMessage, UUID } from '@remi/shared';
import { generateId } from '@remi/shared';
import type { MessageAPI } from '../../../src/api/message-api.ts';
import { parseQuestion } from '../../../src/parser/question-parser.ts';
import type { PTYSession } from '../../../src/pty/pty-session.ts';
import { WRAPPED_DIRECTORY_DIALOG } from '../../parser/fixtures/claude-dialogs.ts';

export const CID = 'conn0000-0000-0000-0000-000000000000' as UUID;

export interface PtyCapture {
  writes: string[];
  submits: string[];
  /** When set, `write` throws it, as a real PTYSession does once it has exited. */
  writeError?: Error;
}

/** Records what reaches the terminal; a real PTYSession would spawn a shell. */
export function fakePTY(capture: PtyCapture): PTYSession {
  return {
    id: generateId(),
    write: (content: string) => {
      if (capture.writeError) throw capture.writeError;
      capture.writes.push(content);
    },
    submitInput: async (content: string) => {
      capture.submits.push(content);
    },
    close: async () => {},
  } as unknown as PTYSession;
}

/** Only `getFullBulletContent` is ever called on it by the handlers. */
export function fakeMessageAPI(): MessageAPI {
  return { getFullBulletContent: () => null } as unknown as MessageAPI;
}

/** The permission dialog from the #1134 reproduction, through the real parser. */
export function claudeMenu() {
  const parsed = parseQuestion(WRAPPED_DIRECTORY_DIALOG);
  if (!parsed.question) throw new Error('the captured dialog did not parse as a prompt');
  return parsed.question;
}

export function errorsOf(sent: Array<{ message: ProtocolMessage }>): ErrorMessage[] {
  return sent.map((s) => s.message).filter((m): m is ErrorMessage => m.type === 'error');
}
