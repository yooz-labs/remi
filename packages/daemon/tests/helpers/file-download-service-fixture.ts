/** Real owned TLS/PTY/stores fixture. Direct handle calls prove the dormant core, not raw ingress. */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import {
  type FileDownloadBinding,
  type FileDownloadMessage,
  type FileFetchAccepted,
  type FileFetchBegin,
  type FileFetchCancel,
  type FileFetchComplete,
  type FileFetchRead,
  decodeFileDownloadFrame,
} from '@remi/shared';
import { SessionBindingStore } from '../../src/session/session-binding-store';
import { SessionStore } from '../../src/session/session-store';
import {
  type FileDownloadHostContext,
  type FileDownloadRequest,
  FileDownloadService,
} from '../../src/tunnel/file-download-service';
import { Reservations } from '../../src/tunnel/reservations';
import { browserFixture, until } from './browser-link-service-fixture';

export { until };
export async function downloadFixture(
  options: { tls?: boolean; harness?: 'claude' | 'codex' } = {},
) {
  // Reuse the independently qualified real fixture and its partial-construction/ordered unwind.
  // Its C1 producer is dormant: no BROWSER installation, receiver selection or URL offer occurs.
  const base = await browserFixture({ ...options, installed: false });
  let service: FileDownloadService | undefined;
  async function closeOwned() {
    const errors: unknown[] = [];
    let settled = !service;
    try {
      if (service) settled = await service.close();
      if (!settled) errors.push(new Error('Owned download cleanup remains uncertain'));
    } catch (error) {
      errors.push(error);
    }
    // Drain unrelated consumers/transport even if charged storage/native ownership must remain.
    try {
      await base.close({ preserveFiles: !settled });
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) throw new AggregateError(errors, 'Owned download fixture cleanup failed');
  }
  try {
    const protectedPath = join(base.files.directory, 'protected');
    fs.mkdirSync(protectedPath, { mode: 0o700 });
    const bindings = new SessionBindingStore(
      new SessionStore(join(base.files.home, 'download-sessions.json')),
    );
    let binding: FileDownloadBinding = {
      harness: options.harness ?? 'claude',
      harnessSessionId: randomUUID(),
    };
    let context: FileDownloadHostContext | null = {
      runtime: base.context().runtime,
      protectedRootPaths: [protectedPath],
    };
    const sessionId = () => base.registry.activeSession?.sessionId ?? '';
    const assign = () =>
      bindings.preAssign({
        remiSessionId: sessionId(),
        harness: binding.harness,
        claudeSessionId: binding.harness === 'claude' ? binding.harnessSessionId : null,
        ...(binding.harness === 'codex' && { harnessSessionId: binding.harnessSessionId }),
        projectPath: base.files.work,
        port: base.port,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        exitedAt: null,
        exitCode: null,
      });
    assign();
    service = await FileDownloadService.open({
      home: base.files.home,
      identityStore: base.trust,
      sessions: base.registry,
      bindings,
      directAdapter: () => base.adapter,
      contextFor: (id) => (id === sessionId() ? context : null),
    });
    const core = service;
    async function client(extra: Parameters<typeof base.client>[0] = {}) {
      const peer = await base.client(extra);
      const frames: FileDownloadMessage[] = [];
      peer.ws.addEventListener('message', (event) => {
        const message = decodeFileDownloadFrame(String(event.data));
        if (message) frames.push(message);
      });
      const common = () => ({
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        sessionId: sessionId(),
      });
      const begin = (
        relativePath = 'sample.bin',
        patch: Partial<FileFetchBegin> = {},
      ): FileFetchBegin => ({
        ...common(),
        type: 'file_fetch_begin',
        binding: { ...binding },
        relativePath,
        ...patch,
      });
      const read = (accepted: FileFetchAccepted, seq = 0, receivedBytes = 0): FileFetchRead => ({
        ...common(),
        type: 'file_fetch_read',
        transferId: accepted.transferId,
        seq,
        receivedBytes,
      });
      const complete = (accepted: FileFetchAccepted): FileFetchComplete => ({
        ...common(),
        type: 'file_fetch_complete',
        transferId: accepted.transferId,
        receivedBytes: accepted.byteLength,
        digest: accepted.digest,
      });
      const cancel = (beginId: string): FileFetchCancel => ({
        ...common(),
        type: 'file_fetch_cancel',
        beginId,
      });
      async function submit(request: FileDownloadRequest) {
        await core.handle(peer.id, request);
        await until(
          () => frames.some((frame) => 'requestId' in frame && frame.requestId === request.id),
          'download response',
        );
        return frames.find(
          (frame) => 'requestId' in frame && frame.requestId === request.id,
        ) as Exclude<FileDownloadMessage, FileDownloadRequest>;
      }
      return { ...peer, frames, begin, read, complete, cancel, submit };
    }
    const ledger = () => new Reservations(join(base.files.home, 'image-staging', 'ledger'));
    return {
      base,
      files: base.files,
      service: core,
      bindings,
      protectedPath,
      sessionId,
      client,
      ledger,
      binding: () => ({ ...binding }),
      context: () => context,
      write(relativePath: string, bytes: Uint8Array | string) {
        fs.writeFileSync(join(base.files.work, relativePath), bytes, { mode: 0o600 });
      },
      async rotate(harness = binding.harness, marker: object = {}) {
        const pending = core.invalidateSession(sessionId());
        binding = { harness, harnessSessionId: randomUUID() };
        assign();
        context = { runtime: marker, protectedRootPaths: [protectedPath] };
        await pending;
      },
      setContext(next: FileDownloadHostContext | null) {
        context = next;
      },
      close: closeOwned,
    };
  } catch (error) {
    const errors: unknown[] = [error];
    try {
      await closeOwned();
    } catch (cleanupError) {
      errors.push(cleanupError);
    }
    if (errors.length > 1)
      throw new AggregateError(errors, 'Owned download fixture startup cleanup failed');
    throw error;
  }
}
export type DownloadFixture = Awaited<ReturnType<typeof downloadFixture>>;
export type DownloadPeer = Awaited<ReturnType<DownloadFixture['client']>>;
