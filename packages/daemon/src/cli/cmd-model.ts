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
 *   remi model restart         relaunch the engine on the version remi pins
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
 * ## Who starts the engine (#843)
 *
 * Originally every verb probed the port and gave up when nothing answered.
 * Nothing in the CLI ever STARTED an engine — only the daemon did — so on a
 * fresh machine `remi model pull` failed until the user had started a daemon,
 * which inverts the order anyone would try: fetch the weights, THEN run.
 *
 * So the verbs that need an engine to do their job now start one, through the
 * same `EngineHost` the daemon uses (install the helper if absent, spawn
 * detached, wait for the port). Two verbs deliberately opt out:
 *
 *   - `status` is the DIAGNOSTIC verb. Starting an engine in order to answer
 *     "is an engine running?" destroys the question being asked, so it reports
 *     what it finds and says how to start one.
 *   - `use` only writes remi's config. It never needed an engine, and gating
 *     it behind one made the model impossible to configure while the engine
 *     was down — exactly when a user is setting it up.
 */

import { errorToString } from '@remi/shared';
import { EngineHost } from '../auto-approve/engine-host.ts';
import {
  ENGINE_RELEASE,
  PINNED_ENGINE_VERSION,
  isOlderThanPinned,
} from '../auto-approve/engine-install.ts';
import {
  type EngineModel,
  type ManagedModel,
  type PullProgress,
  cancelDownload,
  cleanupModels,
  deleteModel,
  getEngineVersion,
  listManagedModels,
  listModels,
  preloadAsync,
  probeEngine,
  pullModel,
  setTouchUpModel,
  unloadModel,
} from '../auto-approve/engine-models.ts';
import { FileEnginePidStore } from '../auto-approve/engine-process.ts';
import { resolveProviderUrl } from '../auto-approve/llm-client.ts';
import { displayId, findModel, lookupModel, matchesModel } from '../auto-approve/model-identity.ts';
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
  'restart',
] as const;
type Verb = (typeof VERBS)[number];

function isVerb(s: string | undefined): s is Verb {
  return s !== undefined && (VERBS as readonly string[]).includes(s);
}

/**
 * id -> purpose, from the LLM catalogue.
 *
 * The disk inventory (`/v1/models`) carries no `purpose`, so this is the only
 * way to say what a model is the ACTIVE choice for. Best-effort: a catalogue
 * we cannot read costs a qualifier on one label, and must not fail `ls`.
 */
