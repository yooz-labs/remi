/** Two actual source CLI children, source Worker/Hub and App; opaque frame delay only. */
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { SessionRegistryFile } from '../../../daemon/src/session/session-registry-file.ts';
import { Reservations } from '../../../daemon/src/tunnel/reservations.ts';
import { until } from '../../../daemon/tests/helpers/browser-link-service-fixture.ts';
import {
  fileDownloadCliFixture,
  relayFileDownloadCliFixture,
} from '../../../daemon/tests/helpers/file-download-cli-fixture.ts';
import { ownedRelayAppFixture } from './owned-relay-app-fixture.ts';

interface CarrierData {
  readonly pathname: string;
  link?: CarrierLink;
}
interface CarrierLink {
  readonly client: Bun.ServerWebSocket<CarrierData>;
  readonly upstream: WebSocket;
  pending: Promise<void>;
  readonly queue: (string | Uint8Array)[];
}

export async function relayFileDownloadChildren(
  artifact: string,
  harness: 'claude' | 'codex',
  diagnosticPreload?: string,
) {
  const command = [
    process.execPath,
    '--no-env-file',
    ...(diagnosticPreload ? ['--preload', diagnosticPreload] : []),
    resolve(import.meta.dir, '../../../daemon/src/entry.ts'),
  ];
  const actual = await relayFileDownloadCliFixture({
    harness,
    projectName: 'download-primary',
    command,
  });
  let secondary: Awaited<ReturnType<typeof fileDownloadCliFixture>> | undefined;
  let secondaryProcess: Bun.Subprocess | undefined;
  type Receipt = Awaited<ReturnType<typeof actual.close>>;
  let childReceipts: { primary: Receipt; secondary: Receipt } | undefined;
  let childrenClosing: Promise<void> | undefined;
  const closeChildren = () =>
    (childrenClosing ??= (async () => {
      const failures: unknown[] = [];
      let secondReceipt: Receipt | undefined;
      try {
        secondReceipt = await secondary?.close();
      } catch (error) {
        failures.push(error);
      }
      if (secondaryProcess?.exitCode === null) {
        fs.writeFileSync(
          join(artifact, 'unreaped-secondary.json'),
          JSON.stringify({ pid: secondaryProcess.pid }),
        );
        throw new AggregateError(
          failures,
          'Owned second child remains; preserving the shared home',
        );
      }
      let firstReceipt: Receipt | undefined;
      try {
        firstReceipt = await actual.close();
      } catch (error) {
        failures.push(error);
      }
      if (firstReceipt && secondReceipt) {
        childReceipts = { primary: firstReceipt, secondary: secondReceipt };
        fs.writeFileSync(
          join(artifact, 'child-shutdown.json'),
          JSON.stringify(childReceipts, null, 2),
        );
      }
      if (failures.length) throw new AggregateError(failures, 'Owned two-child cleanup failed');
    })());
  try {
    secondary = await fileDownloadCliFixture({
      harness,
      tls: false,
      relay: 'flag',
      projectName: 'download-secondary',
      threadNamespace: '01950001',
      command: ['/usr/bin/env', `REMI_HOME=${actual.files.home}`, ...command],
      observe: ({ proc }) => {
        secondaryProcess = proc;
      },
    });
    const sourceRegistry = new SessionRegistryFile(join(actual.files.home, 'live-sessions'));
    await until(
      () =>
        sourceRegistry
          .listLive()
          .some((entry) => entry.pid === secondary?.proc.pid && entry.wsPort === secondary.port),
      'actual second source CLI registration',
      10000,
    );
    const secondEntry = sourceRegistry
      .listLive()
      .find((entry) => entry.pid === secondary?.proc.pid && entry.wsPort === secondary.port);
    if (!secondEntry) throw Error('Actual second child missing');
    actual.liveRegistry.register(secondEntry);
  } catch (error) {
    await closeChildren();
    throw error;
  }
  return { actual, secondary, closeChildren, childCleanup: () => childReceipts };
}

