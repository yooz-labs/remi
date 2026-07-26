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

/** Human-readable size. The engine reports bytes; a user thinks in GB.
 *  Zero is rendered as unknown rather than "0 MB": the inventory reports 0 for
 *  rows whose on-disk footprint it cannot measure (observed on swept hub
 *  directories), and "0 MB" reads as "this is empty" rather than "we don't
 *  know". */
function formatSize(bytes: number | undefined): string {
  if (bytes === undefined || bytes === 0) return '-';
  const gb = bytes / 1e9;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / 1e6)} MB`;
}

/** Pad, or truncate with an ellipsis, so the columns survive a long id. Hub
 *  directory names (`models--<ns>--<repo>`) routinely exceed the column. */
function fitColumn(text: string, width: number): string {
  return text.length <= width ? text.padEnd(width) : `${text.slice(0, width - 1)}…`;
}

function formatManagedRow(m: ManagedModel): string {
  const marker = m.isActive ? '*' : ' ';
  const state = m.loaded ? 'resident' : m.cached ? 'on disk' : 'not downloaded';
  return `${marker} ${fitColumn(m.id, 30)} ${fitColumn(m.module, 6)} ${formatSize(m.sizeBytes).padStart(8)}  ${state}`;
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

  // `--all` belongs to `ls` alone. The parser collects it for any `model`
  // verb, so without this an id after it would be dropped and the flag itself
  // read as the model id -- `remi model rm --all foo` would report that a
  // model called "--all" was not found instead of a usage error.
  if (verb !== 'ls' && args.includes('--all')) {
    io.err(`"--all" applies to "remi model ls" only, not "remi model ${verb}".`);
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

  // #818 ownership boundary: against a SHARED (super-yooz) engine, residency
  // and disk are the host's policy. Unloading weights another module is
  // mid-generate on, or deleting a model the host manages, is hostile — so
  // these verbs refuse rather than mutating shared state. Read-only verbs
  // work identically in both modes.
  const MUTATING: ReadonlySet<string> = new Set(['pull', 'cancel', 'rm', 'cleanup', 'unload']);
  if (aa.engine === 'shared' && MUTATING.has(verb)) {
    io.err(
      `"remi model ${verb}" is not available against a shared engine: this remi is a guest (auto_approve.engine = "shared"), and another module may be using these weights.`,
    );
    io.err('Manage models from the host that owns the engine.');
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
        // Report the model REMI will use, not whatever the engine's TouchUp
        // picker happens to have active. `/v1/llm/status` (`reachable.status`)
        // describes the ACTIVE TIER ONLY — so on an engine whose picker sits on
        // `yooz-light-v3`, this used to print that as `model:` and, worse,
        // print ITS residency as `loaded:`. A user would read "loaded: yes" and
        // conclude remi was warm while remi's own model was not resident at all.
        //
        // Sourced from the disk inventory (`/v1/models`), which is
        // catalogue-wide. `/v1/state` is NOT usable here: it is scoped to the
        // picker's rows, so a generate-only catalogue model (the default) is
        // simply absent from it (verified live 2026-07-26; yooz-engine#307).
        const configured = aa.model;
        const row = await inventory(baseUrl)
          .then((all) => all.find((m) => m.id === configured))
          .catch(() => undefined);

        io.out(`engine:   ${baseUrl} (reachable, ${aa.engine})`);
        io.out(`model:    ${configured}`);
        if (row === undefined) {
          // Do NOT report this as "not served". The engine accepts a model's
          // HuggingFace repo id as an ALIAS (`YoozLabs/Qwen3.5-4B-...` resolves
          // to `yooz-instruct-4b`), but neither `/v1/models` nor
          // `/v1/llm/models` exposes that mapping — so when the configured
          // value is an alias, which it is by default, an id comparison finds
          // nothing even though the model is present and working. Claiming it
          // is missing would be a false alarm on the default config
          // (yooz-engine#308 asks for the mapping so this can be resolved).
          io.out("state:    unknown — this engine's listing does not name it");
          io.out('          (a HuggingFace-style id resolves server-side, so');
          io.out('           this is expected until yooz-engine#308)');
        } else {
          io.out(`loaded:   ${row.loaded ? 'yes' : 'no'}`);
          io.out(`on disk:  ${row.cached ? 'yes' : 'no'}`);
          io.out(`size:     ${formatSize(row.sizeBytes)}`);
        }
        // `/v1/llm/status` carries the live load state and the last load
        // ERROR, which the inventory does not — worth surfacing, because "not
        // loaded" and "failed to load, disk full" are very different problems.
        // But it describes the ACTIVE TIER, so it is only OUR error when the
        // active tier IS our model. Attributing another model's failure to
        // remi's would be the same misreport this block exists to fix.
        const s = reachable.status;
        const statusIsOurs = s.modelId === undefined || s.modelId === configured;
        if (statusIsOurs) {
          if (s.state !== undefined) io.out(`state:    ${s.state}`);
          if (s.progress !== undefined) {
            io.out(`download: ${Math.round(s.progress * 100)}% in flight`);
          }
          if (s.lastError !== undefined) io.out(`error:    ${s.lastError}`);
        } else {
          // The picker's active tier belongs to whoever owns TouchUp, but it
          // shares the GPU, so name it rather than hiding it.
          io.out(`engine picker: ${s.modelId} (not used by remi)`);
        }
        return 0;
      }
      case 'ls': {
        const all = await inventory(baseUrl);
        // The inventory covers EVERY module (a live engine returned 69 rows,
        // 67 of them STT hub directories). This command manages the model
        // auto-approve evaluates with, so show that module by default and say
        // what was hidden rather than burying two useful rows in noise.
        const wantAll = args.includes('--all');
        const models = wantAll ? all : all.filter((m) => m.module === 'llm');
        if (models.length === 0) {
          io.out(all.length === 0 ? 'No models on disk.' : 'No LLM models on disk.');
          return 0;
        }
        io.out('  MODEL                          MODULE     SIZE  STATE');
        for (const m of models) io.out(formatManagedRow(m));
        const hidden = all.length - models.length;
        if (hidden > 0) {
          io.out(
            `  (${hidden} model(s) from other modules hidden; "remi model ls --all" shows them)`,
          );
        }
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
 * Persist `auto_approve.model` in a config file with a surgical, SECTION-SCOPED
 * line edit.
 *
 * Surgical rather than "reserialize the parsed config" because the generated
 * default config is mostly comments and commented-out examples, and rewriting
 * from the parsed object would silently delete all of it.
 *
 * Three things this has to get right, each of which is a way to corrupt a
 * user's config:
 *   - **Scope.** Only a `model =` inside `[auto_approve]` may be touched. An
 *     unscoped match would rewrite the first `model =` anywhere in the file,
 *     which today happens to be the right one only because no other section
 *     defines that key.
 *   - **Replacement escaping.** `String.replace` gives `$&`, `$1`, `$$` special
 *     meaning in a replacement STRING. A model id containing them would inject
 *     matched text into the file. A function replacement has no such
 *     interpretation, so this uses one.
 *   - **A commented-out section.** A fresh install ships `[auto_approve]` and
 *     its keys entirely commented out, so the first `remi model use` finds
 *     neither an active key nor an active header. Appending a live section is
 *     correct there — but it must not ALSO append when a live section already
 *     exists further down.
 */
export function persistModelInConfig(id: string, configPath = defaultConfigPath()): void {
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');

  const line = `model = "${id}"`;
  let text = '';
  try {
    text = fs.readFileSync(configPath, 'utf-8');
  } catch (err) {
    // ONLY "there is no config yet" may fall through to writing a fresh file.
    // A permissions or I/O error must propagate: treating EACCES as "no
    // config" and writing a minimal one would silently destroy the user's
    // rules, provider and api_key, and report success while doing it.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `[auto_approve]\n${line}\n`, { mode: 0o600 });
    return;
  }

  const section = findAutoApproveSection(text);
  if (section === null) {
    // No LIVE [auto_approve] section (absent, or only the commented-out
    // template a fresh install ships). Append one.
    fs.writeFileSync(configPath, `${text.trimEnd()}\n\n[auto_approve]\n${line}\n`);
    return;
  }

  const body = text.slice(section.start, section.end);
  const active = /^[ \t]*model[ \t]*=.*$/m;
  const newBody = active.test(body)
    ? // Function replacement: `$&` and friends in `id` stay literal.
      body.replace(active, () => line)
    : `${body.replace(/^(\s*\[auto_approve\][ \t]*)$/m, (m) => `${m}\n${line}`)}`;
  fs.writeFileSync(configPath, text.slice(0, section.start) + newBody + text.slice(section.end));
}

/** Byte range of the LIVE `[auto_approve]` section (header through the line
 *  before the next section header, or EOF), or null when there is none. A
 *  commented-out `# [auto_approve]` is deliberately not a match. */
function findAutoApproveSection(text: string): { start: number; end: number } | null {
  const header = /^[ \t]*\[auto_approve\][ \t]*$/m;
  const match = header.exec(text);
  if (match === null) return null;
  const start = match.index;
  const rest = text.slice(start + match[0].length);
  const next = /^[ \t]*\[[^\]\n]+\][ \t]*$/m.exec(rest);
  const end = next === null ? text.length : start + match[0].length + next.index;
  return { start, end };
}

/** `~/.remi/config.toml`. */
function defaultConfigPath(): string {
  const os = require('node:os') as typeof import('node:os');
  const path = require('node:path') as typeof import('node:path');
  return path.join(os.homedir(), '.remi', 'config.toml');
}
