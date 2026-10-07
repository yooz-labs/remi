/**
 * `classifyInbound` (epic #1175, phase 1 #1181), driven with real frames from
 * the redacted spike fixtures plus the malformed shapes it must refuse.
 */
import { describe, expect, test } from 'bun:test';
import { classifyInbound } from '../../../src/harness/codex/app-server-protocol.ts';
import { fixtureFrameAt, loadFixtureFrames } from '../../helpers/codex-fixtures.ts';

describe('classifyInbound on real Codex frames', () => {
  test('a command approval is a request, with its numeric id and untouched params', () => {
    const frame = fixtureFrameAt('expA-accept.jsonl', 47).frame;
    const message = classifyInbound(frame);
    expect(message).toMatchObject({
      kind: 'request',
      id: 1,
      method: 'item/commandExecution/requestApproval',
    });
    expect((message as { params: unknown }).params).toEqual(frame['params']);
  });

  test('a status change is a notification', () => {
    expect(classifyInbound(fixtureFrameAt('expA-accept.jsonl', 26).frame)).toMatchObject({
      kind: 'notification',
      method: 'thread/status/changed',
    });
  });

  test('the initialize result and the -32600 error are responses, with no jsonrpc member needed', () => {
    const ok = classifyInbound(fixtureFrameAt('expA-accept.jsonl', 2).frame);
    expect(ok).toMatchObject({ kind: 'response', id: 1 });
    expect((ok as { result: { userAgent: string } }).result.userAgent).toBe('remi/0.160.0 (test)');
    const failed = classifyInbound(loadFixtureFrames('report-derived.jsonl')[0]?.frame);
    expect(failed).toMatchObject({ kind: 'response', id: 2, error: { code: -32600 } });
    expect(failed).not.toHaveProperty('result');
  });

  test('every inbound fixture frame classifies, and outbound answers are responses', () => {
    for (const file of ['expA-accept.jsonl', 'expA-decline.jsonl', 'expB3.jsonl', 'expC.jsonl']) {
      for (const f of loadFixtureFrames(file)) {
        expect(classifyInbound(f.frame), `${file}:${f.line}`).not.toBeNull();
      }
    }
  });
});

describe('classifyInbound shapes', () => {
  test('a string id is a RequestId too', () => {
    expect(classifyInbound({ id: 'req-1', method: 'a/b', params: {} })).toEqual({
      kind: 'request',
      id: 'req-1',
      method: 'a/b',
      params: {},
    });
    expect(classifyInbound({ id: 'req-1', result: {} })).toEqual({
      kind: 'response',
      id: 'req-1',
      result: {},
    });
  });

  test('an id of 0 and an empty-string id are valid', () => {
    expect(classifyInbound({ id: 0, result: null })).toEqual({
      kind: 'response',
      id: 0,
      result: null,
    });
    expect(classifyInbound({ id: '', method: 'm' })).toMatchObject({ kind: 'request', id: '' });
  });

  test('a null result is a response (a unit result is still an answer)', () => {
    expect(classifyInbound({ id: 4, result: null })).toEqual({
      kind: 'response',
      id: 4,
      result: null,
    });
  });

  test('an error keeps its data', () => {
    expect(
      classifyInbound({ id: 5, error: { code: -32601, message: 'nope', data: { a: 1 } } }),
    ).toEqual({
      kind: 'response',
      id: 5,
      error: { code: -32601, message: 'nope', data: { a: 1 } },
    });
  });

  test('a notification with no params has undefined params', () => {
    expect(classifyInbound({ method: 'initialized' })).toEqual({
      kind: 'notification',
      method: 'initialized',
      params: undefined,
    });
  });

  test('malformed frames are null', () => {
    const bad: Record<string, unknown> = {
      'not an object': 'text',
      null: null,
      array: [1, 2],
      'empty object': {},
      'no id, method or result': { params: {} },
      'a null id on a request': { id: null, method: 'm' },
      'a boolean id': { id: true, result: {} },
      'an object id': { id: {}, result: {} },
      'a non-finite id': { id: Number.NaN, result: {} },
      'a method that is not a string': { id: 1, method: 7 },
      'an empty method': { method: '' },
      'both result and error': { id: 1, result: {}, error: { code: 1, message: 'x' } },
      'an id with neither result nor error': { id: 1 },
      'an error with no code': { id: 1, error: { message: 'x' } },
      'an error with no message': { id: 1, error: { code: 1 } },
      'an error that is not an object': { id: 1, error: 'boom' },
    };
    for (const [name, frame] of Object.entries(bad)) {
      expect(classifyInbound(frame), name).toBeNull();
    }
  });
});
