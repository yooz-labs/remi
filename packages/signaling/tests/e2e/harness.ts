/**
 * Runs the REAL signaling Worker and the REAL ConnectionRoom Durable Object
 * (workerd, SQLite-backed storage, real hibernation) inside the test process,
 * through the Miniflare library. No Cloudflare account or login is required,
 * and nothing is mocked: a test talks to the Worker with real
 * WebSocket clients.
 *
 * What differs from production, so a test reader does not over-read a pass:
 * - the Worker is bundled by `Bun.build` here, not by wrangler's esbuild;
 * - Miniflare sets `CF-Connecting-IP: 127.0.0.1` on every request, so every
 *   client shares one address: start a fresh Worker per test (`startWorker`);
 * - migrations in wrangler.toml are not exercised (the classes are declared
 *   directly), and the production hibernation threshold and alarm precision
 *   are unverified here.
 * - pinned push audiences use an owned transparent TCP listener, held across
 *   fresh workerd restarts; HTTP/WebSocket bytes and Host headers are unchanged.
 *
 * Never SIGKILL a test run that uses this harness: Miniflare's `workerd` child
 * process is cleaned up on a normal exit, SIGINT and SIGTERM only.
 */

import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Miniflare } from 'miniflare';
import { openWorkerListener } from './worker-listener.ts';

const PKG = resolve(import.meta.dir, '../..');

interface WranglerConfig {
  compatibility_date: string;
  vars?: Record<string, string>;
  durable_objects: { bindings: { name: string; class_name: string }[] };
  migrations: { new_sqlite_classes?: string[] }[];
}

export interface TestWorker {
  readonly mf: Miniflare;
  /** `http://127.0.0.1:<port>` */
  readonly url: string;
  /** `ws://127.0.0.1:<port>` */
  readonly wsUrl: string;
  stop(): Promise<void>;
  /** Fresh real runtime/storage handles at the same still-owned pinned origin. */
  restart(): Promise<TestWorker>;
}

type WorkerListener = Awaited<ReturnType<typeof openWorkerListener>>;
async function cleanupWorker(
  mf: Miniflare | undefined,
  listener: WorkerListener | undefined,
  failures: unknown[] = [],
): Promise<void> {
  for (const close of [() => mf?.dispose(), () => listener?.close()]) {
    try {
      await close();
    } catch (failure) {
      failures.push(failure);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, 'Owned Worker cleanup failed');
}

let bundled: Promise<string> | undefined;

/**
 * Bundle with esbuild, the bundler wrangler uses, instead of `Bun.build`. Off by default: set
 * `E2E_BUNDLER=esbuild` to run the whole suite against that bundle, which is the closest a test
 * gets to what `wrangler deploy` ships without deploying. esbuild comes with wrangler.
 */
async function bundleWithEsbuild(): Promise<string> {
  const wrangler = realpathSync(resolve(PKG, 'node_modules/wrangler/package.json'));
  const esbuildPath = createRequire(wrangler).resolve('esbuild');
  const esbuild = (await import(pathToFileURL(esbuildPath).href)) as {
    build(options: object): Promise<{ outputFiles: { text: string }[] }>;
  };
  const built = await esbuild.build({
    entryPoints: [`${PKG}/tests/e2e/test-entry.ts`],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    conditions: ['workerd', 'worker', 'browser'],
    mainFields: ['browser', 'module', 'main'],
    write: false,
    logLevel: 'silent',
  });
  const output = built.outputFiles[0];
  if (!output) throw new Error('esbuild produced no output');
  return output.text;
}

async function bundleWithBun(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [`${PKG}/tests/e2e/test-entry.ts`],
    target: 'browser',
    format: 'esm',
  });
  const output = built.outputs[0];
  if (!built.success || !output) throw new Error(built.logs.join('\n'));
  return output.text();
}

/** Bundle the test entry (the real Worker plus the debug seams) once per loaded harness module. */
function bundle(): Promise<string> {
  bundled ??= process.env['E2E_BUNDLER'] === 'esbuild' ? bundleWithEsbuild() : bundleWithBun();
  return bundled;
}

/**
 * Start a fresh Worker. `vars` override the values of wrangler.toml's `[vars]`
 * (for example to run with small rate limits). The compatibility date, the
 * variables and the Durable Object bindings come from wrangler.toml so they
 * cannot drift from what is deployed.
 */
export function startWorker(
  vars: Record<string, string> = {},
  pinPushAudience = false,
  ownedPersistence?: { path: string; port?: number },
  beforeRuntime?: (url: string) => void | Promise<void>,
): Promise<TestWorker> {
  return createWorker(vars, pinPushAudience, ownedPersistence, beforeRuntime);
}

async function createWorker(
  vars: Record<string, string>,
  pinPushAudience: boolean,
  ownedPersistence?: { path: string; port?: number },
  beforeRuntime?: (url: string) => void | Promise<void>,
  existingListener?: WorkerListener,
): Promise<TestWorker> {
  const cfg = Bun.TOML.parse(await Bun.file(`${PKG}/wrangler.toml`).text()) as WranglerConfig;
  const sqlite = new Set(cfg.migrations.flatMap((m) => m.new_sqlite_classes ?? []));
  // Hold the exact public origin throughout startup; selecting then closing a port races (#1623).
  const listener =
    existingListener ??
    (pinPushAudience ? await openWorkerListener(ownedPersistence?.port ?? 0) : undefined);
  const audience = listener?.url;
  let mf: Miniflare | undefined;
  try {
    if (audience) await beforeRuntime?.(audience);
    const options = {
      modules: true,
      script: await bundle(),
      compatibilityDate: cfg.compatibility_date,
      bindings: { ...cfg.vars, ...vars, ...(audience ? { PUSH_AUDIENCE: audience } : {}) },
      durableObjects: Object.fromEntries(
        cfg.durable_objects.bindings.map((b) => [
          b.name,
          { className: b.class_name, useSQLite: sqlite.has(b.class_name) },
        ]),
      ),
      port: listener ? 0 : (ownedPersistence?.port ?? 0),
      ...(ownedPersistence ? { durableObjectsPersist: ownedPersistence.path } : {}),
    };
    mf = new Miniflare(options);
    const backend = String((await mf.ready) as URL).replace(/\/$/, '');
    await listener?.forwardTo(backend);
    const url = audience ?? backend;
    const runtime = mf;
    let closed = false;
    let stopping: Promise<void> | undefined;
    return {
      mf: runtime,
      url,
      wsUrl: url.replace(/^http/, 'ws'),
      async stop() {
        if (stopping) return stopping;
        if (closed) return;
        closed = true;
        stopping = cleanupWorker(runtime, listener);
        return stopping;
      },
      async restart() {
        if (closed || !listener || !ownedPersistence)
          throw new Error('Owned persistent Worker unavailable');
        closed = true;
        try {
          await listener.pause();
          await runtime.dispose();
          return await createWorker(
            vars,
            pinPushAudience,
            ownedPersistence,
            beforeRuntime,
            listener,
          );
        } catch (error) {
          await cleanupWorker(runtime, listener, [error]);
          throw error;
        }
      },
    };
  } catch (error) {
    await cleanupWorker(mf, listener, [error]);
    throw error;
  }
}

/** `fetch` without keep-alive: Miniflare closes idle keep-alive connections after 5 s. */
export const get = (url: string, init: RequestInit = {}): Promise<Response> =>
  fetch(url, { ...init, keepalive: false } as RequestInit);
