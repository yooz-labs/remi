// Minimal compiled child that holds the original HTTP hook request and sends No.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ApprovalClientConfig {
  hookUrl: string;
  answerUrl: string;
  sessionId: string;
  questionPath: string;
  proofCommand: string;
  answerNoValue: string;
  cwd: string;
  readyPath: string;
  triggerPath: string;
  sentPath: string;
}

async function waitForFile(path: string): Promise<void> {
  const end = performance.now() + 15000;
  while (!existsSync(path) && performance.now() < end) await Bun.sleep(5);
  assert(existsSync(path), 'approval client reached its trigger');
}

export async function runApprovalClientMode(): Promise<void> {
  if (
    process.env['REMI_PASSPHRASE'] ||
    process.env['REMI_PUSH_SECRET'] ||
    process.env['TELEGRAM_BOT_TOKEN']
  )
    process.exit(9);
  const index = process.argv.indexOf('--approval-client');
  const raw = process.argv[index + 1];
  if (index < 0 || !raw) throw new Error('approval client configuration missing');
  const config = JSON.parse(raw) as ApprovalClientConfig;
  const heldRequest = fetch(config.hookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session_id: 'claude-owned-approval-proof',
      transcript_path: join(config.cwd, 'transcript.jsonl'),
      cwd: config.cwd,
      permission_mode: 'default',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: config.proofCommand },
    }),
  }).then(async (response) => {
    assert.equal(response.status, 200, 'original held PermissionRequest HTTP status');
    return response.json();
  });
  const heldOutcome = heldRequest.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await Bun.write(config.readyPath, 'held request started');
  await waitForFile(config.triggerPath);
  const questionId = readFileSync(config.questionPath, 'utf-8');

  // The child owns the timing origin: fetch invocation is the No send; stop after parsing deny JSON.
  const sendStartedAtUnixMs = Date.now();
  const started = performance.now();
  const answerRequest = fetch(config.answerUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: config.sessionId,
      questionId,
      answer: config.answerNoValue,
    }),
  });
  await Bun.write(config.sentPath, String(sendStartedAtUnixMs));
  const answerResponse = await answerRequest;
  assert.equal(answerResponse.status, 200, 'owned loopback answer adapter status');
  const answer = (await answerResponse.json()) as { outcome: string };
  const hookOutcome = await heldOutcome;
  const denyParsedAtUnixMs = Date.now();
  if ('error' in hookOutcome) throw hookOutcome.error;
  const hookResponse = hookOutcome.value as {
    hookSpecificOutput?: { decision?: { behavior?: string } };
  };
  const latencyMs = performance.now() - started;
  assert.equal(answer.outcome, 'delivered', 'real relayAnswer outcome');
  assert.equal(
    hookResponse.hookSpecificOutput?.decision?.behavior,
    'deny',
    'original held HTTP response parsed as deny',
  );
  console.log(
    JSON.stringify({
      latencyMs,
      sendStartedAtUnixMs,
      denyParsedAtUnixMs,
      answerOutcome: answer.outcome,
      hookResponse,
      proofCommand: config.proofCommand,
    }),
  );
}
