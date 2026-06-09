import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  chatCompletion,
  ollamaNativeBase,
  resolveProviderUrl,
} from '../../src/auto-approve/llm-client.ts';

describe('resolveProviderUrl', () => {
  test('resolves "ollama" to localhost:11434', () => {
    expect(resolveProviderUrl('ollama', '')).toBe('http://localhost:11434/v1');
  });

  test('resolves "openrouter" to openrouter.ai', () => {
    expect(resolveProviderUrl('openrouter', '')).toBe('https://openrouter.ai/api/v1');
  });

  test('passes through http URLs as-is', () => {
    expect(resolveProviderUrl('http://my-server:8080/v1', '')).toBe('http://my-server:8080/v1');
  });

  test('passes through https URLs as-is', () => {
    expect(resolveProviderUrl('https://api.example.com/v1', '')).toBe('https://api.example.com/v1');
  });

  test('falls back to fallbackUrl for unknown providers', () => {
    expect(resolveProviderUrl('unknown', 'http://fallback:9999/v1')).toBe(
      'http://fallback:9999/v1',
    );
  });

  test('falls back to empty string for unknown provider with no fallback', () => {
    expect(resolveProviderUrl('unknown', '')).toBe('');
  });
});

describe('ollamaNativeBase', () => {
  test('strips a trailing /v1 (the OpenAI-compat path) to reach /api/chat', () => {
    expect(ollamaNativeBase('http://localhost:11434/v1')).toBe('http://localhost:11434');
    expect(ollamaNativeBase('http://localhost:11434/v1/')).toBe('http://localhost:11434');
  });
  test('leaves a non-/v1 base untouched', () => {
    expect(ollamaNativeBase('http://localhost:11434')).toBe('http://localhost:11434');
  });
});

describe('chatCompletion transports', () => {
  // A real local server (no mocks) records the path + body each transport sends.
  let server: ReturnType<typeof Bun.serve>;
  let last: { path: string; body: Record<string, unknown> } | null = null;
  let baseUrl = '';

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        const body = (await req.json()) as Record<string, unknown>;
        last = { path: url.pathname, body };
        if (url.pathname === '/api/chat') {
          // Ollama native shape.
          return Response.json({
            model: 'm',
            message: { role: 'assistant', content: '{"decision":"approve","reasoning":"ok"}' },
            prompt_eval_count: 10,
            eval_count: 5,
          });
        }
        // OpenAI-compat shape.
        return Response.json({
          model: 'm',
          choices: [{ message: { content: '{"decision":"approve","reasoning":"ok"}' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        });
      },
    });
    baseUrl = `http://localhost:${server.port}/v1`;
  });

  afterAll(() => server.stop(true));

  const msgs = [
    { role: 'system' as const, content: 'sys' },
    { role: 'user' as const, content: 'u' },
  ];

  test('ollama transport hits /api/chat with think:false and parses message.content', async () => {
    const r = await chatCompletion(
      { baseUrl, apiKey: '', model: 'm', timeoutMs: 5000, kind: 'ollama' },
      msgs,
    );
    expect(last?.path).toBe('/api/chat');
    expect(last?.body['think']).toBe(false);
    expect(last?.body['stream']).toBe(false);
    expect(r.content).toContain('approve');
    expect(r.usage?.completion_tokens).toBe(5);
  });

  test('openai transport hits /chat/completions and parses choices[0]', async () => {
    const r = await chatCompletion({ baseUrl, apiKey: '', model: 'm', timeoutMs: 5000 }, msgs);
    expect(last?.path).toBe('/v1/chat/completions');
    expect(last?.body['think']).toBeUndefined();
    expect(r.content).toContain('approve');
  });
});
