import { expect, test } from 'bun:test';
import { createIdentity, unlockIdentity } from '@remi/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApprovalNeeded } from '../../src/components/session/ApprovalNeeded';
import { ConnectionApproval } from '../../src/lib/connection-approval';

test('renders local approval instructions with own public fingerprint and retry (#873)', async () => {
  const identity = await unlockIdentity(await createIdentity());
  const state = new ConnectionApproval();
  const attempt = await state.begin(identity, 'ws://localhost:18765');
  state.refuse(attempt, 'UNKNOWN_KEY');
  if (!state.snapshot) throw new Error('No approval snapshot');
  const html = renderToStaticMarkup(
    <ApprovalNeeded approval={state.snapshot} host="localhost:18765" onRetry={() => {}} />,
  );
  for (const text of [
    'Approval needed',
    identity.fingerprint,
    `remi authorize ${identity.fingerprint}`,
    'Copy public JSON',
    'Retry',
    'daemon machine',
    'remi keys',
    '10 minutes',
  ])
    expect(html).toContain(text);
  expect(html).not.toContain('privateKey');
  state.refuse(attempt, 'PENDING_QUEUE_FULL');
  if (!state.snapshot) throw new Error('No queue-full snapshot');
  const full = renderToStaticMarkup(
    <ApprovalNeeded approval={state.snapshot} host="localhost:18765" />,
  );
  expect(full).toContain('request was not saved');
  expect(full).not.toContain('Copy command');
});
