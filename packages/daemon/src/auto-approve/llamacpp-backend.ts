/**
 * The llama.cpp half of the local-eval backend (#822 Phase B, slice 1).
 *
 * `EngineHost` (#818) already owns the hard part — attach-first, claim before
 * spawning, resolve the redundant-start race, never reap on exit — and none of
 * that is engine-specific. So llama.cpp reuses the class outright and supplies
 * only what actually differs: how the process is launched, and how you ask it
 * whether it is up.
 *
 * WHAT REMI DOES NOT DO HERE, deliberately. It does not download or install
 * `llama-server`. #822's own scope says "remi owns download + process
 * lifetime", and this module implements the second half only. Supervising a
 * binary the user installed is a different trust proposition from fetching and
 * executing a third-party binary across an arch matrix: the macOS path fetches
 * a PINNED artifact from a release remi controls (#834), which llama.cpp is
 * not. The install stays a documented step; the nohup does not.
 *
 * The GGUF itself is NOT remi's job either, which is a real narrowing of what
 * #822 assumed ("Download is remi's job. No engine to auto-pull from
 * HuggingFace"). `-hf` makes llama.cpp pull from HuggingFace on first run, so
 * the model half of Phase B is already solved by the transport.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { errorToString } from '@remi/shared';

const REMI_DIR = path.join(os.homedir(), '.remi');

/** Where a remi-started `llama-server`'s stdout/stderr go. Separate from
 *  `engine.log` so the two backends' diagnostics never interleave — only one
 *  can run per machine (the platform probe decides), but a machine that has
 *  run both over its life should not have to untangle one file. */
export const LLAMACPP_LOG_FILE = path.join(REMI_DIR, 'llama-server.log');

/** The executable remi looks for. Not configurable by design: `engine_path`
 *  already exists for "point at my own build", and it is backend-agnostic. */
export const LLAMA_SERVER_BIN = 'llama-server';

/**
 * Reachability against `llama-server`.
 *
 * Deliberately NOT `probeEngine`: that asks `/v1/llm/status`, which is the Yooz
 * engine's control plane and something llama.cpp has never served (#822 —
 * "llama-server has none of /v1/llm/{models,status,preload,unload}"). Pointing
 * the engine probe at it would report a permanently-unreachable backend that is
 * in fact answering evals perfectly well.
 *
 * `/health` is the right question and it distinguishes the two states that
 * matter during startup: 503 while the model is still loading, 200 once it can
 * serve. `waitForReady` polls this, so a cold multi-GB load reads as "not ready
 * yet" rather than as a failure.
 *
 * Never throws, for the same reason `probeEngine` never throws: "nothing is
 * listening" must be a reportable value, not an exception that escapes into a
 * silent permanent escalation (#818).
 */
export async function probeLlamaCpp(
  baseUrl: string,
  timeoutMs = 2_000,
): Promise<{ readonly reachable: boolean; readonly reason?: string }> {
  const url = healthUrl(baseUrl);
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    });
    // 200 = ready to serve. 503 = alive but still loading the GGUF, which is
    // NOT reachable for our purposes: dispatching an eval into a loading server
    // would burn the hook budget waiting. Report it as unreachable-with-reason
    // so the startup poll keeps waiting instead of giving up.
    if (res.ok) return { reachable: true };
    return { reachable: false, reason: `HTTP ${res.status} from ${url}` };
  } catch (err) {
    return { reachable: false, reason: errorToString(err) };
  }
}

/**
 * `<origin>/health` from an OpenAI-style base URL.
 *
 * The llamacpp base URL carries a `/v1` suffix (`llm-client.ts`'s
 * `PROVIDER_URLS`) because it is dispatched through the `openai` kind, which
 * appends `/chat/completions` directly. `/health` is served at the ROOT, not
 * under `/v1`, so naively joining would request `/v1/health` — the same
 * `/v1/v1/...` class of bug AGENTS.md already records for `warmModel`.
 */
export function healthUrl(baseUrl: string): string {
  try {
    return `${new URL(baseUrl).origin}/health`;
  } catch {
    // A malformed base URL is a config error that belongs to the caller; the
    // probe's contract is to report unreachable, not to throw. Returning the
    // input unchanged makes the fetch fail cleanly with the real reason.
    return baseUrl;
  }
}

/**
 * argv for `llama-server`.
 *
 * `-hf <repo>:<quant>` pulls from HuggingFace on first run and reuses the cache
 * after. The quant suffix is load-bearing: `-hf` with no tag prefers
 * `Q4_K_M`/`Q8_0` and the YoozLabs repos publish only `Q4_0`, so a bare repo id
 * resolves no file (see `defaultModel`).
 *
 * `--host` is pinned to loopback and NOT derived from `daemon.bind`. The eval
 * backend is remi's own sidecar, not a service anyone else may reach: widening
 * it would hand any host that can reach the port a free LLM, and after #880
 * that is precisely the class of default this repo just spent a release
 * closing.
 */
export function llamaServerArgs(model: string, port: number, host = '127.0.0.1'): string[] {
  return ['-hf', model, '--host', host, '--port', String(port)];
}

/**
 * Find `llama-server` on PATH.
 *
 * Returns the absolute path, or undefined when it is not installed — which
 * `EngineHost` turns into a reported `unavailable`, never a throw. Scans PATH
 * by hand rather than shelling out to `which`/`where`: this runs on the boot
 * path, a subprocess per boot to answer a filesystem question is waste, and the
 * seam stays synchronous so the caller does not have to be async to ask.
 */
export function resolveLlamaServer(
  env: NodeJS.ProcessEnv = process.env,
  isExecutable: (p: string) => boolean = defaultIsExecutable,
): string | undefined {
  const rawPath = env['PATH'];
  if (rawPath === undefined || rawPath.length === 0) return undefined;
  // `delimiter` rather than a literal ':' — Windows uses ';' and, while no
  // local backend exists there today (`detectLocalLLMPlatform` returns
  // 'unsupported'), a resolver that silently returns nothing on one platform
  // for a reason unrelated to the actual question is a trap for whoever adds
  // that support later.
  for (const dir of rawPath.split(path.delimiter)) {
    if (dir.length === 0) continue;
    const candidate = path.join(dir, LLAMA_SERVER_BIN);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

function defaultIsExecutable(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    // A directory can carry the execute bit (it means "traversable"), so the
    // access check alone would happily return a path that cannot be spawned.
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * What to tell a user who has no `llama-server`.
 *
 * Shared by the boot path and the host's unavailable reason so the two can
 * never drift into naming different remedies — the failure mode AGENTS.md
 * records for `help.ts` still claiming `default: 0.0.0.0` after the default
 * moved.
 */
export function llamaServerMissingHint(): string {
  return `${LLAMA_SERVER_BIN} is not on PATH, so remi has nothing to supervise. Install it once (remi does not download it, #822): "brew install llama.cpp", your distro's package, or a prebuilt binary from github.com/ggml-org/llama.cpp/releases. remi starts and stops it for you after that.`;
}
