/**
 * Model-management client for the Yooz engine's `/v1/llm/*` control plane
 * (#819). Sibling of `llm-client.ts`, which owns the INFERENCE call
 * (`/v1/llm/generate`); this file owns everything about which models exist,
 * which are downloaded, which are resident, and how to change that.
 *
 * Why this exists at all: with ollama, management was somebody else's CLI
 * (`ollama pull/ls/rm/ps`) and remi never had to think about it. The engine
 * ships no CLI, so after the ollama retirement (#809) remi is the only place a
 * user can see or control any of this — hence `remi model` (#819) and the
 * idle-unload timer (#820), both of which call through here.
 *
 * Endpoint contract (yooz-engine `EndpointSpecs.swift`; wire types in
 * `YoozEngineWire/{LLMWireTypes,ModelManagementWireTypes,TouchUpWireTypes}.swift`).
 * Model management is deliberately split across two families, and using the
 * wrong one is the easy mistake here:
 *
 *   RESIDENCY (is it in memory?) -- the `/v1/llm/*` family:
 *   - `GET  /v1/llm/models`  -> { current, available: [{id, displayName, sizeBytes, loaded}] }
 *   - `GET  /v1/llm/status`  -> { loaded, modelId, progress, state, lastError }
 *   - `POST /v1/llm/preload` -> 202 dispatch; `?wait=true` blocks until resident
 *   - `POST /v1/llm/unload`  -> free that model's weights
 *   - `POST /v1/llm/clear-cache` -> drop a model's retained prompt-KV cache
 *     WITHOUT freeing its weights (#820 stage 1) -- cheaper than `unload`: no
 *     cold reload on the next evaluation, only the cost of recomputing the
 *     (identical every time, for remi's fixed system prompt) prefix. Body
 *     `{model}`; omitted `model` clears every currently loaded tier. May not
 *     exist on every engine build -- see `ClearCacheUnsupportedError`.
 *   - `POST /v1/llm/model`   -> preferred model. PROCESS-LIFETIME ONLY: the
 *     engine forgets it on restart, which is why `remi model use` persists the
 *     choice in remi's own config instead of relying on this.
 *
 *   DISK (is it downloaded? may I delete it?) -- the inventory + download family:
 *   - `GET    /v1/models`                  -> [{id, module, displayName, sizeBytes
 *     (REAL measured on-disk footprint), cached, loaded, isActive, deletable}]
 *   - `DELETE /v1/models/:id`              -> { id, reclaimedBytes }
 *   - `POST   /v1/models/cleanup`          -> { totalReclaimedBytes, perRepo }
 *   - `POST   /v1/touchup/download`        -> fetch weights WITHOUT changing the
 *     active selection (the touch-up picker owns the LLM models remi uses)
 *   - `POST   /v1/touchup/download/cancel` -> abort that fetch
 *
 * Two contract details that are easy to get wrong and expensive to get wrong:
 *
 *   1. **Downloading is `/v1/touchup/download`, not `preload`.** Preload
 *      conflates "fetch the weights" with "make this resident", and its
 *      `?wait=true` form holds one HTTP request open for an entire multi-GB
 *      HuggingFace pull. The explicit download endpoint exists precisely so a
 *      client can fetch without touching the active selection.
 *   1b. **Do not trust `status.progress` to move.** yooz-engine#292 (open):
 *      the engine publishes ONE near-zero download sample and then nothing for
 *      the rest of the download, because the upstream MLX progress handler
 *      fires once and the watcher's 2%-delta gate never clears again. So
 *      `pullModel` treats progress as a bonus, not a completion signal, and
 *      decides doneness from the INVENTORY (`cached: true`), which is derived
 *      from bytes actually on disk. A progress bar built on that field alone
 *      sits at 0% for the whole download and then jumps to done.
 *   2. **`unload` is not remi's to call unconditionally.** Under a shared
 *      (super-yooz) engine another module may be mid-generate on the same
 *      weights, so unloading is hostile. Ownership is decided one layer up
 *      (#818); this module just exposes the verb.
 */

import { errorToString } from '@remi/shared';

/** One model in the engine's catalogue (`LLMModelInfo`). `sizeBytes` and
 *  `latencyHintMs` are optional on the wire so future backends can omit them;
 *  treat them as hints, never as invariants. */
