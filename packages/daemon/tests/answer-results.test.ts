import { expect, test } from 'bun:test';
import { createAnswer } from '@remi/shared';
import { AnswerResults } from '../src/server/answer-results.ts';

test('correlated actual answer outcome is shared once; changed content conflicts and retained identity is constant size', async () => {
  const results = new AnswerResults();
  const message = createAnswer('session', 'question', 'PRIVATE_CHOICE_SENTINEL'.repeat(2000));
  let count = 0;
  let resolve!: (value: 'stale-binding') => void;
  const decision = new Promise<'stale-binding'>((done) => {
    resolve = done;
  });
  const apply = () => {
    count++;
    return decision;
  };
  const first = results.run(message, false, apply);
  const duplicate = results.run(message, true, apply);
  const conflict = await results.run({ ...message, answer: 'different' }, true, apply);
  expect(conflict.outcome).toBe('conflict');
  resolve('stale-binding');
  const [a, b] = await Promise.all([first, duplicate]);
  expect(count).toBe(1);
  expect(a.outcome).toBe('stale-binding');
  expect(b.outcome).toBe('stale-binding');
  expect(a.requestId).toBe(message.id);
  const entries = (results as unknown as { entries: Map<string, { content: string }> }).entries;
  expect(entries.get(message.id)?.content).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify([...entries])).not.toContain('PRIVATE_CHOICE_SENTINEL');
});
test('in-flight cap is explicit and forgotten completed duplicate never invents delivery', async () => {
  const results = new AnswerResults();
  let finish!: (value: 'delivered') => void;
  const held = new Promise<'delivered'>((resolve) => {
    finish = resolve;
  });
  const inflight = Array.from({ length: 32 }, (_, i) =>
    results.run(createAnswer('session', String(i), 'yes'), false, () => held),
  );
  expect(
    (await results.run(createAnswer('session', 'overflow', 'yes'), false, () => held)).outcome,
  ).toBe('busy');
  finish('delivered');
  await Promise.all(inflight);
  const oldest = createAnswer('session', 'oldest', 'yes');
  await results.run(oldest, false, async () => 'delivered');
  for (let i = 0; i < 256; i++)
    await results.run(createAnswer('session', String(i), 'yes'), false, async () => 'delivered');
  expect((await results.run(oldest, true, async () => 'delivered')).outcome).toBe('uncertain');
});
