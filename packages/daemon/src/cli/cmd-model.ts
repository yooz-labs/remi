/**
 * Handler for `remi model <verb> [id]` (#819) — the ollama-style CLI for the
 * local LLM the auto-approve evaluator runs on.
 *
 * Retiring ollama (#809) took away `ollama pull/ls/rm/ps` and put nothing in
 * its place: the Yooz engine ships no CLI, so without this command a user has
 * no way to see which models exist, fetch one, or free the memory one is
 * holding — and the first evaluation would silently trigger a multi-GB
 * HuggingFace download with no feedback anywhere.
 *
 *   remi model ls              inventory: size on disk, downloaded, resident
 *   remi model ps              what is resident right now
 *   remi model status          engine reachable? which model? pull in flight?
 *   remi model pull <id>       download weights, without changing the active model
 *   remi model cancel <id>     abort an in-flight download
 *   remi model rm <id>         delete weights, reporting the disk reclaimed
 *   remi model cleanup         the engine's one-shot disk-hygiene sweep
 *   remi model load <id>       make resident (already-downloaded weights)
 *   remi model unload <id>     free its memory
 *   remi model use <id>        make it the configured default (persisted)
 *
 * `ls` reads the DISK inventory (`GET /v1/models`), whose `sizeBytes` is the
 * engine's real measured footprint and whose `deletable` flag is what `rm`
 * honors; `ps` reads the RESIDENCY view. Conflating the two is the easy
 * mistake — see `engine-models.ts`.
 *
 * `use` writes remi's own config rather than calling the engine's
 * `POST /v1/llm/model`, because that preference is PROCESS-LIFETIME only —
 * the engine forgets it on restart, so persisting it there would silently
 * revert. Config is remi's, so config is where it lives.
 *
 * Every verb goes through a reachability probe first, because the failure this
 * command most needs to explain is "no engine is running" — which otherwise
 * shows up only as auto-approve escalating everything forever with no
 * explanation (#818).
 */

import { errorToString } from '@remi/shared';
import {
  type EngineModel,
  type ManagedModel,
  type PullProgress,
  cancelDownload,
  cleanupModels,
  deleteModel,
  listManagedModels,
  listModels,
  preloadAsync,
  probeEngine,
  pullModel,
  unloadModel,
} from '../auto-approve/engine-models.ts';
import { resolveProviderUrl } from '../auto-approve/llm-client.ts';
import type { RemiConfig } from '../config/config.ts';

export interface ModelCommandIO {
  readonly out: (msg: string) => void;
  readonly err: (msg: string) => void;
}

const defaultIO: ModelCommandIO = {
  out: (msg) => console.log(msg),
  err: (msg) => console.error(msg),
};

/** How often to print a line while the engine's fraction is not advancing. */
const HEARTBEAT_MS = 5_000;

const VERBS = [
  'ls',
  'ps',
  'status',
  'pull',
  'cancel',
  'rm',
  'cleanup',
  'load',
  'unload',
  'use',
] as const;
type Verb = (typeof VERBS)[number];

function isVerb(s: string | undefined): s is Verb {
  return s !== undefined && (VERBS as readonly string[]).includes(s);
}