export interface EngineModel {
  readonly id: string;
  readonly displayName: string;
  readonly sizeBytes?: number | undefined;
  readonly loaded: boolean;
  readonly latencyHintMs?: number | undefined;
  /** The model's registered HuggingFace repo id, which the engine also accepts
   *  as an alias wherever a model id is taken (yooz-engine#308). Absent on
   *  engines older than 0.7.8 — see `model-identity.ts` for why that absence
   *  has to be handled rather than assumed away. */
  readonly huggingFaceID?: string | undefined;
}

/** `GET /v1/llm/models`. `current` is the engine's process-lifetime preference. */
export interface EngineModelCatalog {
  readonly current: string;
  readonly available: readonly EngineModel[];
}

/** `GET /v1/llm/status`. `progress` is a 0..1 fraction while a HuggingFace
 *  download is in flight and absent otherwise; `state`/`lastError` are how a
 *  FAILED load reports itself (older engine builds omit `state`, in which case
 *  `loaded` + `progress` are all there is). */
export interface EngineStatus {
  readonly loaded: boolean;
  readonly modelId?: string | undefined;
  readonly progress?: number | undefined;
  readonly state?: string | undefined;
  readonly lastError?: string | undefined;
}

/** Every failure mode of this control plane, as a value rather than a thrown
 *  string, so callers can render an ACTIONABLE message. The distinction that
 *  matters most is `unreachable` (no engine at all — the silent-always-escalate
 *  failure #818 is about) versus a real error from a live engine. */
export type EngineProbe =
  | { readonly reachable: true; readonly status: EngineStatus }
  | { readonly reachable: false; readonly reason: string };

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Thrown by `engineRequest` on a non-2xx response. Carries the raw HTTP
 * status alongside the usual message so a caller that cares about a SPECIFIC
 * code (e.g. `clearModelCache` distinguishing "endpoint doesn't exist yet"
 * from a real failure, #820 stage 1) does not have to parse it back out of
 * the message string.
 */
class EngineHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'EngineHttpError';
  }
}

/** One JSON request against the engine, with a timeout. Throws a message that
 *  names the endpoint — these surface directly in CLI output, so "fetch
 *  failed" alone would be useless. */
