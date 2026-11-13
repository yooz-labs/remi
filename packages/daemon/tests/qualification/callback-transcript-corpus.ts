/**
 * #1727 synthetic qualification only. Generates no owner/session data.
 * Uses the real Claude bridge and real Codex chat + AppServerClient against an
 * owned fake UNIX-socket peer. Sample sizes are observations, not protocol limits.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { ProtocolMessage, TranscriptContentMessage, UUID } from '@remi/shared';
import { MessageAPI } from '../../src/api/message-api.ts';
import { AppServerClient } from '../../src/harness/codex/app-server-client.ts';
import { createCodexChat } from '../../src/harness/codex/codex-chat.ts';
import { TranscriptMessageBridge } from '../../src/transcript/transcript-message-bridge.ts';
import type { AssistantEntry, UserEntry } from '../../src/transcript/types.ts';
import { agentMessageItem, itemsListPage, userMessageItem } from '../helpers/codex-threads.ts';
import { FakeAppServer } from '../helpers/fake-app-server.ts';

const allowedParent = '/Volumes/S1/yooz/remi/artifacts/callback-order-1727-20261031';
const output = process.argv[2] ? resolve(process.argv[2]) : '';
if (!output || realpathSync(dirname(output)) !== realpathSync(allowedParent)) {
  throw new Error('An owned, new child directory of the #1727 artifact root is required');
}
mkdirSync(output, { recursive: false, mode: 0o700 });
const SID = '00000000-0000-4000-8000-000000000001' as UUID;
const THREAD = '00000000-0000-7000-8000-000000000001';
const samples = [
  { name: 'short', text: 'Owned synthetic conversation.' },
  { name: 'ascii-1k', text: 'x'.repeat(1024) },
  { name: 'ascii-32k', text: 'x'.repeat(32_768) },
  { name: 'ascii-128k', text: 'x'.repeat(131_072) },
  { name: 'unicode-escapes', text: 'é🙂\\"\n'.repeat(2048) },
  {
    name: 'many-bullets',
    text: Array.from({ length: 1024 }, (_, i) => `- synthetic item ${i}`).join('\n'),
  },
] as const;
const sha = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
function shape(value: unknown): { nodes: number; depth: number } {
  let nodes = 0;
  let depth = 0;
  const pending: Array<[unknown, number]> = [[value, 1]];
  while (pending.length) {
    const [item, level] = pending.pop()!;
    nodes++;
    depth = Math.max(depth, level);
    if (Array.isArray(item)) for (const child of item) pending.push([child, level + 1]);
    else if (item !== null && typeof item === 'object') {
      for (const child of Object.values(item)) pending.push([child, level + 1]);
    }
  }
  return { nodes, depth };
}
const corpus: Array<{ source: string; sample: string; message: TranscriptContentMessage }> = [];
for (const sample of samples) {
  for (const role of ['user', 'assistant'] as const) {
    const emitted: TranscriptContentMessage[] = [];
    const bridge = new TranscriptMessageBridge(
      { sessionId: SID },
      new MessageAPI({ sessionId: SID }),
      {
        onTranscriptContent: (message) => emitted.push(message),
      },
    );
    const base = {
      uuid: crypto.randomUUID(),
      parentUuid: null,
      sessionId: SID,
      timestamp: '2026-10-31T00:00:00.000Z',
    };
    if (role === 'user') {
      const entry: UserEntry = { ...base, type: 'user', message: { role, content: sample.text } };
      bridge.handleUserEntry(entry);
    } else {
      const entry: AssistantEntry = {
        ...base,
        type: 'assistant',
        message: {
          role,
          model: 'synthetic',
          content: [
            { type: 'text', text: sample.text },
            { type: 'tool_use', id: 'owned-tool', name: 'Read', input: { path: 'synthetic' } },
          ],
        },
      };
      bridge.handleAssistantEntry(entry);
    }
    if (emitted.length !== 1)
      throw new Error(`Claude source did not emit exactly one ${sample.name}/${role} message`);
    corpus.push({ source: `claude-${role}`, sample: sample.name, message: emitted[0]! });
  }
}
const server = FakeAppServer.start();
let ready = false;
const client = new AppServerClient(
  {
    socketPath: () => readlinkSync(server.linkPath),
    clientInfo: { name: 'remi', title: null, version: 'synthetic' },
    backoff: { initialMs: 5, maxMs: 20 },
    log: () => {},
  },
  (event) => {
    if (event.type === 'ready') ready = true;
  },
);
try {
  client.start();
  await server.waitFor(() => ready, 'owned client readiness');
  const entries = samples.flatMap((sample) => [
    { item: userMessageItem(`owned-user-${sample.name}`, sample.text) },
    { item: agentMessageItem(`owned-agent-${sample.name}`, sample.text, 'final_answer') },
  ]);
  server.onRequest('thread/items/list', () => itemsListPage(entries, null));
  const sent: ProtocolMessage[] = [];
  const chat = createCodexChat({
    sessionId: SID,
    client,
    threadId: () => THREAD,
    threadRole: (id) => (id === THREAD ? 'main' : null),
    messageApi: new MessageAPI({ sessionId: SID }),
    sendAndRecord: (message) => sent.push(message),
    log: () => {},
  });
  try {
    const messages: TranscriptContentMessage[] = [];
    const count = await chat.readHistory((message) => messages.push(message));
    if (count !== entries.length || messages.length !== entries.length)
      throw new Error('Codex source emitted an unexpected count');
    for (let i = 0; i < samples.length; i++) {
      corpus.push({ source: 'codex-user', sample: samples[i]!.name, message: messages[2 * i]! });
      corpus.push({
        source: 'codex-assistant',
        sample: samples[i]!.name,
        message: messages[2 * i + 1]!,
      });
    }
  } finally {
    chat.dispose();
  }
} finally {
  client.stop();
  await server.stop();
}
const records = corpus.flatMap(({ source, sample, message }, index) => {
  const expectedText = samples.find((candidate) => candidate.name === sample)?.text;
  const expectedRole = source.endsWith('-user') ? 'user' : 'assistant';
  if (message.content !== expectedText || message.role !== expectedRole) {
    throw new Error(`Source changed or reordered synthetic content for ${source}/${sample}`);
  }
  const normal = JSON.stringify(message);
  if (!normal.startsWith('{"type":'))
    throw new Error('Expected source root type first for the escape control');
  const variants = {
    normal,
    reversed: JSON.stringify(Object.fromEntries(Object.entries(message).reverse())),
    escapedTypeKey: normal.replace('{"type":', '{"\\u0074ype":'),
  };
  return Object.entries(variants).map(([variant, serialized]) => {
    const bytes = Buffer.from(serialized);
    const name = `${String(index).padStart(2, '0')}-${source}-${sample}-${variant}.json`;
    writeFileSync(`${output}/${name}`, bytes, { mode: 0o600 });
    return {
      name,
      source,
      sample,
      variant,
      bytes: bytes.length,
      sha256: sha(bytes),
      role: message.role,
      contentSha256: sha(message.content),
      ...shape(message),
    };
  });
});
writeFileSync(
  `${output}/manifest.json`,
  JSON.stringify({ version: 1, syntheticOnly: true, records }, null, 2),
  { mode: 0o600 },
);
process.stdout.write(
  `${JSON.stringify({
    samples: samples.length,
    records: records.length,
    minBytes: Math.min(...records.map((r) => r.bytes)),
    maxBytes: Math.max(...records.map((r) => r.bytes)),
    overFamilyLimit: records.filter((r) => r.bytes > 65_536).length,
  })}\n`,
);
