/** Reuses the actual accountless Codex fixture; the whole encrypted production route is real. */
import { expect } from 'bun:test';
import {
  type ChatSubmitRequest,
  type ChatSubmitResult,
  type ProtocolMessage,
  type UUID,
  type UnlockedIdentity,
  createHello,
  generateId,
  relayV2,
} from '@remi/shared';
import type { WebSocketAdapter } from '../../../daemon/src/adapters/websocket-adapter';
import type { IdentityStore } from '../../../daemon/src/auth/identity-store';
import type { StructuredChatService } from '../../../daemon/src/cli/handlers/structured-chat-events';
import { HubRelay } from '../../../daemon/src/remote/hub-relay';
import { RelayDeviceStore } from '../../../daemon/src/remote/relay-device-store';
import type { SessionRegistry } from '../../../daemon/src/session/session-registry';
import type { SessionRegistryFile } from '../../../daemon/src/session/session-registry-file';
import { pollUntil } from '../../../daemon/tests/integration/hub-test-utils';
import { startWorker } from '../../../signaling/tests/e2e/harness';
import { RelayMachineChannel } from '../../src/lib/relay-machine-channel';
import { RelayTransport } from '../../src/lib/relay-transport';
import { StructuredChatController } from '../../src/lib/structured-chat';