/** Human-readable size. The engine reports bytes; a user thinks in GB. */
function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return '-';
  const gb = bytes / 1e9;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / 1e6)} MB`;
}

function formatManagedRow(m: ManagedModel): string {
  const marker = m.isActive ? '*' : ' ';
  const state = m.loaded ? 'resident' : m.cached ? 'on disk' : 'not downloaded';
  return `${marker} ${m.id.padEnd(22)} ${m.module.padEnd(8)} ${formatSize(m.sizeBytes).padStart(8)}  ${state}`;
}

function formatRow(m: EngineModel, current: string): string {
  const marker = m.id === current ? '*' : ' ';
  const state = m.loaded ? 'resident' : 'on disk';
  return `${marker} ${m.id.padEnd(24)} ${formatSize(m.sizeBytes).padStart(8)}  ${state}`;
}

/**
 * Render one progress line. Deliberately not a spinner: this output is as
 * likely to land in a log or a CI transcript as on a TTY.
 *
 * A percentage is shown ONLY while the fraction is actually advancing. For a
 * single-big-file repo — which both of remi's LLM tiers are — the engine's
 * fraction steps ~0.6% and then sits there for the whole multi-GB download
 * (yooz-engine#292/#293). Printing "1%" for two minutes reads as a wedged
 * download and is worse than saying nothing, so the flat case reports elapsed
 * time against the known size instead, which is honest about what we know: it
 * is running, and this is how big it is.
 */
function renderProgress(io: ModelCommandIO, model: string, p: PullProgress): void {
  const elapsed = `${Math.round(p.elapsedMs / 1000)}s`;
  if (p.advancing && p.fraction !== undefined) {
    io.out(`  ${model}: ${Math.round(p.fraction * 100)}% (${elapsed})`);
    return;
  }
  const size = p.sizeBytes === undefined ? '' : ` of ${formatSize(p.sizeBytes)}`;
  io.out(`  ${model}: downloading${size}, ${elapsed} elapsed`);
}

export interface ModelCommandDeps {
  /** Seams for tests; default to the real engine client. */
  readonly list?: typeof listModels;
  readonly inventory?: typeof listManagedModels;
  readonly remove?: typeof deleteModel;
  readonly cleanup?: typeof cleanupModels;
  readonly cancel?: typeof cancelDownload;
  readonly probe?: typeof probeEngine;
  readonly pull?: typeof pullModel;
  readonly load?: typeof preloadAsync;
  readonly unload?: typeof unloadModel;
  /** Persist `auto_approve.model`. Defaults to a surgical config-file edit. */
  readonly persistModel?: (id: string) => void;
}

/**
 * Run `remi model …`. Returns the process exit code (0 success, 1 failure, 2
 * usage error) — never calls process.exit itself, so it stays testable.
 */
export async function runModelCommand(
  args: readonly string[],
  config: RemiConfig,
  io: ModelCommandIO = defaultIO,
  deps: ModelCommandDeps = {},
): Promise<number> {
  const verb = args[0];
  if (!isVerb(verb)) {
    io.err(
      verb === undefined
        ? `Usage: remi model <${VERBS.join('|')}> [model-id]`
        : `Unknown subcommand "${verb}". Expected one of: ${VERBS.join(', ')}`,
    );
    return 2;
  }

  const list = deps.list ?? listModels;
  const inventory = deps.inventory ?? listManagedModels;
  const remove = deps.remove ?? deleteModel;
  const cleanup = deps.cleanup ?? cleanupModels;
  const cancel = deps.cancel ?? cancelDownload;
  const probe = deps.probe ?? probeEngine;
  const pull = deps.pull ?? pullModel;
  const load = deps.load ?? preloadAsync;
  const unload = deps.unload ?? unloadModel;

  const aa = config.auto_approve;
  const baseUrl = resolveProviderUrl(aa.provider, aa.base_url);
  if (!baseUrl) {
    io.err(
      'No LLM endpoint configured. Set [auto_approve] provider (e.g. provider = "yooz") in your remi config.',
    );
    return 1;
  }

  // One probe up front so every verb can explain "nothing is listening" the
  // same way, instead of each surfacing a raw fetch error (#818).
  const reachable = await probe(baseUrl);
  if (!reachable.reachable) {
    io.err(`No LLM engine answering on ${baseUrl}: ${reachable.reason}`);
    io.err(
      'Auto-approve cannot evaluate anything while this is down — every permission will escalate to you.',
    );
    return 1;
  }

  try {
    switch (verb) {
      case 'status': {
        const s = reachable.status;
        io.out(`engine:   ${baseUrl} (reachable)`);
        io.out(`model:    ${s.modelId ?? aa.model} (configured: ${aa.model})`);
        io.out(`loaded:   ${s.loaded ? 'yes' : 'no'}`);
        if (s.state !== undefined) io.out(`state:    ${s.state}`);
        if (s.progress !== undefined) {
          io.out(`download: ${Math.round(s.progress * 100)}% in flight`);
        }
        if (s.lastError !== undefined) io.out(`error:    ${s.lastError}`);
        return 0;
      }
      case 'ls': {
        const models = await inventory(baseUrl);
        if (models.length === 0) {
          io.out('No models on disk.');
          return 0;
        }
        io.out('  MODEL                    MODULE      SIZE  STATE');
        for (const m of models) io.out(formatManagedRow(m));
        return 0;
      }
      case 'rm': {
        const id = args[1];
        if (!id) {
          io.err('Usage: remi model rm <model-id>');
          return 2;
        }
        const models = await inventory(baseUrl);
        const target = models.find((m) => m.id === id);
        if (target !== undefined && !target.deletable) {
          io.err(
            target.isActive
              ? `"${id}" is the active model; switch with "remi model use <other>" before removing it.`
              : `"${id}" is not deletable (nothing reclaimable on disk).`,
          );
          return 1;
        }
        const result = await remove(baseUrl, id);
        io.out(`Removed ${result.id}, reclaimed ${formatSize(result.reclaimedBytes)}.`);
        return 0;
      }
      case 'cleanup': {
        const result = await cleanup(baseUrl);
        const repos = Object.keys(result.perRepo).length;
        io.out(
          `Reclaimed ${formatSize(result.totalReclaimedBytes)}${repos > 0 ? ` across ${repos} repo(s)` : ''}.`,
        );
        return 0;
      }
      case 'cancel': {
        const id = args[1];
        if (!id) {
          io.err('Usage: remi model cancel <model-id>');
          return 2;
        }
        await cancel(baseUrl, id);
        io.out(`Cancelled the download of ${id}.`);
        return 0;
      }
      case 'ps': {
        const catalog = await list(baseUrl);
        const resident = catalog.available.filter((m) => m.loaded);
        if (resident.length === 0) {
          io.out('No models resident.');
          return 0;
        }
        for (const m of resident) io.out(formatRow(m, catalog.current));
        return 0;
      }
      case 'pull': {
        const id = args[1] ?? aa.model;
        if (!id) {
          io.err('Usage: remi model pull <model-id>');
          return 2;
        }
        io.out(`Pulling ${id} from HuggingFace. This does not change the active model.`);
        let lastLineAt = -HEARTBEAT_MS;
        let lastPct = -1;
        await pull(baseUrl, id, {
          onProgress: (p) => {
            // Report a moving percentage on every change; when the fraction is
            // flat (the normal case for our tiers) fall back to a periodic
            // heartbeat so the user can see it is alive without a misleading
            // number, and without spamming a log line every poll.
            const pct = p.fraction === undefined ? -1 : Math.round(p.fraction * 100);
            const movedEnough = p.advancing && pct !== lastPct;
            const dueForHeartbeat = p.elapsedMs - lastLineAt >= HEARTBEAT_MS;
            if (!movedEnough && !dueForHeartbeat) return;
            lastPct = pct;
            lastLineAt = p.elapsedMs;
            renderProgress(io, id, p);
          },
        });
        io.out(`${id} is downloaded.`);
        return 0;
      }
      case 'load': {
        const id = args[1] ?? aa.model;
        if (!id) {
          io.err('Usage: remi model load <model-id>');
          return 2;
        }
        await load(baseUrl, id);
        io.out(`Load dispatched for ${id}. Check "remi model status" for progress.`);
        return 0;
      }
      case 'unload': {
        const id = args[1];
        if (!id) {
          io.err('Usage: remi model unload <model-id>');
          return 2;
        }
        await unload(baseUrl, id);
        io.out(`Unloaded ${id}.`);
        return 0;
      }
      case 'use': {
        const id = args[1];
        if (!id) {
          io.err('Usage: remi model use <model-id>');
          return 2;
        }
        const catalog = await list(baseUrl);
        if (catalog.available.length > 0 && !catalog.available.some((m) => m.id === id)) {
          io.err(
            `"${id}" is not in the engine catalogue. Known: ${catalog.available.map((m) => m.id).join(', ')}`,
          );
          return 1;
        }
        const persist = deps.persistModel ?? persistModelInConfig;
        persist(id);
        io.out(`Default model set to ${id}. Restart running daemons to pick it up.`);
        return 0;
      }
    }
  } catch (err) {
    io.err(`remi model ${verb} failed: ${errorToString(err)}`);
    return 1;
  }
}

/**
 * Persist `auto_approve.model` in `~/.remi/config.toml` with a surgical
 * line edit: rewriting the file from the parsed config would discard the
 * user's comments and their commented-out examples, which the generated
 * default config is full of. Adds the key under `[auto_approve]` when it is
 * absent (including commented out).
 */
function persistModelInConfig(id: string): void {
  // Imported lazily so the pure-function path above stays filesystem-free for
  // tests that inject `persistModel`.
  const fs = require('node:fs') as typeof import('node:fs');
  const os = require('node:os') as typeof import('node:os');
  const path = require('node:path') as typeof import('node:path');
  const configPath = path.join(os.homedir(), '.remi', 'config.toml');

  const line = `model = "${id}"`;
  let text = '';
  try {
    text = fs.readFileSync(configPath, 'utf-8');
  } catch {
    // No config yet: write a minimal one rather than failing the command.
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `[auto_approve]\n${line}\n`, { mode: 0o600 });
    return;
  }

  const active = /^\s*model\s*=.*$/m;
  if (active.test(text)) {
    fs.writeFileSync(configPath, text.replace(active, line), { mode: 0o600 });
    return;
  }
  const section = /^\s*\[auto_approve\]\s*$/m;
  if (section.test(text)) {
    fs.writeFileSync(
      configPath,
      text.replace(section, (m) => `${m}\n${line}`),
      { mode: 0o600 },
    );
    return;
  }
  fs.writeFileSync(configPath, `${text.trimEnd()}\n\n[auto_approve]\n${line}\n`, { mode: 0o600 });
}
