/**
 * Behavioral pins (#1223): a session's pushed cards are dismissed when it
 * really closes, and the dismissals reach the phone before the daemon exits.
 *
 * `SessionRegistry.closeSession` clears the session before it announces the
 * close, so nothing could look the session's cards up to dismiss them; and a
 * daemon whose agent exits closes its session and exits within milliseconds,
 * before a push in flight leaves. Both left the card on the lock screen.
 * Setup: `daemon-with-phone.ts` (the real daemon, a fake claude, a recording
 * signaling stand-in, a device token over the real WebSocket).
 */

import { afterEach, describe, test } from 'bun:test';
import {
  closeSession,
  dismissals,
  heldPrompt,
  postHook,
  pushedCardId,
  startWithPhone,
  stopAll,
} from './daemon-with-phone.ts';
import { pollUntil } from './hub-test-utils.ts';

afterEach(stopAll);

describe('a real session close dismisses its pushed cards (#1223)', () => {
  test('a held prompt: the card is dismissed on the lock screen and in the app', async () => {
    const r = await startWithPhone();
    const response = heldPrompt(r);
    const id = await pushedCardId(r);

    await closeSession(r);

    await pollUntil(() => dismissals(r, id).length > 0, 8000, 'the dismissal of the pushed card');
    await pollUntil(
      () =>
        r.received.some(
          (m) => m.type === 'question_resolved' && (m as { questionId?: string }).questionId === id,
        ),
      8000,
      'the in-app resolution of the card',
    );
    await response;
  }, 60000);

  test('the daemon waits for a slow dismissal before it exits: a retried delivery still lands', async () => {
    // The first dismissal is refused with a 503, so its delivery needs the
    // retry 400 ms later; a daemon that exited right after the close never
    // sent it.
    let refused = false;
    const r = await startWithPhone({
      respond: (body) => {
        if (body.kind === 'dismiss' && !refused) {
          refused = true;
          return 503;
        }
        return 200;
      },
    });
    const response = heldPrompt(r);
    const id = await pushedCardId(r);

    await closeSession(r);

    await pollUntil(() => dismissals(r, id).length >= 2, 8000, 'the retried dismissal');
    await response;
  }, 60000);

  test('a card the permission relay does not track (an MCP elicitation) is dismissed too', async () => {
    const r = await startWithPhone();
    // A card that is not held is pushed only to a phone with no client
    // attached, so the phone's app goes to the background first.
    r.ws.close();
    await pollUntil(
      () => r.output.text.includes('Client disconnected'),
      8000,
      'the client to disconnect',
    );
    void postHook(r, {
      hook_event_name: 'Elicitation',
      mcp_server_name: 'weather-mcp',
      message: 'Which city?',
      mode: 'form',
      elicitation_id: 'elicit-1223',
      requested_schema: { type: 'object', properties: { city: { type: 'string' } } },
    });
    const id = await pushedCardId(r);

    await closeSession(r);

    await pollUntil(() => dismissals(r, id).length > 0, 8000, 'the dismissal of the pushed card');
  }, 60000);
});
