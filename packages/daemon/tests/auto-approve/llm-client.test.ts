import { describe, expect, test } from 'bun:test';
import { resolveProviderUrl } from '../../src/auto-approve/llm-client.ts';

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
