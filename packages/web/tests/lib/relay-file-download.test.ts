/** Actual pull owner over shipping relay transport, source Worker/Hub and strict file child. */
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { type ProtocolMessage, createHello, generateId, now, relayV2 } from '@remi/shared';
import {
  relayFileDownloadFixture,
  until,
} from '../../../daemon/tests/helpers/file-download-ingress-fixture.ts';
import { RelayFileDownloads } from '../../src/lib/relay-file-download';
import { RelayMachineChannel } from '../../src/lib/relay-machine-channel';
import { RelayTransport } from '../../src/lib/relay-transport';

for (const harness of ['claude', 'codex'] as const) {
  test(`actual ${harness} relay download verifies explicit bytes, cancels and requires a fresh attachment`, async () => {
    const f = await relayFileDownloadFixture({ harness });
    const channels: RelayMachineChannel[] = [];
    const received: ProtocolMessage[] = [];
    const errors: unknown[] = [];
    const proofs = new Map<
      string,
      {
        harness: string;
        threadId: string | null;
        capabilities: readonly string[];
        protocolVersion: unknown;
        attachState: 'attached' | 'queued' | undefined;
        readonly helloId: string;
        readonly attachment: object;
      }
    >();
    const consumerPid = f.pty.childPid;
    let live = true;
    let transport: RelayTransport | undefined;
    let owner: RelayFileDownloads | undefined;
    try {
      const signer = await relayV2.signerFromKey(
        f.identity.privateKey,
        new Uint8Array(Buffer.from(f.identity.publicKeyRaw, 'base64')),
      );
      const pin = { relayUrl: f.worker.wsUrl, machinePublicKey: relayV2.b64u(f.machinePublicKey) };
      const client = new RelayTransport(
        async (events) => {
          const channel = RelayMachineChannel.resume(pin, signer, () => live, events);
          channels.push(channel);
          return channel;
        },
        () => live,
        false,
        {
          onStatus(status) {
            if (status !== 'connected') {
              proofs.clear();
              owner?.disconnect();
            }
          },
          onMessage(message) {
            received.push(message);
            // Match the manager's bounded metadata capture only after the shipping
            // channel verifies and strictly decodes the original plaintext.
            if (message.type === 'hello_ack' && message.sessionId) {
              const previous = proofs.get(message.sessionId);
              const proof = {
                helloId: message.id,
                attachment: previous?.helloId === message.id ? previous.attachment : {},
                harness: message.harness ?? 'claude',
                threadId: message.harnessSessionId ?? message.claudeSessionId ?? null,
                capabilities: Array.isArray(message.capabilities)
                  ? message.capabilities.filter((c): c is string => typeof c === 'string')
                  : [],
                protocolVersion: message.protocolVersion as unknown,
                attachState: message.attachState,
              };
              if (proofs.has(message.sessionId) || proofs.size < 64)
                proofs.set(message.sessionId, proof);
            }
            owner?.receive(message);
          },
          onError: (error) => errors.push(error),
        },
        true,
      );
      transport = client;
      const downloads = new RelayFileDownloads(
        {
          context: () => {
            const generation = client.structuredChatGeneration;
            if (!live || !client.isConnected || !generation) return null;
            return {
              connection: client,
              generation,
              // This owner has one newly generated identity, never replaced in this case.
              identityRevision: 0,
              identityKey: f.identity.publicKeyRaw,
            };
          },
          proof: (id) => proofs.get(id)?.attachment,
          proofs: () => [...proofs].map(([id, value]) => [id, value.attachment] as const),
          webSocketUrl: pin.relayUrl,
          send: (request, generation) =>
            live && generation === client.structuredChatGeneration && client.send(request),
        },
        () => {},
      );
      owner = downloads;
      await client.connect();
      await until(() => client.isConnected, 'shipping relay verified ready');
      expect(proofs.size).toBe(0);
      expect(downloads.availableSessions).toEqual([]);
      expect(f.invocations).toHaveLength(0);
      // The real hub Connection has its own initial hello deadline, separate from
      // the completed encrypted handshake and any selected child's hello.
      expect(client.send(createHello(generateId(), 'owned component'))).toBe(true);
      expect(
        client.send(createHello(generateId(), 'owned component', { resumeSessionId: f.sessionId })),
      ).toBe(true);
      await until(
        () => downloads.availableSessions.includes(f.sessionId),
        'actual attached child hello',
      );
      const proof = proofs.get(f.sessionId);
      expect(proof).toMatchObject({
        harness,
        threadId: f.binding.harnessSessionId,
        attachState: 'attached',
      });
      expect(proof?.capabilities).toContain('file_download');
      expect(downloads.controller.state.phase).toBe('idle');
      expect(downloads.controller.copyVerifiedFile()).toBeNull();
      expect(f.invocations).toHaveLength(0);

      const unknownSession = generateId();
      expect(downloads.start(unknownSession, 'sample.bin')).toBe(false);
      const beforeUnknown = f.invocations.length;
      const unknownRequest = {
        type: 'file_fetch_begin' as const,
        id: generateId(),
        timestamp: now(),
        sessionId: unknownSession,
        binding: f.binding,
        relativePath: 'sample.bin',
      };
      expect(client.send(unknownRequest)).toBe(true);
      await until(
        () =>
          received.some(
            (message) =>
              message.type === 'file_fetch_refused' &&
              message.code === 'unavailable' &&
              message.operation === unknownRequest.type &&
              message.requestId === unknownRequest.id &&
              message.sessionId === unknownSession,
          ),
        'actual unknown-session refusal',
      );
      expect(f.invocations).toHaveLength(beforeUnknown);

      for (const bytes of [Buffer.from([71]), Buffer.alloc(32768, 97)]) {
        f.write(bytes);
        const before = received.length;
        expect(downloads.start(f.sessionId, 'sample.bin')).toBe(true);
        await until(() => downloads.controller.state.phase === 'ready', 'actual verified download');
        const accepted = received
          .slice(before)
          .find((message) => message.type === 'file_fetch_accepted');
        expect(accepted).toMatchObject({
          byteLength: bytes.length,
          digest: createHash('sha256').update(bytes).digest('base64url'),
        });
        expect(downloads.controller.copyVerifiedFile()?.bytes).toEqual(new Uint8Array(bytes));
        const copy = downloads.controller.copyVerifiedFile();
        if (!copy) throw Error('Verified actual copy missing');
        copy.bytes.fill(0);
        expect(downloads.controller.copyVerifiedFile()?.bytes).toEqual(new Uint8Array(bytes));
        expect(downloads.busySessionId).toBe(f.sessionId);
        const beforeCachedHello = received.length;
        const attachment = proofs.get(f.sessionId)?.attachment;
        expect(
          client.send(
            createHello(generateId(), 'owned cached selection', { resumeSessionId: f.sessionId }),
          ),
        ).toBe(true);
        await until(
          () =>
            received
              .slice(beforeCachedHello)
              .some((message) => message.type === 'hello_ack' && message.sessionId === f.sessionId),
          'actual cached child selection hello',
        );
        expect(proofs.get(f.sessionId)?.attachment).toBe(attachment);
        expect(downloads.controller.state.phase).toBe('ready');
        expect(downloads.controller.copyVerifiedFile()?.bytes).toEqual(new Uint8Array(bytes));
        if (bytes.length === 1) downloads.controller.dismiss();
      }

      const generation = client.structuredChatGeneration;
      const beforeClose = f.invocations.length;
      const prior = channels.at(-1);
      if (!prior) throw Error('Actual channel missing');
      await prior.close();
      await until(() => !client.isConnected, 'actual channel closed');
      expect(downloads.availableSessions).toEqual([]);
      expect(downloads.controller.copyVerifiedFile()).toBeNull();
      expect(downloads.start(f.sessionId, 'sample.bin')).toBe(false);
      client.forceReconnect();
      await until(
        () => client.isConnected && client.structuredChatGeneration !== generation,
        'actual replacement channel verified',
      );
      expect(channels).toHaveLength(2);
      expect(downloads.availableSessions).toEqual([]);
      expect(downloads.controller.copyVerifiedFile()).toBeNull();
      expect(f.invocations).toHaveLength(beforeClose);
      expect(client.send(createHello(generateId(), 'owned fresh hub'))).toBe(true);
      expect(
        client.send(
          createHello(generateId(), 'owned component fresh', { resumeSessionId: f.sessionId }),
        ),
      ).toBe(true);
      await until(
        () => downloads.availableSessions.includes(f.sessionId),
        'fresh actual attachment',
      );
      expect(proofs.get(f.sessionId)).not.toBe(proof);
      expect(downloads.controller.copyVerifiedFile()).toBeNull();
      expect(f.invocations).toHaveLength(beforeClose);

      f.write(Buffer.alloc(32768, 99));
      const beforeCancel = f.invocations.length;
      const beforeCancelMessages = received.length;
      expect(downloads.start(f.sessionId, 'sample.bin')).toBe(true);
      expect(downloads.controller.state.phase).toBe('preparing');
      downloads.controller.cancel();
      expect(downloads.controller.copyVerifiedFile()).toBeNull();
      await until(
        () => downloads.controller.state.phase === 'cancelled',
        'actual preparation cancellation',
      );
      const requests = f.invocations
        .slice(beforeCancel)
        .flatMap((value) => (value.kind === 'request' ? [value.request] : []));
      const begin = requests.find((request) => request.type === 'file_fetch_begin');
      const cancel = requests.find((request) => request.type === 'file_fetch_cancel');
      if (!begin || !cancel) throw Error('Actual begin/cancel did not reach strict service');
      expect(cancel.beginId).toBe(begin.id);
      expect(
        received
          .slice(beforeCancelMessages)
          .some(
            (message) =>
              message.type === 'file_fetch_cancel_result' &&
              message.requestId === cancel.id &&
              message.outcome === 'cancelled',
          ),
      ).toBe(true);
      expect(
        received.slice(beforeCancelMessages).some((message) => message.type === 'file_fetch_chunk'),
      ).toBe(false);
      expect(requests.some((request) => request.type === 'file_fetch_read')).toBe(false);
      await until(
        () =>
          f
            .ledger()
            .inspect()
            .every((row) => row.state === 'settled'),
        'actual cancellation releases reservation',
      );
      downloads.dispose();
      expect(downloads.availableSessions).toEqual([]);
      expect(downloads.start(f.sessionId, 'sample.bin')).toBe(false);
      expect(downloads.controller.copyVerifiedFile()).toBeNull();
      expect(errors).toEqual([]);
    } catch (error) {
      errors.push(error);
    } finally {
      owner?.dispose();
      transport?.disconnect();
      for (const channel of channels) {
        try {
          await channel.close();
        } catch (error) {
          errors.push(error);
        }
      }
      live = false;
      try {
        await f.close();
        expect(f.pty.sessionState).toBe('exited');
        expect(fs.existsSync(f.files.directory)).toBe(false);
        if (consumerPid !== null) {
          let exited = false;
          try {
            process.kill(consumerPid, 0);
          } catch (error) {
            exited = (error as NodeJS.ErrnoException).code === 'ESRCH';
          }
          expect(exited).toBe(true);
        }
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Actual relay download integration failed');
  }, 90000);
}
