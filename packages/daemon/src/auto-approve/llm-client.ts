/**
 * Minimal OpenAI-compatible chat completions client using raw fetch().
 *
 * Works with Ollama (localhost:11434/v1), OpenRouter, and any endpoint
 * that implements the OpenAI chat completions API.
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
 * Send a chat completion request to an OpenAI-compatible endpoint.
 * Throws on network errors, timeouts, or non-200 responses.
 */
export async function chatCompletion(
  config: LLMClientConfig,
  messages: readonly ChatMessage[],
): Promise<LLMResponse> {
  const url = `${config.baseUrl}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (config.apiKey) {
    headers['Authorization'] = `Bearer ${config.apiKey}`;
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: 0,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`LLM API error ${response.status}: ${body.slice(0, 200)}`);
    }

    // biome-ignore lint/suspicious/noExplicitAny: OpenAI response shape
    const data: any = await response.json();
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
  }
}
