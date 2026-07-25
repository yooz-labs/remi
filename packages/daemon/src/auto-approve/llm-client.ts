import { errorToString } from '@remi/shared';
/**
 * Chat-completions client for the auto-approve evaluator.
 *
 * Two transports:
 *  - 'openai': the OpenAI-compatible /v1/chat/completions (OpenRouter, a thin
 *    llama.cpp server on non-Apple-Silicon hosts, or any custom URL).
 *  - 'yooz': the Yooz engine's native /v1/llm/generate (loopback :19924 on
 *    macOS -- see yooz-engine's LLMModule / CONSUMER_INTEGRATION.md). llama.cpp's
 *    server already speaks the OpenAI-compatible shape, so it reuses 'openai'
 *    unchanged; only the engine needed its own transport.
 *
 * `disableThinking` ('yooz' only) prefixes the engine's own `/no_think` prompt
 * convention (see yooz-engine's YoozPrompts.swift, whose Quality-tier prompts
 * use the same prefix) onto the system prompt to turn OFF the model's Qwen3-
 * style chain-of-thought reasoning -- for a quick approve/deny classify the
 * reasoning is pure latency (a 4B model spends most of its tokens "thinking").
 * `LLMGenerateRequest` (the engine's wire type) has no request-level knob for
 * this; `/no_think` is a chat-template convention the model itself recognizes,
 * the same mechanism the engine's own built-in prompts rely on. No effect on
 * 'openai' providers (no equivalent there either).
 */

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface LLMClientConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs: number;
  /**
   * Transport. 'yooz' speaks the engine's native /v1/llm/generate. Defaults to
   * 'openai' (the OpenAI-compatible /v1 endpoint -- OpenRouter, llama.cpp, custom).
   */
  readonly kind?: 'openai' | 'yooz';
  /**
   * 'yooz' kind only: see the module doc comment above for what this does and
   * why it lives here instead of on `kind`. Ignored for 'openai'.
   */
  readonly disableThinking?: boolean;
}

export interface LLMResponse {
  readonly content: string;
  readonly model: string;
  readonly usage?:
    | {
        readonly prompt_tokens: number;
        readonly completion_tokens: number;
      }
    | undefined;
}

/**
 * Well-known provider shortnames mapped to base URLs. 'yooz' and 'llamacpp'
 * both target remi's reserved loopback port (19924 -- see
 * ../yooz/AGENTS_master.md "Per-app port isolation"); only one runs at a time
 * per the platform probe (engine on Apple Silicon, llama.cpp elsewhere).
 * 'yooz' has no trailing /v1 -- its paths (`/v1/llm/generate`, etc.) are built
 * in `chatCompletion`/`warmModel` from the bare root. 'llamacpp' keeps the
 * /v1 suffix because it is dispatched through the 'openai' kind, which appends
 * `/chat/completions` directly.
 */
const PROVIDER_URLS: Record<string, string> = {
  yooz: 'http://127.0.0.1:19924',
  llamacpp: 'http://127.0.0.1:19924/v1',
  openrouter: 'https://openrouter.ai/api/v1',
};

/**
 * Resolve a provider string to a base URL.
 * Accepts 'yooz', 'llamacpp', 'openrouter', or a full URL.
 */
export function resolveProviderUrl(provider: string, fallbackUrl: string): string {
  const known = PROVIDER_URLS[provider];
  if (known !== undefined) {
    return known;
  }
  // Treat as custom URL if it looks like one
  if (provider.startsWith('http://') || provider.startsWith('https://')) {
    return provider;
  }
  return fallbackUrl;
}

/**
 * Split the auto-approve evaluator's fixed system+user message pair into the
 * engine's `{ prompt, systemPrompt }` shape (`LLMGenerateRequest` has no
 * multi-turn message array). Every caller (prompt-builder.ts, multichoice.ts)
 * sends exactly one system and one user message; any additional non-system
 * messages are defensively joined into the prompt rather than dropped.
 */
function splitForYoozGenerate(messages: readonly ChatMessage[]): {
  systemPrompt: string | undefined;
  prompt: string;
} {
  const systemPrompt = messages.find((m) => m.role === 'system')?.content;
  const prompt = messages
    .filter((m) => m.role !== 'system')
    .map((m) => m.content)
    .join('\n\n');
  return { systemPrompt, prompt };
}

