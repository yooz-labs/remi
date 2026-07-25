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
      throw new Error(`${path} failed ${response.status}: ${detail.slice(0, 200)}`);
    }
    // A 202 (dispatched preload) has no body worth decoding; tolerate both.
    return (await response.json().catch(() => ({}))) as T;
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

/** Progress report for an in-flight pull, handed to the CLI's renderer. */
export interface PullProgress {
  /** 0..1 when the engine reports a download fraction; undefined while it is
   *  loading already-downloaded weights (no fraction to report). */
  readonly fraction?: number | undefined;
  readonly state?: string | undefined;
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

/** The engine's `ModelLoadState.failed`, which carries `lastError`. Success is
 *  NOT read from this field: `pullModel` judges doneness from the inventory
 *  (bytes on disk), and `loading`/`ready` describe RESIDENCY, which a download
 *  deliberately does not change. */
const STATE_FAILED = 'failed';

/**
 * Download `model` and wait until it is on disk (#819's `remi model pull`).
 *
 * Uses the EXPLICIT download endpoint, not `preload`: fetching weights and
 * making a model resident are different acts, and the download endpoint is the
 * one that does not disturb which model is currently active.
 *
 * Completion is judged from the INVENTORY (`cached: true` in `GET /v1/models`),
 * which the engine derives from bytes actually on disk — NOT from
 * `status.progress`, which yooz-engine#292 documents as publishing a single
 * near-zero sample and then freezing for the rest of the download. Progress is
 * still forwarded when it moves, so this gets better for free once that engine
 * bug is fixed, but nothing here depends on it.
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

  await startDownload(baseUrl, model);

  const deadline = now() + timeoutMs;
  for (;;) {
    // Status first (cheap, and carries the failure detail); inventory second
    // (authoritative for "is it actually down?").
    const status = await getStatus(baseUrl).catch(() => undefined);
    if (status !== undefined) {
      opts.onProgress?.({ fraction: status.progress, state: status.state });
      if (status.state === STATE_FAILED) {
        throw new Error(
          `engine failed to fetch ${model}: ${status.lastError ?? 'no detail reported'}`,
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
