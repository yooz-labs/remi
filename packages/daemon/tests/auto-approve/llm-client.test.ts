import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  chatCompletion,
  resolveProviderUrl,
  warmModel,
} from '../../src/auto-approve/llm-client.ts';

describe('resolveProviderUrl', () => {
  test('resolves "yooz" to the engine loopback root (:19924)', () => {
    expect(resolveProviderUrl('yooz', '')).toBe('http://127.0.0.1:19924');
  });

  test('resolves "llamacpp" to the loopback OpenAI-compat base (:19924/v1)', () => {
    expect(resolveProviderUrl('llamacpp', '')).toBe('http://127.0.0.1:19924/v1');
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

describe('chatCompletion transports', () => {
  // A real local server (no mocks) records the path + body each transport sends.
  let server: ReturnType<typeof Bun.serve>;
  let last: { path: string; body: Record<string, unknown> } | null = null;
  let rootUrl = '';
  let openaiBaseUrl = '';

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        const body = (await req.json()) as Record<string, unknown>;
        last = { path: url.pathname, body };
        if (url.pathname === '/v1/llm/generate') {
          // Yooz engine shape (LLMGenerateResponse).
          return Response.json({
            text: '{"decision":"approve","reasoning":"ok"}',
            model: 'm',
            tokensGenerated: 5,
            processingTimeMs: 12,
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
    rootUrl = `http://localhost:${server.port}`;
    openaiBaseUrl = `${rootUrl}/v1`;
  });

  afterAll(() => server.stop(true));

  const msgs = [
    { role: 'system' as const, content: 'sys' },
    { role: 'user' as const, content: 'u' },
  ];

  test('yooz transport hits /v1/llm/generate and splits system/user into systemPrompt/prompt', async () => {
    const r = await chatCompletion(
      { baseUrl: rootUrl, apiKey: '', model: 'm', timeoutMs: 5000, kind: 'yooz' },
      msgs,
    );
    expect(last?.path).toBe('/v1/llm/generate');
    expect(last?.body['model']).toBe('m');
    expect(last?.body['systemPrompt']).toBe('sys');
    expect(last?.body['prompt']).toBe('u');
    expect(r.content).toContain('approve');
    expect(r.model).toBe('m');
    expect(r.usage?.completion_tokens).toBe(5);
    expect(r.usage?.prompt_tokens).toBe(0);
  });

  test('yooz transport with disableThinking prefixes /no_think onto systemPrompt', async () => {
    await chatCompletion(
      {
        baseUrl: rootUrl,
        apiKey: '',
        model: 'm',
        timeoutMs: 5000,
        kind: 'yooz',
        disableThinking: true,
      },
      msgs,
    );
    expect(last?.body['systemPrompt']).toBe('/no_think\nsys');
    expect(last?.body['prompt']).toBe('u');
  });

  test('yooz transport with no system message prefixes /no_think onto prompt', async () => {
    await chatCompletion(
      {
        baseUrl: rootUrl,
        apiKey: '',
        model: 'm',
        timeoutMs: 5000,
        kind: 'yooz',
        disableThinking: true,
      },
      [{ role: 'user' as const, content: 'u only' }],
    );
    expect(last?.body['systemPrompt']).toBeUndefined();
    expect(last?.body['prompt']).toBe('/no_think\nu only');
  });

  test('openai transport hits /chat/completions and parses choices[0]', async () => {
    const r = await chatCompletion(
      { baseUrl: openaiBaseUrl, apiKey: '', model: 'm', timeoutMs: 5000 },
      msgs,
    );
    expect(last?.path).toBe('/v1/chat/completions');
    expect(last?.body['response_format']).toEqual({ type: 'json_object' });
    expect(last?.body['messages']).toEqual(msgs);
    expect(r.content).toContain('approve');
    expect(r.usage?.completion_tokens).toBe(5);
  });
});

describe('warmModel', () => {
  test('preloads via POST /v1/llm/preload?wait=true with the model in the body', async () => {
    const seen: { last: { path: string; search: string; body: Record<string, unknown> } | null } = {
      last: null,
    };
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        seen.last = { path: url.pathname, search: url.search, body };
        return Response.json({ id: body['model'], displayName: 'm', loaded: true });
      },
    });
    try {
      await warmModel(`http://localhost:${server.port}`, 'yooz-quality-v3');
      expect(seen.last?.path).toBe('/v1/llm/preload');
      expect(seen.last?.search).toBe('?wait=true');
      expect(seen.last?.body['model']).toBe('yooz-quality-v3');
    } finally {
      server.stop(true);
    }
  });

  test('throws on a non-2xx response', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async () => new Response('model not found', { status: 400 }),
    });
    try {
      await expect(warmModel(`http://localhost:${server.port}`, 'nonexistent')).rejects.toThrow(
        /warm-up failed 400/,
      );
    } finally {
      server.stop(true);
    }
  });
});
