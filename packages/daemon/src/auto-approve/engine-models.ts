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
 * Endpoint contract (yooz-engine `EndpointSpecs.swift`, wire types in
 * `YoozEngineWire/LLMWireTypes.swift`):
 *   - `GET  /v1/llm/models`  -> { current, available: [{id, displayName, sizeBytes, loaded, latencyHintMs}] }
 *   - `GET  /v1/llm/status`  -> { loaded, modelId, progress, state, lastError }
 *   - `POST /v1/llm/preload` -> 202 dispatch-and-poll; `?wait=true` blocks until resident
 *   - `POST /v1/llm/unload`  -> free that model's weights
 *   - `POST /v1/llm/model`   -> set the preferred model. PROCESS-LIFETIME ONLY:
 *     the engine forgets it on restart, which is why `remi model use` persists
 *     the choice in remi's own config instead of relying on this.
 *
 * Two contract details that are easy to get wrong and expensive to get wrong:
 *
 *   1. **A first-run pull must NOT use `?wait=true`.** The blocking variant
 *      holds the HTTP request open for the entire HuggingFace download, which
 *      for a multi-GB model exceeds any sane client timeout — the engine SDK
 *      says as much ("use for first-run pulls of large weights where the
 *      blocking call would HTTP-timeout"). `pullModel` therefore dispatches
 *      the 202 variant and polls `/v1/llm/status` for progress, which is also
 *      the only way to show the user anything while it runs.
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
  init: { method: 'GET' | 'POST'; body?: unknown; timeoutMs?: number },
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

/** Terminal states from the engine's `LoadState`. `ready` is success; `failed`
 *  carries `lastError`. Anything else (`loading`, `downloading`, absent on
 *  older builds) means keep polling. */
const STATE_READY = 'ready';
const STATE_FAILED = 'failed';

/**
 * Download + load `model`, reporting progress (#819's `remi model pull`).
 *
 * Dispatches the async preload, then polls `/v1/llm/status` until the model is
 * resident, the engine reports a failure, or the timeout expires. This is the
 * ONLY correct shape for a first-run pull — see the module doc for why
 * `?wait=true` cannot be used here.
 *
 * Completion is judged on `status.loaded` for the requested model (plus the
 * `state` field when the engine build provides one), so it also works against
 * older engines that report no `state`.
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

  await preloadAsync(baseUrl, model);

  const deadline = now() + timeoutMs;
  for (;;) {
    const status = await getStatus(baseUrl);
    opts.onProgress?.({ fraction: status.progress, state: status.state });

    if (status.state === STATE_FAILED) {
      throw new Error(
        `engine failed to load ${model}: ${status.lastError ?? 'no detail reported'}`,
      );
    }
    // `modelId` may lag or be absent on older builds; treat "loaded and either
    // unnamed or named as ours" as done rather than polling forever.
    if (status.loaded && (status.modelId === undefined || status.modelId === model)) return;
    if (status.state === STATE_READY) return;

    if (now() >= deadline) {
      const stalledAt =
        status.progress === undefined ? '' : ` (stalled at ${Math.round(status.progress * 100)}%)`;
      throw new Error(
        `timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${model} to load${stalledAt}`,
      );
    }
    await sleep(pollMs);
  }
}