async function purposeMap(
  list: typeof listModels,
  baseUrl: string,
): Promise<ReadonlyMap<string, string>> {
  const map = new Map<string, string>();
  try {
    const catalogue = await list(baseUrl);
    for (const m of catalogue.available) {
      if (m.purpose === undefined) continue;
      map.set(m.id, m.purpose);
      if (m.huggingFaceID !== undefined) map.set(m.huggingFaceID, m.purpose);
    }
  } catch {
    // Label stays unqualified; every other column is unaffected.
  }
  return map;
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
 *  directory names (`models--<ns>--<repo>`) routinely exceed the column, and so
 *  do registered repo ids, which are what these columns now carry. */
function fitColumn(text: string, width: number): string {
  return text.length <= width ? text.padEnd(width) : `${text.slice(0, width - 1)}…`;
}

/** Width of the MODEL column. Sized for a registered repo id
 *  (`YoozLabs/Qwen3.5-4B-qat-lean-4bit-mlx` is 38) so the name a user is meant
 *  to copy is not the thing that gets truncated. */
const NAME_COLUMN = 40;

function formatManagedRow(
  m: ManagedModel,
  configured: string,
  purposeById: ReadonlyMap<string, string> = new Map(),
): string {
  // The marker means "this is the model REMI uses" — not the engine's active
  // tier. `isActive` belongs to whichever module owns the picker, and marking
  // that as the user's model is the same misattribution `rm` used to make.
  // The engine's choice is still worth seeing (it holds the GPU and cannot be
  // deleted), so it is labelled rather than dropped.
  //
  // Callers must not reach here when ownership is UNDECIDABLE (see
  // `lookupModel`): on an engine that reports no aliases, a repo-shaped
  // configured id matches nothing, and an unmarked listing would quietly claim
  // that none of these models is yours. `ls` prints a note in that case
  // instead of marking a row.
  const marker = matchesModel(m, configured) ? '*' : ' ';
  const state = m.loaded ? 'resident' : m.cached ? 'on disk' : 'not downloaded';
  // Say what it is active FOR. `isActive` is the TOUCHUP picker's selection, so
  // an unqualified "engine active" reads as "the engine is using this instead
  // of your model" -- which is what led a user to conclude their configured
  // model was being ignored. It never was: remi passes its model explicitly on
  // every generate (#860).
  const purpose =
    purposeById.get(m.id) ?? (m.huggingFaceID ? purposeById.get(m.huggingFaceID) : undefined);
  const engineActive = m.isActive
    ? purpose === undefined
      ? ', engine active'
      : `, engine ${purpose} tier`
    : '';
  return `${marker} ${fitColumn(displayId(m), NAME_COLUMN)} ${fitColumn(m.module, 6)} ${formatSize(m.sizeBytes).padStart(8)}  ${state}${engineActive}`;
}

function formatRow(m: EngineModel, current: string): string {
  const marker = matchesModel(m, current) ? '*' : ' ';
  const state = m.loaded ? 'resident' : 'on disk';
  return `${marker} ${fitColumn(displayId(m), NAME_COLUMN)} ${formatSize(m.sizeBytes).padStart(8)}  ${state}`;
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
  /**
   * Bring an engine up, returning whether one is now answering. Defaults to the
   * real `EngineHost` (install the helper if needed, spawn detached, wait).
   *
   * A seam because the default reaches the network, the filesystem and
   * `spawn` — a unit test that got the real one would download a helper onto
   * the developer's machine, which is exactly the accident #841 had to undo.
   */
  readonly ensureEngine?: (baseUrl: string, io: ModelCommandIO) => Promise<boolean>;
  /** The running engine's own version, or undefined when it will not say. */
  readonly engineVersion?: typeof getEngineVersion;
  /**
   * Stop the recorded engine, returning the pid signalled or null when none is
   * recorded. A seam for the same reason `ensureEngine` is one: the real
   * implementation signals a live process on the developer's machine.
   */
  readonly stopEngine?: () => number | null;
  /** Move the engine's TouchUp picker, to release a model for deletion (#860). */
  readonly setTouchUpModel?: typeof setTouchUpModel;
}

/**
 * Verbs that must NOT start an engine.
 *
 * `status` is the diagnostic: auto-starting to answer "is one running?" would
 * destroy the question. `use` only writes remi's config and never needed one.
 * Everything else is asking the engine to do work, so it gets an engine.
 */
const NO_AUTOSTART: ReadonlySet<string> = new Set(['status', 'use']);

/** Start (or attach to) the engine the same way the daemon does, narrating to
 *  the terminal — a first run fetches a ~30 MB helper and then waits for a
 *  cold process to bind, and silence through that reads as a hang. */
async function ensureEngineViaHost(
  config: RemiConfig,
  baseUrl: string,
  io: ModelCommandIO,
): Promise<boolean> {
  // HARD STOP under the test runner. This function downloads a helper into
  // `~/.remi`, spawns a detached process, and claims the machine-wide engine
  // pidfile — all real, none of it undone when the test ends. A test that
  // forgets to inject the `ensureEngine` seam would do all three against the
  // developer's own machine, which has already happened twice in this area.
  //
  // The seam is still the mechanism tests should use; this is the backstop
  // that keeps forgetting it cheap. Production is unaffected: `NODE_ENV` is
  // `test` only under `bun test`.
  if (process.env.NODE_ENV === 'test') {
    io.err('[Engine] refusing to start an engine under the test runner');
    return false;
  }
  const aa = config.auto_approve;
  const host = EngineHost.real(
    {
      baseUrl,
      ownership: aa.engine,
      helperPath: aa.engine_path,
      modelCache: aa.model_cache,
    },
    // The host's log lines are progress for an interactive command, but they
    // are not the command's OUTPUT — keep stdout parseable by sending them to
    // stderr, so `remi model ls | ...` is unaffected by a cold start.
    (msg) => io.err(msg),
  );
  const state = await host.ensureRunning();
  return state.kind !== 'unavailable';
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
  // `restart` is the most hostile of all against a shared engine — it does not
  // touch weights, it kills somebody else's process.
  const MUTATING: ReadonlySet<string> = new Set([
    'pull',
    'cancel',
    'rm',
    'cleanup',
    'unload',
    'restart',
  ]);
  if (aa.engine === 'shared' && MUTATING.has(verb)) {
    io.err(
      `"remi model ${verb}" is not available against a shared engine: this remi is a guest (auto_approve.engine = "shared"), and another module may be using these weights.`,
    );
    io.err('Manage models from the host that owns the engine.');
    return 1;
  }

  // `use` is settled entirely before any engine question: it writes remi's
  // config, and gating that on a running engine made the model impossible to
  // configure while the engine was down (#843).
  if (verb === 'use') {
    return await runUse(args[1], baseUrl, io, { list, probe, persistModel: deps.persistModel });
  }

  // `restart` runs its own engine flow. The autostart below fires only when
  // NOTHING is listening, and the case this exists for is the opposite one: an
  // engine that is answering, from an older helper than remi pins (#852).
  if (verb === 'restart') {
    return await runRestart(baseUrl, io, {
      probe,
      version: deps.engineVersion ?? getEngineVersion,
      stop:
        deps.stopEngine ??
        (() =>
          EngineHost.stopRecordedEngine(new FileEnginePidStore(), (pid) =>
            process.kill(pid, 'SIGTERM'),
          )),
      ensure: deps.ensureEngine ?? ((url, out) => ensureEngineViaHost(config, url, out)),
    });
  }

  // One probe up front so every verb can explain "nothing is listening" the
  // same way, instead of each surfacing a raw fetch error (#818).
  //
  // Probing BEFORE attempting a start, rather than starting unconditionally
  // and letting the host discover an engine is already up: the host narrates
  // what it does, and on the overwhelmingly common path — an engine is
  // already running — there is nothing worth narrating. Asking first keeps
  // every ordinary invocation silent, and costs no extra round trip.
  let reachable = await probe(baseUrl);
  if (!reachable.reachable && !NO_AUTOSTART.has(verb)) {
    // Start one if this remi owns the engine. `shared` is somebody else's
    // process to start, and `EngineHost` enforces that itself — it is passed
    // the ownership and refuses to spawn as a guest — so this does not
    // re-decide it here.
    const ensure = deps.ensureEngine ?? ((url, out) => ensureEngineViaHost(config, url, out));
    await ensure(baseUrl, io);
    // Re-probe rather than trusting the start's own answer: starting can
    // fail, and when it does the reason the port is silent is what the user
    // needs to see.
    reachable = await probe(baseUrl);
  }
  if (!reachable.reachable) {
    if (verb === 'status') {
      // The one verb whose job is to report this rather than fail on it.
      io.out(`engine:   ${baseUrl} (not running)`);
      io.out(`model:    ${aa.model}`);
      io.out(`ownership: ${aa.engine}`);
      io.out('');
      io.out(
        aa.engine === 'shared'
          ? 'remi is a guest here (auto_approve.engine = "shared"); the host that owns the engine has to start it.'
          : 'Any other "remi model" verb starts one, as does running a daemon.',
      );
      io.out(
        'Auto-approve escalates every permission to you while this is down — nothing is auto-answered.',
      );
      return 1;
    }
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
        // A FAILED inventory call is not an empty inventory. `listManagedModels`
        // throws on a non-2xx, a timeout, or an unparsable body — all real
        // against a reachable engine — and treating that as "no rows" would
        // make this report "not downloaded" (or "upgrade your engine")
        // according only to whether the configured id happens to contain a
        // slash. Both are confident, wrong, and point nowhere near the cause.
        const rows = await inventory(baseUrl).then(
          (r) => ({ ok: true, rows: r }) as const,
          (err: unknown) => ({ ok: false, err }) as const,
        );
        const found = rows.ok ? lookupModel(rows.rows, configured) : undefined;

        io.out(`engine:   ${baseUrl} (reachable, ${aa.engine})`);
        // What is actually on the far end of the socket, which the pin does not
        // determine: an engine already answering is attached to, however old
        // (#852). Reporting the pin alongside it is what makes "upgrade the
        // engine" a checkable statement rather than an instruction to guess.
        const engineVersion = await (deps.engineVersion ?? getEngineVersion)(baseUrl);
        const stale = isOlderThanPinned(engineVersion);
        io.out(
          engineVersion === undefined
            ? `version:  not reported (remi pins ${PINNED_ENGINE_VERSION})`
            : stale === true
              ? `version:  ${engineVersion} — older than the ${PINNED_ENGINE_VERSION} remi pins`
              : `version:  ${engineVersion} (remi pins ${PINNED_ENGINE_VERSION})`,
        );
        if (stale === true && aa.engine !== 'shared') {
          io.out('          ("remi model restart" relaunches it on the pinned build)');
        }
        io.out(`model:    ${configured}`);
        if (!rows.ok) {
          io.out("state:    could not read this engine's model inventory");
          io.out(`          (${errorToString(rows.err)})`);
        } else if (found === undefined) {
          // Unreachable: `found` is set whenever the fetch succeeded. Present
          // so the narrowing is explicit rather than assumed.
          io.out('state:    unknown');
        } else if (found.kind === 'found') {
          io.out(`loaded:   ${found.row.loaded ? 'yes' : 'no'}`);
          io.out(`on disk:  ${found.row.cached ? 'yes' : 'no'}`);
          io.out(`size:     ${formatSize(found.row.sizeBytes)}`);
        } else if (found.kind === 'unknowable') {
          // Either this engine predates the alias field (yooz-engine#308,
          // 0.7.8) or it has nothing cached at all, and the configured id is
          // repo-shaped. The model may well be served under its canonical id,
          // so "not downloaded" would be a false alarm on the default config.
          // Say only what is true — and do not prescribe an upgrade when an
          // empty inventory (a fresh install) is the likelier explanation.
          io.out("state:    unknown — this engine's listing does not name it");
          io.out(
            rows.ok && rows.rows.length === 0
              ? '          (nothing is cached yet; "remi model pull" fetches it)'
              : stale === true
                ? '          (this engine predates the alias listing; see "version" above)'
                : '          (an engine that names models by repo id resolves this)',
          );
        } else {
          // Alias-aware rows, and none of them is this model. Now a negative
          // result means something, and it is worth saying plainly: the first
          // evaluation would trigger a multi-GB download.
          io.out('state:    not downloaded — no row on this engine names it');
          io.out(`          ("remi model pull ${configured}" fetches it)`);
        }
        // `/v1/llm/status` carries the live load state and the last load
        // ERROR, which the inventory does not — worth surfacing, because "not
        // loaded" and "failed to load, disk full" are very different problems.
        // But it describes the ACTIVE TIER, so it is only OUR error when the
        // active tier IS our model. Attributing another model's failure to
        // remi's would be the same misreport this block exists to fix.
        const s = reachable.status;
        // `modelId` is absent only from a malformed response in practice — the
        // engine populates it unconditionally from a non-optional enum that
        // always has a value, and `engineRequest` throws on an unparsable body
        // before we get here. It is typed optional defensively, so treat an
        // absent one as ours: there would be no other model it could describe.
        //
        // Otherwise compare through the row we resolved, which carries BOTH
        // names: `modelId` is always canonical while `configured` may be the
        // repo id, so comparing the two strings directly makes one model look
        // like two. With no resolved row there is nothing to compare through,
        // and `unknowable` says so rather than guessing.
        //
        // The direct comparison comes FIRST and stands on its own: when the
        // engine reports the very string that is configured, the two name the
        // same model whatever the inventory does or does not know. Deciding
        // this only through a resolved row would report "cannot tell" about an
        // exact match.
        // A failed inventory (`found === undefined`) is undecidable for the
        // same reason a legacy engine is: there is no row to compare through.
        const ours =
          s.modelId === configured
            ? true
            : found === undefined
              ? undefined
              : found.kind === 'found'
                ? matchesModel(found.row, s.modelId ?? configured)
                : found.kind === 'unknowable'
                  ? undefined
                  : false;
        if (s.modelId === undefined || ours === true) {
          if (s.state !== undefined) io.out(`state:    ${s.state}`);
          if (s.progress !== undefined) {
            io.out(`download: ${Math.round(s.progress * 100)}% in flight`);
          }
          if (s.lastError !== undefined) io.out(`error:    ${s.lastError}`);
        } else if (ours === undefined) {
          io.out(`engine picker: ${s.modelId}`);
          io.out('          (cannot tell whether this is your model here)');
        } else {
          // Genuinely a different model. The picker's active tier belongs to
          // whoever owns TouchUp, but it shares the GPU, so name it rather
          // than hiding it — under its registered name where the inventory
          // knows one, so both lines of this report use the same vocabulary.
          const pickerRow =
            s.modelId === undefined || !rows.ok ? undefined : findModel(rows.rows, s.modelId);
          const pickerName = pickerRow === undefined ? s.modelId : displayId(pickerRow);
          io.out(`engine picker: ${pickerName} (not used by remi)`);
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
        io.out(`  ${'MODEL'.padEnd(NAME_COLUMN)} MODULE     SIZE  STATE`);
        const purposes = await purposeMap(list, baseUrl);
        for (const m of models) io.out(formatManagedRow(m, aa.model, purposes));
        const hidden = all.length - models.length;
        if (hidden > 0) {
          io.out(
            `  (${hidden} model(s) from other modules hidden; "remi model ls --all" shows them)`,
          );
        }
        // An unmarked listing asserts "none of these is yours". Against an
        // engine that reports no aliases, a repo-shaped configured id matches
        // no row even when one of them IS remi's model, so the absence of a
        // marker would be a silent false claim. Say which model is configured
        // and why it could not be pointed at.
        if (lookupModel(all, aa.model).kind === 'unknowable') {
          io.out(`  (cannot mark which is remi's: it is configured as "${aa.model}",`);
          io.out('   and this engine lists canonical ids only — upgrade to 0.7.8+)');
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
        const target = findModel(models, id);
        if (target !== undefined && !target.deletable) {
          if (!target.isActive) {
            io.err(`"${id}" is not deletable (nothing reclaimable on disk).`);
            return 1;
          }
          // `isActive` is the ENGINE's active model for that module — the
          // TouchUp picker's tier, in practice — and is only remi's when
          // remi's configured model happens to be the same one. Saying
          // "switch with remi model use" about someone else's active model
          // sends the user after a remedy that provably cannot work: `use`
          // writes remi's config and never touches the picker (#843).
          //
          // Three cases, because the middle one is a claim that can be WRONG.
          // Against an engine reporting no aliases, a repo-shaped configured
          // id matches nothing, so "it is not remi's model" would be asserted
          // about a model that very likely IS remi's — reintroducing exactly
          // the confidently-wrong message this command was fixed to remove,
          // with the correct remedy denied as the one that will not work.
          const ownership = lookupModel(models, aa.model);
          const isOurs =
            ownership.kind === 'found'
              ? matchesModel(target, aa.model)
              : ownership.kind === 'unknowable'
                ? undefined
                : false;
          if (isOurs === true) {
            io.err(
              `"${id}" is the model remi is configured to use; switch with "remi model use <other>" (and restart running daemons) before removing it.`,
            );
          } else if (isOurs === false) {
            // remi OWNS this helper: it fetched it, spawned it, and nothing
            // else on the machine uses its proofread tier. Releasing the
            // picker is remi's to do, and doing it is the whole point -- the
            // previous advice ("stop the engine first") provably cannot work,
            // because a fresh engine re-selects and re-loads that tier at boot.
            if (aa.engine === 'owned') {
              const released = await releaseActiveModel(
                baseUrl,
                target,
                { list, setTouchUp: deps.setTouchUpModel ?? setTouchUpModel },
                io,
              );
              if (released) {
                const result = await remove(baseUrl, target.id);
                io.out(`Removed ${result.id}, reclaimed ${formatSize(result.reclaimedBytes)}.`);
                return 0;
              }
              return 1;
            }
            io.err(
              `"${id}" is the engine's active ${target.module} model, so the engine refuses to delete it. It is not remi's model (that is "${aa.model}"), and "remi model use" will not release it.`,
            );
            io.err(
              'This engine is shared, so its picker belongs to the app that owns it; point that module elsewhere from there.',
            );
          } else {
            io.err(
              `"${id}" is the engine's active ${target.module} model, so the engine refuses to delete it.`,
            );
            io.err(
              `Whether it is also remi's model cannot be determined here: remi is configured as "${aa.model}" and this engine lists canonical ids only (upgrade to 0.7.8+). If it is, "remi model use <other>" releases it; if not, only the app that owns that module can.`,
            );
          }
          return 1;
        }
        // Delete by the id the ENGINE knows. `DELETE /v1/models/:id` resolves
        // aliases too, but resolving here makes that independent of engine
        // version — a registered repo id works against an engine whose delete
        // route only understands canonical ids.
        const result = await remove(baseUrl, target?.id ?? id);
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
    }
  } catch (err) {
    io.err(`remi model ${verb} failed: ${errorToString(err)}`);
    return 1;
  }
}

/**
 * Move the engine's picker off `target` so it can be deleted.
 *
 * `/v1/models`'s `isActive`/`deletable` are owned by the TouchUp (proofread)
 * picker, NOT the LLM picker remi uses -- verified live: `POST /v1/llm/model`
 * moves the LLM `current` and leaves the model undeletable; only
 * `POST /v1/touchup/model` releases it (#860). So the release has to go
 * through that endpoint, and it needs somewhere to point.
 *
 * Returns whether the model is now released. Narrated either way: this mutates
 * a second setting, and a user must be able to see that it happened.
 */
async function releaseActiveModel(
  baseUrl: string,
  target: ManagedModel,
  deps: { list: typeof listModels; setTouchUp: typeof setTouchUpModel },
  io: ModelCommandIO,
): Promise<boolean> {
  const catalogue = await deps.list(baseUrl).catch(() => undefined);
  const targetPurpose = catalogue?.available.find(
    (m) => m.id === target.id || m.huggingFaceID === target.id,
  )?.purpose;

  // A replacement has to serve the same purpose, or the picker would refuse it.
  // Prefer one already on disk so releasing does not trigger a download.
  const candidates = (catalogue?.available ?? []).filter(
    (m) => m.id !== target.id && m.huggingFaceID !== target.id && m.purpose === targetPurpose,
  );
  const replacement = candidates[0];
  if (replacement === undefined) {
    io.err(
      `"${displayId(target)}" is the engine's only ${targetPurpose ?? target.module} model, so there is nothing to point the picker at.`,
    );
    io.err('Deleting it would leave that module with no model; refusing.');
    return false;
  }

  io.out(
    `"${displayId(target)}" is the engine's active ${targetPurpose ?? target.module} model; pointing that picker at "${displayId(replacement)}" to release it.`,
  );
  try {
    await deps.setTouchUp(baseUrl, replacement.id);
  } catch (err) {
    io.err(`Could not move the picker: ${errorToString(err)}`);
    io.err('Nothing was deleted.');
    return false;
  }
  return true;
}

/**
 * `remi model restart` — relaunch the engine on the version remi pins.
 *
 * Exists because pinning does not imply running. `EngineHost`'s rule is that
 * ownership is about who STARTS an engine, not who holds it: an engine already
 * answering gets attached to, however old. So upgrading remi never upgrades a
 * running engine, and a 0.7.1 remi could sit indefinitely against a 0.7.7
 * engine while telling the user to "upgrade to 0.7.8+" — advice whose only
 * implementation was an uncalled function (#852).
 */
async function runRestart(
  baseUrl: string,
  io: ModelCommandIO,
  deps: {
    probe: typeof probeEngine;
    version: typeof getEngineVersion;
    stop: () => number | null;
    ensure: (baseUrl: string, io: ModelCommandIO) => Promise<boolean>;
  },
): Promise<number> {
  const before = await deps.probe(baseUrl);
  const runningVersion = before.reachable ? await deps.version(baseUrl) : undefined;

  if (before.reachable) {
    const pid = deps.stop();
    if (pid === null) {
      // An engine is answering that remi has no pid for: started by hand, or
      // by a remi whose pidfile has since been removed. Killing "whatever holds
      // the port" on a guess is exactly the kind of thing that takes down
      // something the user cared about, so say what is true and stop.
      io.err(`An engine is answering on ${baseUrl}, but remi has no record of starting it.`);
      io.err(
        'Nothing was changed. Stop that process yourself, then any "remi model" verb starts the pinned engine.',
      );
      return 1;
    }
    io.out(`[Engine] Stopped engine pid ${pid}`);
    // SIGTERM is asynchronous: the port stays bound for a moment after the
    // signal returns, and starting into a still-bound port is how you get a
    // second engine that fails to bind and exits, leaving the OLD one serving.
    const released = await waitForPortToClose(baseUrl, deps.probe);
    if (!released) {
      io.err('The old engine is still holding the port; not starting a second one.');
      io.err(`Check for a lingering "${ENGINE_RELEASE.binary}" process.`);
      return 1;
    }
  }

  await deps.ensure(baseUrl, io);
  const after = await deps.probe(baseUrl);
  if (!after.reachable) {
    io.err(`No engine came up on ${baseUrl}: ${after.reason}`);
    return 1;
  }

  const nowVersion = await deps.version(baseUrl);
  const from =
    runningVersion === undefined ? 'an engine that did not report a version' : `${runningVersion}`;
  io.out(
    runningVersion === undefined
      ? `Engine restarted (was ${from}).`
      : `Engine restarted: ${from} -> ${nowVersion ?? 'unreported'}.`,
  );
  if (nowVersion !== undefined && isOlderThanPinned(nowVersion) === true) {
    // The helper on disk is older than the pin — restarting cannot fix that,
    // and claiming success would be a lie the user finds out about later.
    io.err(
      `This engine is still ${nowVersion}, older than the ${PINNED_ENGINE_VERSION} remi pins.`,
    );
    io.err(
      `A helper from an earlier release is being launched. Check auto_approve.engine_path, or remove ~/.remi/engine and let remi refetch ${ENGINE_RELEASE.tag}.`,
    );
    return 1;
  }
  io.out('Restart running daemons for them to use it.');
  return 0;
}

/** Wait for the engine port to stop answering after a stop signal. */
async function waitForPortToClose(
  baseUrl: string,
  probe: typeof probeEngine,
  attempts = 20,
  delayMs = 100,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    const p = await probe(baseUrl, 500);
    if (!p.reachable) return true;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false;
}

/**
 * `remi model use <id>` — set the model remi's evaluator runs on.
 *
 * Writes remi's config, so it works with no engine running. Validation against
 * the catalogue is a NICETY layered on top: valuable when an engine is there
 * (a typo caught now beats a multi-GB download of nothing later), never a
 * precondition. Refusing to configure a model while the engine is down was the
 * single worst friction in the 0.7.0 command (#843) — that is the moment a
 * user is most likely to be setting one up.
 */
async function runUse(
  id: string | undefined,
  baseUrl: string,
  io: ModelCommandIO,
  deps: {
    list: typeof listModels;
    probe: typeof probeEngine;
    persistModel?: ((id: string) => void) | undefined;
  },
): Promise<number> {
  if (!id) {
    io.err('Usage: remi model use <model-id>');
    return 2;
  }

  const persist = deps.persistModel ?? persistModelInConfig;
  const reachable = await deps.probe(baseUrl);
  if (!reachable.reachable) {
    persist(id);
    io.out(`Default model set to ${id}. Restart running daemons to pick it up.`);
    io.out(
      `Not verified against a catalogue: no engine is answering on ${baseUrl}. Check it with "remi model ls" once one is up.`,
    );
    return 0;
  }

  // Match on EITHER name, and only REJECT on a decidable negative.
  //
  // Requiring `m.id === id` rejected the registered repo id — including remi's
  // own shipped default, so the command refused to set the value it ships
  // with. Matching on the alias fixes that against an engine that reports one
  // (yooz-engine#308, 0.7.8+), but an OLDER engine lists canonical ids only,
  // and there a repo-shaped id is simply undecidable: the engine will resolve
  // it server-side and run it perfectly well. Refusing it there would keep the
  // original bug alive for every user who has not upgraded the engine yet.
  // A catalogue fetch that FAILS is not an empty catalogue. Swallowing it
  // would skip the check entirely and still print the plain success line, so a
  // typo would be persisted and reported exactly like a validated write — the
  // check silently disabled by a network hiccup, with nothing said anywhere.
  const catalog = await deps.list(baseUrl).then(
    (c) => ({ ok: true, value: c }) as const,
    (err: unknown) => ({ ok: false, err }) as const,
  );
  if (!catalog.ok) {
    persist(id);
    io.out(`Default model set to ${id}. Restart running daemons to pick it up.`);
    io.out(
      `Not verified against a catalogue: reading it failed (${errorToString(catalog.err)}). Check with "remi model ls".`,
    );
    return 0;
  }

  const known = catalog.value.available;
  const lookup = lookupModel(known, id);
  if (known.length > 0 && lookup.kind === 'absent') {
    io.err(
      `"${id}" is not in the engine catalogue. Known: ${known.map((m) => displayId(m)).join(', ')}`,
    );
    return 1;
  }

  persist(id);
  io.out(`Default model set to ${id}. Restart running daemons to pick it up.`);
  if (known.length === 0) {
    io.out('Not verified: this engine reported an empty catalogue.');
  } else if (lookup.kind === 'unknowable') {
    io.out(
      "Not verified: this engine's catalogue lists canonical ids only, so a registered repo id cannot be checked against it (upgrade the engine to 0.7.8+).",
    );
  }
  return 0;
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
