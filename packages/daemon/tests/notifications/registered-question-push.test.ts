/** Real registry, PTY, sender and owned HTTP receiver; no APNs or owner state. */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type QuestionMessage, generateId } from '@remi/shared';
import { MessageAPI } from '../../src/api/message-api.ts';
import {
  NotificationDispatcher,
  buildSecurePushText,
  pushCategoryFor,
} from '../../src/notifications/notification-dispatcher.ts';
import { PTYSession } from '../../src/pty/pty-session.ts';
import { SessionRegistry } from '../../src/session/session-registry.ts';

async function fixture(name: string): Promise<QuestionMessage> {
  return Bun.file(
    new URL(`../../../shared/tests/fixtures/protocol/${name}.json`, import.meta.url),
  ).json();
}

test('attached session still delivers once through the real registered-device sender', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'remi-registered-push-'));
  const requests: unknown[] = [];
  const receiver = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      requests.push(await request.json());
      return Response.json({ success: true });
    },
  });
  const registry = new SessionRegistry({ orphanTimeoutMs: 60_000 });
  const pty = new PTYSession({ command: '/bin/cat', cwd: directory });
  try {
    await pty.start();
    const sessionId = generateId();
    registry.registerSession(sessionId, directory, pty, new MessageAPI({ sessionId }));
    expect(registry.attachConnection(sessionId, generateId()).success).toBe(true);
    const token = crypto.randomUUID();
    const dispatcher = new NotificationDispatcher(
      {
        sessionRegistry: registry,
        deviceTokens: new Map([
          [
            token,
            {
              token,
              platform: 'ios',
              registeredAt: Date.now(),
              connectionId: generateId(),
            },
          ],
        ]),
        pushConfig: () => ({
          signalingUrl: receiver.url.origin,
          pushSecret: 'owned-test-secret',
          legacyEnabled: true,
          authorityDirectory: directory,
        }),
        getPrimarySessionId: () => sessionId,
      },
      sessionId,
    );
    const { question } = await fixture('question');
    expect(await dispatcher.maybePush(sessionId, question)).toBe('pushed');
    expect(requests).toHaveLength(1);
    expect(await dispatcher.maybePush(sessionId, question)).toBe('deduped');
    expect(requests).toHaveLength(1);
  } finally {
    await registry.shutdown();
    await pty.close();
    await receiver.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('secure plan preview is concise while the in-app plan stays intact', async () => {
  const { question } = await fixture('question_claude_plan_approval');
  const original = JSON.stringify(question);
  expect(pushCategoryFor(question)).toBeUndefined();
  const preview = buildSecurePushText('Owned session', question);
  expect(preview.body).toBe('Plan ready for review. Open Remi to approve or keep planning.');
  expect(preview.body.length).toBeLessThanOrEqual(160);
  expect(JSON.stringify(question)).toBe(original);
});

test('one-tap permissions keep the complete signed ask and original options', async () => {
  for (const name of ['question_claude_permission', 'question_codex_command']) {
    const { question } = await fixture(name);
    const original = JSON.stringify(question);
    expect(pushCategoryFor(question)).toBe('REMI_YN');
    expect(buildSecurePushText('Owned session', question).body).toBe(question.text);
    expect(JSON.stringify(question)).toBe(original);
  }
});
