import { errorToString } from '@remi/shared';
/**
 * Chat-completions client for the auto-approve evaluator.
 *
 * Two transports:
 *  - 'openai': the OpenAI-compatible /v1/chat/completions (OpenRouter, custom).
 *  - 'ollama': Ollama's NATIVE /api/chat, so we can pass `think: false` and turn
 *    OFF the model's reasoning. The OpenAI-compat /v1 endpoint has no way to
 *    disable thinking, and for a quick approve/deny classify the reasoning is
 *    pure latency (a 4B model spends most of its tokens "thinking"). When we
 *    move to the Yooz engine this stays a clean transport seam.
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
   * Transport. 'ollama' uses the native /api/chat with `think: false` (no
   * reasoning). Defaults to 'openai' (the OpenAI-compatible /v1 endpoint).
   */
  readonly kind?: 'openai' | 'ollama';
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

/** Well-known provider shortnames mapped to base URLs */
const PROVIDER_URLS: Record<string, string> = {
  ollama: 'http://localhost:11434/v1',
  openrouter: 'https://openrouter.ai/api/v1',
};

/**
 * Resolve a provider string to a base URL.
 * Accepts 'ollama', 'openrouter', or a full URL.
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
 * Derive the Ollama NATIVE API root (…/api/chat) from a base URL that may end
 * in /v1 (the OpenAI-compat path). `http://h:11434/v1` -> `http://h:11434`.
 * Exported for testing.
 */
export function ollamaNativeBase(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, '');
}

/**
 * Warm-load an Ollama model so a later request does not pay the cold model-load
 * penalty. Uses the native /api/generate with an EMPTY prompt (the documented
 * load-only call) and a long `keep_alive` so the model stays resident. Throws on
 * network errors or non-200 responses; the caller treats it as best-effort.
 *
 * `keepAlive` accepts Ollama's duration string ("30m", "-1" for forever).
 */
export async function warmModel(
  baseUrl: string,
  model: string,
  keepAlive = '30m',
  timeoutMs = 120_000,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${ollamaNativeBase(baseUrl)}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: '', keep_alive: keepAlive, stream: false }),
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

  const ollama = config.kind === 'ollama';
  const url = ollama
    ? `${ollamaNativeBase(config.baseUrl)}/api/chat`
    : `${config.baseUrl}/chat/completions`;
  // Ollama native: `think: false` disables reasoning; `format: 'json'` forces a
  // JSON body. OpenAI-compat: temperature 0 + json_object response format.
  const body = ollama
    ? {
        model: config.model,
        messages,
        stream: false,
        think: false,
        format: 'json',
        options: { temperature: 0 },
      }
    : {
        model: config.model,
        messages,
        temperature: 0,
        response_format: { type: 'json_object' },
      };

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

    if (ollama) {
      const content = data.message?.content;
      if (!content) throw new Error('LLM response missing content (ollama /api/chat)');
      return {
        content,
        model: data.model ?? config.model,
        usage:
          data.prompt_eval_count != null || data.eval_count != null
            ? {
                prompt_tokens: data.prompt_eval_count ?? 0,
                completion_tokens: data.eval_count ?? 0,
              }
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