/** The engine's Qwen3-style reasoning-suppression convention (see the module
 *  doc comment above). Prefixed onto the system prompt, or the prompt itself
 *  when there is no system message. */
const NO_THINK_PREFIX = '/no_think\n';

/**
 * Preload a model on the Yooz engine so a later request does not pay the cold
 * model-load penalty. Uses `POST /v1/llm/preload?wait=true` -- the blocking
 * variant (see yooz-engine's APIServer.swift `/v1/llm/preload` handler; the
 * default is fire-and-forget/202, `?wait=true` opts into awaiting the load) --
 * so the returned promise only resolves once the model is actually resident.
 * Throws on network errors or non-2xx responses; the caller treats it as
 * best-effort.
 *
 * The engine has no keep-alive-duration concept (a model stays resident until
 * `/v1/llm/unload` or the engine's own eviction policy) -- there is no such
 * duration parameter to pass here.
 */
export async function warmModel(
  baseUrl: string,
  model: string,
  timeoutMs = 120_000,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/v1/llm/preload?wait=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`warm-up failed ${response.status}: ${body.slice(0, 200)}`);
    }
    // Drain the body so the connection is released promptly.
    await response.json().catch(() => undefined);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send a chat completion request. Throws on network errors, timeouts, or
 * non-200 responses.
 *
 * If `externalSignal` is provided and aborts before the request completes,
 * the fetch is aborted and the abort propagates as a DOMException
 * (name='AbortError'). Callers can distinguish a timeout from an external
 * cancel by inspecting their own signal, not the thrown error.
 */
export async function chatCompletion(
  config: LLMClientConfig,
  messages: readonly ChatMessage[],
  externalSignal?: AbortSignal,
): Promise<LLMResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const onExternalAbort = (): void => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.apiKey) {
    headers['Authorization'] = `Bearer ${config.apiKey}`;
  }

  const yooz = config.kind === 'yooz';
  const url = yooz ? `${config.baseUrl}/v1/llm/generate` : `${config.baseUrl}/chat/completions`;
  // Yooz engine: `{ prompt, systemPrompt, model }`, no JSON-forcing knob (the
  // system prompt already says "Respond with JSON ONLY" -- the same technique
  // the engine's own built-in prompts use, since /v1/llm/generate has no
  // response_format field to force it). OpenAI-compat: temperature 0 +
  // json_object response format.
  let body: Record<string, unknown>;
  if (yooz) {
    const { systemPrompt, prompt } = splitForYoozGenerate(messages);
    const noThink = config.disableThinking ? NO_THINK_PREFIX : '';
    body =
      systemPrompt !== undefined
        ? { model: config.model, prompt, systemPrompt: `${noThink}${systemPrompt}` }
        : { model: config.model, prompt: `${noThink}${prompt}` };
  } else {
    body = {
      model: config.model,
      messages,
      temperature: 0,
      response_format: { type: 'json_object' },
    };
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errBody = await response.text().catch((e) => `[body unreadable: ${errorToString(e)}]`);
      throw new Error(`LLM API error ${response.status}: ${errBody.slice(0, 200)}`);
    }

    // biome-ignore lint/suspicious/noExplicitAny: provider response shapes differ
    const data: any = await response.json();

    if (yooz) {
      const content = data.text;
      if (!content) throw new Error('LLM response missing content (yooz /v1/llm/generate)');
      return {
        content,
        model: data.model ?? config.model,
        // The engine reports only a completion-side count (`tokensGenerated`);
        // it has no prompt-token figure, so prompt_tokens is always 0 here.
        usage:
          typeof data.tokensGenerated === 'number'
            ? { prompt_tokens: 0, completion_tokens: data.tokensGenerated }
            : undefined,
      };
    }

    const choice = data.choices?.[0];
    if (!choice?.message?.content) {
      throw new Error('LLM response missing content');
    }
    return {
      content: choice.message.content,
      model: data.model ?? config.model,
      usage: data.usage
        ? {
            prompt_tokens: data.usage.prompt_tokens,
            completion_tokens: data.usage.completion_tokens,
          }
        : undefined,
    };
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
  }
}