export async function relayFileDownloadAppFixture(artifact: string, harness: 'claude' | 'codex') {
  const { actual, closeChildren, childCleanup } = await relayFileDownloadChildren(
    artifact,
    harness,
  );
  const links = new Set<CarrierLink>();
  let stopping = false;
  let closeTask: Promise<void> | undefined;
  let receivedBinary = 0;
  function startCarrier() {
    return Bun.serve<CarrierData>({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request, server) {
        const url = new URL(request.url);
        if (!url.pathname.startsWith('/v2/client/'))
          return new Response('Not found', { status: 404 });
        if (server.upgrade(request, { data: { pathname: url.pathname } })) return;
        return new Response('Upgrade required', { status: 400 });
      },
      websocket: {
        open(client) {
          const upstream = new WebSocket(`${actual.worker.wsUrl}${client.data.pathname}`);
          upstream.binaryType = 'arraybuffer';
          const link = {
            client,
            upstream,
            pending: Promise.resolve(),
            queue: [] as (string | Uint8Array)[],
          };
          client.data.link = link;
          links.add(link);
          upstream.onopen = () => {
            for (const frame of link.queue.splice(0)) upstream.send(frame);
          };
          upstream.onmessage = (event) => {
            const frame =
              typeof event.data === 'string'
                ? event.data
                : new Uint8Array(event.data as ArrayBuffer);
            link.pending = link.pending.then(async () => {
              if (typeof frame !== 'string') {
                receivedBinary++;
                await Bun.sleep(30);
              }
              if (!stopping && client.readyState === WebSocket.OPEN) client.send(frame);
            });
          };
          upstream.onclose = () => client.close(1000, 'Owned carrier closed');
          upstream.onerror = () => client.close(1011, 'Owned carrier failure');
        },
        message(client, raw) {
          const link = client.data.link;
          if (!link || stopping) return;
          const frame = typeof raw === 'string' ? raw : new Uint8Array(raw);
          if (link.upstream.readyState === WebSocket.OPEN) link.upstream.send(frame);
          else if (link.queue.length < 32) link.queue.push(frame);
          else client.close(1011, 'Owned carrier queue full');
        },
        close(client) {
          client.data.link?.upstream.close();
        },
      },
    });
  }
  let carrier: ReturnType<typeof startCarrier>;
  try {
    carrier = startCarrier();
  } catch (error) {
    try {
      await closeChildren();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Owned carrier startup cleanup failed');
    }
    throw error;
  }
  const close = () =>
    (closeTask ??= (async () => {
      stopping = true;
      for (const link of links) {
        link.client.close();
        link.upstream.close();
      }
      carrier.stop(true);
      const failures: unknown[] = [];
      await Promise.all([
        Promise.all([...links].map((link) => link.pending)).catch((e) => {
          failures.push(e);
        }),
        closeChildren().catch((e) => {
          failures.push(e);
        }),
      ]);
      if (failures.length) throw new AggregateError(failures, 'Owned file App cleanup failed');
    })());
  try {
    const relay = {
      ...actual,
      worker: { ...actual.worker, wsUrl: `ws://127.0.0.1:${carrier.port}` },
      close,
    };
    const { ready: panel, ...app } = await ownedRelayAppFixture(artifact, relay, {
      async ready(page) {
        await page.getByText('download-primary', { exact: true }).click({ timeout: 20000 });
        const panel = page.getByRole('region', { name: 'File download', exact: true });
        await panel
          .getByRole('button', { name: 'Download', exact: true })
          .waitFor({ timeout: 20000 });
        return panel;
      },
    });
    return {
      ...app,
      panel,
      actual: {
        ...actual,
        write: (bytes: Uint8Array) => actual.write('sample.bin', bytes),
        ledger: () => new Reservations(join(actual.files.home, 'image-staging', 'ledger')),
      },
      childCleanup,
      receivedBinary: () => receivedBinary,
      closeChannel() {
        for (const link of links) link.client.close(1000, 'Owned context loss');
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