async function engineRequest<T>(
  baseUrl: string,
  path: string,
  init: { method: 'GET' | 'POST' | 'DELETE'; body?: unknown; timeoutMs?: number },
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: init.method,
      headers: { 'Content-Type': 'application/json' },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new EngineHttpError(
        response.status,
        `${path} failed ${response.status}: ${detail.slice(0, 200)}`,
      );
    }
    // A dispatched-work response (202) legitimately has no body. Anything
    // else that fails to parse is a BROKEN response — an engine mid-restart, a
    // truncated write, a proxy error page — and must throw. Swallowing it to
    // `{}` would hand every caller a plausible-looking wrong answer: an empty
    // catalogue rendered as "no models on disk", or a reachable-but-broken
    // engine reported as healthy.
    const body = await response.text();
    if (body.trim().length === 0) return {} as T;
    try {
      return JSON.parse(body) as T;
    } catch (err) {
      throw new Error(
        `${path} returned ${response.status} with an unparsable body (${body.slice(0, 120)}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

/** The engine's model catalogue. */
export async function listModels(baseUrl: string, timeoutMs?: number): Promise<EngineModelCatalog> {
  const raw = await engineRequest<{ current?: string; available?: EngineModel[] }>(
    baseUrl,
    '/v1/llm/models',
    { method: 'GET', ...(timeoutMs === undefined ? {} : { timeoutMs }) },
  );
  return { current: raw.current ?? '', available: raw.available ?? [] };
}

/** Current load/download state. */
export async function getStatus(baseUrl: string, timeoutMs?: number): Promise<EngineStatus> {
  return await engineRequest<EngineStatus>(baseUrl, '/v1/llm/status', {
    method: 'GET',
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

/**
 * Is an engine answering on `baseUrl`? Never throws — the whole point is to
 * turn "nothing is listening" into a reportable value instead of an exception
 * or, worse, a silent fallthrough that leaves auto-approve permanently
 * escalating without ever saying why (#818).
 */
export async function probeEngine(baseUrl: string, timeoutMs = 2_000): Promise<EngineProbe> {
  try {
    const status = await getStatus(baseUrl, timeoutMs);
    return { reachable: true, status };
  } catch (err) {
    return { reachable: false, reason: errorToString(err) };
  }
}

/** Dispatch a load WITHOUT waiting (HTTP 202). Idempotent on the engine side:
 *  a second dispatch for a model already loading joins the same task. */
export async function preloadAsync(
  baseUrl: string,
  model: string,
  timeoutMs?: number,
): Promise<void> {
  await engineRequest(baseUrl, '/v1/llm/preload', {
    method: 'POST',
    body: { model },
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

/** Free a model's weights. See the module doc: the CALLER decides whether remi
 *  is entitled to do this (never under a shared engine). */
export async function unloadModel(
  baseUrl: string,
  model: string,
  timeoutMs?: number,
): Promise<void> {
  await engineRequest(baseUrl, '/v1/llm/unload', {
    method: 'POST',
    body: { model },
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

/**
 * Thrown by `clearModelCache` when the engine does not implement the
 * cache-clear route (404, or 501 if it recognizes the path but declines it)
 * -- distinguishing "this engine build predates #820 stage 1" from a real
 * failure. `ModelResidency` treats this as permanent for the process's life
 * (retrying a route that will never exist is pure waste) rather than the
 * transient-failure retry it gives every other error here.
 */
export class ClearCacheUnsupportedError extends Error {}

/**
 * Drop the retained prompt-KV cache for `model` -- or, when omitted, every
 * currently loaded tier -- WITHOUT freeing weights (#820 stage 1). Cheaper
 * than `unloadModel`: recomputing a prefix costs a few hundred ms, a cold
 * reload costs seconds. See the module doc for why this is a SEPARATE verb
 * from unload rather than a flag on it: residency (loaded/not) and cache
 * retention are independent engine states, and only unload touches the
 * former.
 *
 * `ModelResidency` (#818 ownership-gated, same as `unloadModel`) is the one
 * production caller, and it always omits `model`: stage 1 only ever arms
 * when remi owns the engine outright, so "every loaded tier" already means
 * "everything remi could have loaded" -- there is no other module's
 * residency to accidentally spare or clear.
 */
export async function clearModelCache(
  baseUrl: string,
  model?: string,
  timeoutMs?: number,
): Promise<readonly string[]> {
  try {
    const raw = await engineRequest<{ cleared?: string[] }>(baseUrl, '/v1/llm/clear-cache', {
      method: 'POST',
      body: model === undefined ? {} : { model },
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    return raw.cleared ?? [];
  } catch (err) {
    if (err instanceof EngineHttpError && (err.status === 404 || err.status === 501)) {
      throw new ClearCacheUnsupportedError(err.message);
    }
    throw err;
  }
}

/** One row of `GET /v1/models` — the DISK view. Distinct from `EngineModel`
 *  (the residency view): `sizeBytes` here is the real measured on-disk
 *  footprint, and `deletable` is the engine's own judgement about whether the
 *  app may offer to remove it (false for the active model). */
export interface ManagedModel {
  readonly id: string;
  readonly module: string;
  readonly displayName: string;
  readonly sizeBytes: number;
  /** On disk (or bundled): loadable with no download. */
  readonly cached: boolean;
  readonly loaded: boolean;
  readonly isActive: boolean;
  readonly deletable: boolean;
  /** Registered HuggingFace repo id (yooz-engine#308). Absent for disk-swept
   *  hub directories, whose id is already the flattened repo name, and on
   *  engines older than 0.7.8. */
  readonly huggingFaceID?: string | undefined;
}

/** `GET /v1/models` — every module's models, not just the LLM's. */
export async function listManagedModels(
  baseUrl: string,
  timeoutMs?: number,
): Promise<readonly ManagedModel[]> {
  const raw = await engineRequest<{ models?: ManagedModel[] }>(baseUrl, '/v1/models', {
    method: 'GET',
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return raw.models ?? [];
}

/** `DELETE /v1/models/:id` — reclaim a model's disk. Returns the bytes freed.
 *  The engine refuses to delete the active model, so callers should check
 *  `deletable` first and report the engine's own refusal otherwise. */
export async function deleteModel(
  baseUrl: string,
  id: string,
  timeoutMs?: number,
): Promise<{ id: string; reclaimedBytes: number }> {
  const raw = await engineRequest<{ id?: string; reclaimedBytes?: number }>(
    baseUrl,
    `/v1/models/${encodeURIComponent(id)}`,
    { method: 'DELETE', ...(timeoutMs === undefined ? {} : { timeoutMs }) },
  );
  return { id: raw.id ?? id, reclaimedBytes: raw.reclaimedBytes ?? 0 };
}

/** `POST /v1/models/cleanup` — the engine's one-shot disk-hygiene sweep. */
export async function cleanupModels(
  baseUrl: string,
  timeoutMs?: number,
): Promise<{ totalReclaimedBytes: number; perRepo: Record<string, number> }> {
  const raw = await engineRequest<{
    totalReclaimedBytes?: number;
    perRepo?: Record<string, number>;
  }>(baseUrl, '/v1/models/cleanup', {
    method: 'POST',
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return { totalReclaimedBytes: raw.totalReclaimedBytes ?? 0, perRepo: raw.perRepo ?? {} };
}

/** `POST /v1/touchup/download` — fetch weights WITHOUT changing which model is
 *  active. The LLM models remi evaluates with are the touch-up picker's, which
 *  is why the download verb lives under that path rather than `/v1/llm`. */
export async function startDownload(
  baseUrl: string,
  id: string,
  timeoutMs?: number,
): Promise<void> {
  await engineRequest(baseUrl, '/v1/touchup/download', {
    method: 'POST',
    body: { id },
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

/** `POST /v1/touchup/download/cancel` — abort an in-flight fetch. */
export async function cancelDownload(
  baseUrl: string,
  id: string,
  timeoutMs?: number,
): Promise<void> {
  await engineRequest(baseUrl, '/v1/touchup/download/cancel', {
    method: 'POST',
    body: { id },
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

/** One row of the `touchup` module in `GET /v1/state` — the PER-MODEL view of
 *  load/download state. */
export interface ModelStateRow {
  readonly id: string;
  readonly displayName?: string | undefined;
  readonly sizeBytes?: number | undefined;
  /**
   * `unavailable` | `available` | `cached` | `loaded` — the engine's
   * `ModelLoadState` (`ModelPicker.swift`).
   *
   * NOT the `idle`/`loading`/`ready`/`failed` `LoadState` enum: that one is
   * `LLMStatus.state` on `/v1/llm/status`, a DIFFERENT type on a different
   * endpoint. There is no `failed` case here — a failed fetch reverts the row
   * to `available`, and the snapshot row carries no `message`/`lastError` to
   * say why (only the `/v1/events` `loadStateChanged` frame does). See
   * `pullModel` for how failure is inferred without it.
   */
  readonly loadState?: string | undefined;
  readonly isActive?: boolean | undefined;
  /** Fraction [0,1) while THIS row is fetching, else absent. */
  readonly downloadProgress?: number | undefined;
}

/**
 * Per-model load/download state from `GET /v1/state` (engine#292 added the
 * per-row `downloadProgress` precisely so a consumer can answer "how is THIS
 * download doing?" on demand, without depending on catching event frames).
 *
 * This is the endpoint to use for a specific model. `/v1/llm/status` reports
 * only the ACTIVE tier, so reading it while pulling a non-active model gives
 * you a different model's state — including, disastrously, a different
 * model's `failed`.
 *
 * The LLM models remi uses are the `touchup` module's rows.
 */
export async function getModelState(
  baseUrl: string,
  id: string,
  timeoutMs?: number,
): Promise<ModelStateRow | undefined> {
  const raw = await engineRequest<{
    modules?: Array<{ module?: string; models?: ModelStateRow[] }>;
  }>(baseUrl, '/v1/state', { method: 'GET', ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  for (const mod of raw.modules ?? []) {
    const row = (mod.models ?? []).find((m) => m.id === id);
    if (row !== undefined) return row;
  }
  return undefined;
}

/** Progress report for an in-flight pull, handed to the CLI's renderer. */
export interface PullProgress {
  /** 0..1 when the engine reports a download fraction for THIS model.
   *  Frequently near-useless — see `advancing`. */
  readonly fraction?: number | undefined;
  readonly state?: string | undefined;
  /** Total download size, when the engine knows it. The honest thing to show
   *  when the fraction is not moving. */
  readonly sizeBytes?: number | undefined;
  /** Milliseconds since the pull started. */
  readonly elapsedMs: number;
  /**
   * False when the fraction has not moved since the pull began — the normal
   * case for a single-big-file repo (both of remi's LLM tiers are one
   * multi-GB `model.safetensors` plus small files). The engine's parent
   * `Progress` advances per completed FILE, so the fraction steps ~0.6% and
   * then sits there until the whole thing lands; yooz-engine#293 measured the
   * byte-on-disk alternative and found the big file is staged outside the hub
   * directory, so that is equally flat, and assigned the honest finish to
   * consumers. A renderer MUST NOT show a percentage when this is false — it
   * reads as a stalled download. Show elapsed + size instead.
   */
  readonly advancing: boolean;
}

export interface PullOptions {
  /** Called on each poll so the caller can render a progress bar. */
  readonly onProgress?: (progress: PullProgress) => void;
  /** Poll interval. */
  readonly pollMs?: number;
  /** Give up after this long with no completion. Generous by default: this
   *  covers a multi-GB HuggingFace download on a slow link. */
  readonly timeoutMs?: number;
  /** Clock + sleep seams so tests do not wait in real time. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** `ModelLoadState` values that mean the weights are on disk. Either one ends
 *  a pull; `loaded` additionally means resident, which a download does not
 *  itself cause but a concurrent preload might. */
const DISK_STATES: ReadonlySet<string> = new Set(['cached', 'loaded']);

/**
 * Download `model` and wait until it is on disk (#819's `remi model pull`).
 *
 * Uses the EXPLICIT download endpoint, not `preload`: fetching weights and
 * making a model resident are different acts, and the download endpoint is the
 * one that does not disturb which model is currently active.
 *
 * Per-model state comes from `GET /v1/state` (`getModelState`), NOT
 * `/v1/llm/status` — the latter reports only the active tier, so pulling a
 * non-active model would read some other model's state.
 *
 * **Failure detection is inferential, because the contract gives us nothing
 * better.** `/v1/state` rows carry `ModelLoadState`, which has no `failed`
 * case and no error field: a failed fetch reverts the row to `available`
 * exactly as if it had never started (the reason exists only on an
 * `/v1/events` frame, which a polling client does not see). So a pull is
 * judged failed when a download that WAS in flight — we saw a
 * `downloadProgress` for it — stops being in flight without the model
 * becoming available on disk. Requiring that we observed progress first is
 * what keeps the check from firing in the gap between dispatching the
 * download and the engine registering it. Filed as yooz-engine#298.
 *
 * Completion is `cached`/`loaded` on the row, or `cached` in the inventory —
 * the engine's own "loadable without a download" answer, and the only
 * reliable completion signal for our tiers, whose fraction steps ~0.6% and
 * then sits until the whole file lands.
 */
export async function pullModel(
  baseUrl: string,
  model: string,
  opts: PullOptions = {},
): Promise<void> {
  const pollMs = opts.pollMs ?? 1_000;
  const timeoutMs = opts.timeoutMs ?? 30 * 60_000;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  // Already on disk: nothing to fetch. Cheap, and it makes `pull` idempotent.
  const before = await listManagedModels(baseUrl).catch(() => [] as readonly ManagedModel[]);
  if (before.some((m) => m.id === model && m.cached)) return;

  // Deliberately NOT wrapped: an unknown model id is a 400 from the engine and
  // must fail immediately with that message, not enter the poll loop.
  await startDownload(baseUrl, model);

  const started = now();
  const deadline = started + timeoutMs;
  let firstFraction: number | undefined;
  let sawInFlight = false;
  let consecutiveUnreachable = 0;
  for (;;) {
    const row = await getModelState(baseUrl, model).catch(() => undefined);
    if (row === undefined) {
      // Distinguish "engine went away" from "slow download" — otherwise a
      // crash mid-pull is indistinguishable from progress for 30 minutes.
      consecutiveUnreachable += 1;
      if (consecutiveUnreachable >= 3) {
        const probe = await probeEngine(baseUrl);
        if (!probe.reachable) {
          throw new Error(
            `engine stopped answering during the download of ${model}: ${probe.reason}`,
          );
        }
      }
    } else {
      consecutiveUnreachable = 0;
      if (firstFraction === undefined) firstFraction = row.downloadProgress;
      const inFlight = row.downloadProgress !== undefined;
      if (inFlight) sawInFlight = true;
      const advancing =
        row.downloadProgress !== undefined &&
        firstFraction !== undefined &&
        row.downloadProgress > firstFraction;
      opts.onProgress?.({
        fraction: row.downloadProgress,
        state: row.loadState,
        sizeBytes: row.sizeBytes,
        elapsedMs: now() - started,
        advancing,
      });

      if (row.loadState !== undefined && DISK_STATES.has(row.loadState)) return;
      if (sawInFlight && !inFlight) {
        throw new Error(
          `the download of ${model} stopped without the model becoming available; check the engine log (the engine reports no reason on this endpoint, yooz-engine#298)`,
        );
      }
    }

    const inventory = await listManagedModels(baseUrl).catch(
      () => undefined as readonly ManagedModel[] | undefined,
    );
    if (inventory?.some((m) => m.id === model && m.cached)) return;

    if (now() >= deadline) {
      throw new Error(
        `timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${model} to download; ` +
          `cancel it with "remi model cancel ${model}" if it is wedged`,
      );
    }
    await sleep(pollMs);
  }
}
