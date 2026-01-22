/**
 * Tests for signaling types.
 */

import { describe, expect, test } from 'bun:test';
import { type SignalingMessage, parseMessage, serializeMessage } from '../src/types.ts';

describe('parseMessage()', () => {
  test('parses register message', () => {
    const msg = parseMessage('{"type":"register"}');
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe('register');
  });

  test('parses registered message', () => {
    const msg = parseMessage(
      '{"type":"registered","code":"ABCD-1234","expiresAt":"2026-01-10T00:00:00.000Z"}',
    );
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe('registered');
    if (msg?.type === 'registered') {
      expect(msg.code).toBe('ABCD-1234');
      expect(msg.expiresAt).toBe('2026-01-10T00:00:00.000Z');
    }
  });

  test('parses join message', () => {
    const msg = parseMessage('{"type":"join","code":"ABCD-1234"}');
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe('join');
    if (msg?.type === 'join') {
      expect(msg.code).toBe('ABCD-1234');
    }
  });

  test('parses offer message', () => {
    const msg = parseMessage('{"type":"offer","sdp":"v=0\\r\\n..."}');
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe('offer');
  });

  test('parses answer message', () => {
    const msg = parseMessage('{"type":"answer","sdp":"v=0\\r\\n..."}');
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe('answer');
  });

  test('parses ice-candidate message', () => {
    const msg = parseMessage(
      '{"type":"ice-candidate","candidate":"candidate:...","sdpMid":"0","sdpMLineIndex":0}',
    );
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe('ice-candidate');
    if (msg?.type === 'ice-candidate') {
      expect(msg.sdpMid).toBe('0');
      expect(msg.sdpMLineIndex).toBe(0);
    }
  });

  test('parses error message', () => {
    const msg = parseMessage('{"type":"error","code":"INVALID","message":"Something went wrong"}');
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe('error');
    if (msg?.type === 'error') {
      expect(msg.code).toBe('INVALID');
      expect(msg.message).toBe('Something went wrong');
    }
  });

  test('parses peer-connected message', () => {
    const msg = parseMessage('{"type":"peer-connected","role":"client"}');
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe('peer-connected');
    if (msg?.type === 'peer-connected') {
      expect(msg.role).toBe('client');
    }
  });

  test('parses peer-disconnected message', () => {
    const msg = parseMessage('{"type":"peer-disconnected","role":"host"}');
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe('peer-disconnected');
    if (msg?.type === 'peer-disconnected') {
      expect(msg.role).toBe('host');
    }
  });

  test('returns null for invalid JSON', () => {
    expect(parseMessage('not json')).toBeNull();
    expect(parseMessage('{invalid')).toBeNull();
  });

  test('returns null for missing type', () => {
    expect(parseMessage('{"code":"ABCD-1234"}')).toBeNull();
  });

  test('returns null for invalid type', () => {
    expect(parseMessage('{"type":"unknown-type"}')).toBeNull();
  });

  test('returns null for non-string type', () => {
    expect(parseMessage('{"type":123}')).toBeNull();
  });

  test('returns null for non-object', () => {
    expect(parseMessage('"string"')).toBeNull();
    expect(parseMessage('123')).toBeNull();
    expect(parseMessage('null')).toBeNull();
    expect(parseMessage('[]')).toBeNull();
  });
});

describe('serializeMessage()', () => {
  test('serializes register message', () => {
    const msg: SignalingMessage = { type: 'register' };
    const json = serializeMessage(msg);
    expect(JSON.parse(json)).toEqual({ type: 'register' });
  });

  test('serializes registered message', () => {
    const msg: SignalingMessage = {
      type: 'registered',
      code: 'ABCD-1234',
      expiresAt: '2026-01-10T00:00:00.000Z',
    };
    const json = serializeMessage(msg);
    const parsed = JSON.parse(json);
    expect(parsed.type).toBe('registered');
    expect(parsed.code).toBe('ABCD-1234');
  });

  test('serializes offer message', () => {
    const msg: SignalingMessage = {
      type: 'offer',
      sdp: 'v=0\r\n...',
    };
    const json = serializeMessage(msg);
    const parsed = JSON.parse(json);
    expect(parsed.type).toBe('offer');
    expect(parsed.sdp).toBe('v=0\r\n...');
  });

  test('serializes ice-candidate message', () => {
    const msg: SignalingMessage = {
      type: 'ice-candidate',
      candidate: 'candidate:...',
      sdpMid: '0',
      sdpMLineIndex: 0,
    };
    const json = serializeMessage(msg);
    const parsed = JSON.parse(json);
    expect(parsed.type).toBe('ice-candidate');
    expect(parsed.sdpMLineIndex).toBe(0);
  });

  test('roundtrip preserves message', () => {
    const original: SignalingMessage = {
      type: 'error',
      code: 'TEST',
      message: 'Test message with "quotes" and \n newlines',
    };
    const json = serializeMessage(original);
    const parsed = parseMessage(json);
    expect(parsed).toEqual(original);
  });
});
