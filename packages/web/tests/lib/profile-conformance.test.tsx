import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ProtocolMessage, SessionProfilesResponseMessage } from '@remi/shared/protocol.ts';
import { createHello, generateId } from '@remi/shared';
import { createSessionProfilesHandlers } from '../../../daemon/src/cli/handlers/session-profiles-events.ts';
import { WebSocketAdapter } from '../../../daemon/src/adapters/websocket-adapter.ts';
import { reserveRange } from '../../../daemon/tests/session/port-test-helpers.ts';
import { currentProfilesStrict } from '../../../daemon/src/profiles/current-profiles.ts';
import { WebSocketClient } from '../../src/lib/websocket-client.ts';
import { ProfilePicker } from '../../src/components/session/ProfilePicker';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate() && Date.now() - start < timeoutMs) await wait(10);
  if (!predicate()) throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
}

describe('profile lookup conformance: daemon handler to web picker', () => {
  let root: string;
  let adapter: WebSocketAdapter;
  let client: WebSocketClient;
  let port: number;
  let connectionId: string | null = null;
  const received: ProtocolMessage[] = [];

  beforeAll(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remi-profile-web-conformance-')));
    const work = path.join(root, 'work');
    const quiet = path.join(root, 'quiet');
    fs.mkdirSync(work);
    fs.mkdirSync(quiet);
    const config = path.join(root, 'config.toml');
    fs.writeFileSync(
      config,
      `[profiles.work]\nlabel="Work"\nfolders=["${work}"]\nremote_selectable=true\nremote_visible=true\n[profiles.work.claude]\nexpects="subscription"\n\n` +
        `[profiles.quiet]\nlabel="Quiet"\nfolders=["${quiet}"]\nremote_selectable=false\nremote_visible=true\n[profiles.quiet.claude]\nexpects="subscription"\n`,
    );

    const handler = createSessionProfilesHandlers({
      profiles: () => currentProfilesStrict(config),
      send: (target, message) => adapter.sendRaw(target, message),
    });

    port = await reserveRange(1);
    adapter = new WebSocketAdapter(
      { port },
      {
        onConnect: (id) => (connectionId = id),
        onSessionProfilesRequest: (id, requestId, directory) =>
          handler.onSessionProfilesRequest(id, requestId, directory),
      },
    );
    await adapter.start();

    client = new WebSocketClient(
      { url: `ws://localhost:${port}/ws`, heartbeatInterval: 0, connectionTimeout: 2000 },
      {
        onMessage: (message) => {
          received.push(message);
        },
      },
    );
    client.connect();
    await waitFor(() => client.isConnected || client.isTransportOpen);
    client.send(createHello(generateId(), '0.0.0-test'));
    await waitFor(() => connectionId !== null);
  });

  afterAll(async () => {
    client?.disconnect();
    await adapter?.stop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  test('the real handler response is decoded by the real web client and preselects its default', async () => {
    if (!connectionId) throw new Error('missing WebSocketAdapter connection');
    const requestId = generateId();
    client.send({
      type: 'session_profiles_request',
      id: requestId,
      timestamp: new Date().toISOString(),
      directory: path.join(root, 'work'),
    });
    await waitFor(() =>
      received.some((message) => message.type === 'session_profiles_response' && message.requestId === requestId),
    );
    const response = received.find(
      (message): message is SessionProfilesResponseMessage =>
        message.type === 'session_profiles_response' && message.requestId === requestId,
    );
    if (!response) throw new Error('missing decoded profile response');
    const markup = renderToStaticMarkup(
      <ProfilePicker
        loading={false}
        response={response}
        onSelectProfile={() => {}}
        onStart={() => {}}
      />,
    );
    expect(response.default).toEqual({ id: 'work', source: 'folder' });
    expect(markup).toContain('<option value="work" selected="">Work</option>');
    expect(markup).toContain("From this folder&#x27;s mapping");
    expect(markup).not.toContain('Quiet');
  });

  test('a mapped non-selectable profile becomes the choose state', async () => {
    if (!connectionId) throw new Error('missing WebSocketAdapter connection');
    const requestId = generateId();
    client.send({
      type: 'session_profiles_request',
      id: requestId,
      timestamp: new Date().toISOString(),
      directory: path.join(root, 'quiet'),
    });
    await waitFor(() =>
      received.some((message) => message.type === 'session_profiles_response' && message.requestId === requestId),
    );
    const response = received.find(
      (message): message is SessionProfilesResponseMessage =>
        message.type === 'session_profiles_response' && message.requestId === requestId,
    );
    if (!response) throw new Error('missing decoded profile response');
    const markup = renderToStaticMarkup(
      <ProfilePicker
        loading={false}
        response={response}
        onSelectProfile={() => {}}
        onStart={() => {}}
      />,
    );
    expect(response.default).toBeUndefined();
    expect(markup).toContain('Choose a profile.');
    expect(markup).toMatch(/<button\b[^>]*disabled=""/);
    expect(markup).not.toContain('Quiet');
  });

  test('an invalid directory refusal renders the web refusal state', async () => {
    if (!connectionId) throw new Error('missing WebSocketAdapter connection');
    const requestId = generateId();
    client.send({
      type: 'session_profiles_request',
      id: requestId,
      timestamp: new Date().toISOString(),
      directory: 'bad\npath',
    });
    await waitFor(() =>
      received.some((message) => message.type === 'session_profiles_response' && message.requestId === requestId),
    );
    const response = received.find(
      (message): message is SessionProfilesResponseMessage =>
        message.type === 'session_profiles_response' && message.requestId === requestId,
    );
    if (!response) throw new Error('missing decoded profile response');
    const markup = renderToStaticMarkup(
      <ProfilePicker
        loading={false}
        response={response}
        onSelectProfile={() => {}}
        onStart={() => {}}
      />,
    );
    expect(response.refused).toBe('directory_invalid');
    expect(markup).toContain('That folder is not a valid directory on this machine.');
    expect(markup).toContain('disabled=""');
  });
});
