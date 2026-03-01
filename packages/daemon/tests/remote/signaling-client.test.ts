import { describe, expect, test } from 'bun:test';
import { SignalingClient } from '../../src/remote/signaling-client.ts';

describe('SignalingClient', () => {
  test('connectionCode is null before connect', () => {
    const client = new SignalingClient('wss://example.com/connect');
    expect(client.connectionCode).toBeNull();
    expect(client.isConnected).toBe(false);
  });

  test('connect with provided code uses that code', () => {
    const client = new SignalingClient('wss://example.com/connect');
    // connect() will try to create a WebSocket which will fail in test,
    // but we can verify the code is set before the WebSocket is created
    try {
      client.connect('WXYZ-5678');
    } catch {
      // WebSocket creation may fail in test environment
    }
    expect(client.connectionCode).toBe('WXYZ-5678');
    client.close();
  });

  test('connect without code generates one', () => {
    const client = new SignalingClient('wss://example.com/connect');
    try {
      client.connect();
    } catch {
      // WebSocket creation may fail in test environment
    }
    const code = client.connectionCode;
    expect(code).not.toBeNull();
    expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789]{4}$/);
    client.close();
  });

  test('close sets isConnected to false', () => {
    const client = new SignalingClient('wss://example.com/connect');
    client.close();
    expect(client.isConnected).toBe(false);
  });
});