interface Fixture {
  directory: string;
  trust: IdentityStore;
  identity: UnlockedIdentity;
  sessionId: UUID;
  threadId: string;
  cwd: string;
  port: number;
  liveSessions: SessionRegistryFile;
  registry: SessionRegistry;
  adapter: WebSocketAdapter;
  service: StructuredChatService;
  effects(): number;
  onMetadata(operation: () => void): void;
  nextChildConnection(): Promise<UUID>;
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runRelayChatControl(f: Fixture): Promise<string[]> {
  const oldHome = process.env['REMI_HOME'];
  const channels: RelayMachineChannel[] = [];
  let transport: RelayTransport | undefined;
  let controller: StructuredChatController | undefined;
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
  let relay: HubRelay | undefined;
  let originalFailure: unknown;
  try {
    process.env['REMI_HOME'] = f.directory;
    const checks: string[] = [];
    const devices = new RelayDeviceStore(f.directory, f.trust);
    await devices.add(f.identity.publicKeyRaw, 'owned relay chat');
    worker = await startWorker();
    const admitted = Promise.withResolvers<void>();
    const hubIdentity = await f.trust.unlock();
    relay = new HubRelay({
      relayUrl: worker.wsUrl,
      identity: hubIdentity,
      trust: f.trust,
      dir: f.directory,
      registry: f.liveSessions,
      log: (text) => {
        if (text === 'Relay control admitted') admitted.resolve();
      },
    });
    const signer = await relayV2.signerFromKey(
      f.identity.privateKey,
      new Uint8Array(Buffer.from(f.identity.publicKeyRaw, 'base64')),
    );
    const pin = {
      relayUrl: worker.wsUrl,
      machinePublicKey: Buffer.from(hubIdentity.publicKeyRaw, 'base64').toString('base64url'),
    };
    f.liveSessions.register({
      sessionId: f.sessionId,
      pid: process.pid,
      wsPort: f.port,
      hookPort: 1,
      projectPath: f.cwd,
      name: 'owned actual Codex',
      harness: 'codex',
      startedAt: new Date().toISOString(),
    });
    await relay.start();
    await bounded(admitted.promise, 'actual Worker admission');
    async function client() {
      const child = f.nextChildConnection();
      const messages: ProtocolMessage[] = [];
      const ready = Promise.withResolvers<void>();
      const closed = Promise.withResolvers<void>();
      const channel = RelayMachineChannel.resume(pin, signer, () => true, {
        onPhase: (phase) => {
          if (phase === 'connected') ready.resolve();
        },
        onMessage: (message) => messages.push(message),
        onClose: () => closed.resolve(),
      });
      channels.push(channel);
      await channel.start();
      await bounded(ready.promise, 'actual encrypted READY');
      expect(
        channel.send(createHello(generateId(), 'relay chat', { resumeSessionId: f.sessionId })),
      ).toBe(true);
      const id = await bounded(child, 'actual child connection');
      await pollUntil(
        () => messages.some((m) => m.type === 'hello_ack' && m.sessionId === f.sessionId),
        5000,
        'actual child hello',
      );
      const connection = f.adapter.getDirectConnection(id);
      expect(connection?.connectionClientPublicKey).toBeNull();
      expect(connection?.connectionClientFingerprint).toBeNull();
      expect(connection?.structuredChatProxyAuthority?.publicKey).toBe(f.identity.publicKeyRaw);
      expect(f.service.isAvailable(id)).toBe(true);
      return { channel, messages, id, closed: closed.promise };
    }
    const request = (seq: number): ChatSubmitRequest => ({
      type: 'chat_submit_request',
      id: generateId(),
      timestamp: new Date().toISOString(),
      sessionId: f.sessionId,
      seq,
      binding: { harness: 'codex', harnessSessionId: f.threadId },
      content: 'Reply only REMI_RELAY_CONTROL. Use no tools.',
    });
    async function send(
      c: Awaited<ReturnType<typeof client>>,
      value: ChatSubmitRequest,
    ): Promise<ChatSubmitResult> {
      const before = c.messages.length;
      expect(c.channel.send(value)).toBe(true);
      await pollUntil(
        () =>
          c.messages
            .slice(before)
            .some((m) => m.type === 'chat_submit_result' && m.requestId === value.id),
        5000,
        'relay correlated receipt',
      );
      const result = c.messages
        .slice(before)
        .find(
          (m): m is ChatSubmitResult => m.type === 'chat_submit_result' && m.requestId === value.id,
        );
      if (!result) throw new Error('Missing actual child receipt');
      expect(result.seq).toBe(value.seq);
      expect(result.sessionId).toBe(f.sessionId);
      return result;
    }
    const first = await client();
    const initial = f.effects();
    const one = request(1);
    const accepted = await send(first, one);
    expect(accepted).toMatchObject({ outcome: 'accepted', method: 'turn/start' });
    expect(f.effects()).toBe(initial + 1);
    expect(await send(first, one)).toEqual(accepted);
    expect(await send(first, { ...one, content: 'Changed relay input' })).toMatchObject({
      outcome: 'uncertain',
      code: 'conflict',
    });
    expect(f.effects()).toBe(initial + 1);
    expect(first.messages.some((m) => m.type === 'ack' && m.ack.messageId === one.id)).toBe(false);
    expect(
      await send(first, {
        ...request(2),
        binding: { harness: 'codex', harnessSessionId: generateId() },
      }),
    ).toMatchObject({ outcome: 'refused', code: 'binding_changed' });
    f.onMetadata(() => {
      f.registry.detachConnection(first.id);
      f.registry.attachConnection(f.sessionId, first.id);
    });
    expect(await send(first, request(3))).toMatchObject({
      outcome: 'refused',
      code: 'unavailable',
    });
    expect(await send(first, one)).toMatchObject({ outcome: 'uncertain', code: 'receipt_expired' });
    expect(f.effects()).toBe(initial + 1);
    checks.push(
      'actual encrypted Worker/hub/capability child route: original grant locked RPC, exact receipt, duplicate/conflict, binding and concrete attachment',
    );

    f.onMetadata(() => f.trust.removeAuthorizedKey(f.identity.fingerprint));
    expect(first.channel.send(request(4))).toBe(true);
    await pollUntil(() => !first.channel.connected, 5000, 'revoked relay channel retirement');
    expect(f.effects()).toBe(initial + 1);
    await f.trust.addAuthorizedKey(f.identity.publicKeyRaw, 'restored relay chat');
    expect(first.channel.send(one)).toBe(false);
    expect(f.effects()).toBe(initial + 1);
    checks.push(
      'revocation during actual metadata wait makes no RPC; regrant cannot refresh the old relay or child authority',
    );

    const second = await client();
    const beforeChildClose = f.effects();
    expect(await send(second, request(1))).toMatchObject({ outcome: 'accepted' });
    expect(f.effects()).toBe(beforeChildClose + 1);
    expect(f.adapter.closeConnection(second.id, 'owned child loss')).toBe(true);
    await pollUntil(
      () => !second.channel.connected,
      5000,
      'lost chat owner retires machine channel',
    );
    expect(second.channel.send(request(1))).toBe(false);
    expect(f.effects()).toBe(beforeChildClose + 1);
    checks.push(
      'losing the concrete child sequence owner closes the machine channel before a replacement can reset old input',
    );

    const child = f.nextChildConnection();
    const ready = Promise.withResolvers<void>();
    let bound = false;
    const generic: ProtocolMessage[] = [];
    transport = new RelayTransport(
      async (events) => RelayMachineChannel.resume(pin, signer, () => true, events),
      () => true,
      false,
      {
        onStatus: (status) => {
          if (status !== 'connected') controller?.disconnect();
        },
        onPhase: (phase) => {
          if (phase === 'connected') ready.resolve();
        },
        onMessage: (message) => {
          if (message.type === 'chat_submit_result') {
            controller?.receive(message);
            return;
          }
          if (message.type === 'hello_ack' && message.sessionId === f.sessionId) bound = true;
          generic.push(message);
        },
      },
      true,
    );
    await transport.connect();
    await bounded(ready.promise, 'web relay READY');
    expect(
      transport.send(createHello(generateId(), 'relay web', { resumeSessionId: f.sessionId })),
    ).toBe(true);
    await bounded(child, 'web relay child connection');
    await pollUntil(() => bound, 5000, 'web relay child binding');
    controller = new StructuredChatController({
      context: () =>
        transport?.structuredChatGeneration && bound
          ? {
              generation: transport.structuredChatGeneration,
              sessionId: f.sessionId,
              threadId: f.threadId,
            }
          : null,
      send: (value) => transport?.send(value) ?? false,
    });
    const beforeWeb = f.effects();
    expect(
      await controller.submit(f.sessionId, f.threadId, 'Reply only REMI_WEB_RELAY. Use no tools.'),
    ).toMatchObject({ outcome: 'accepted' });
    expect(f.effects()).toBe(beforeWeb + 1);
    expect(generic.some((m) => m.type === 'chat_submit_result')).toBe(false);
    f.onMetadata(() => devices.remove(f.identity.fingerprint));
    expect(await controller.submit(f.sessionId, f.threadId, 'Continue.')).toMatchObject({
      outcome: 'uncertain',
    });
    expect(f.effects()).toBe(beforeWeb + 1);
    await devices.add(f.identity.publicKeyRaw, 'restored enrollment');
    expect(controller.canSubmit(f.sessionId, f.threadId)).toBe(false);
    checks.push(
      'shipping relay transport/controller admits one explicit input; enrollment loss stays uncertain with no replay or restored authority on the old generation',
    );
    return checks;
  } catch (error) {
    originalFailure = error;
    throw error;
  } finally {
    controller?.dispose();
    transport?.disconnect();
    const results = await Promise.allSettled([
      ...channels.map((channel) => channel.close()),
      relay?.stop(),
    ]);
    try {
      await worker?.stop();
    } finally {
      if (oldHome === undefined) {
        // biome-ignore lint/performance/noDelete: restore absence rather than an environment string
        delete process.env['REMI_HOME'];
      } else process.env['REMI_HOME'] = oldHome;
    }
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failures.length)
      // biome-ignore lint/correctness/noUnsafeFinally: retain both the original failure and owned cleanup errors
      throw new AggregateError(
        [
          ...(originalFailure === undefined ? [] : [originalFailure]),
          ...failures.map((result) => result.reason),
        ],
        'Owned relay fixture cleanup failed',
      );
  }
}
