/**
 * Round-trip tests for the binding-aware protocol additions in phase 2
 * (#429). Each new field should survive serialize → deserialize without
 * loss so client and daemon agree on the same wire shape.
 */

import { describe, expect, test } from 'bun:test';
import type { UUID } from '../src/index.ts';
import {
  createAnswer,
  createHelloAck,
  createQuestion,
  createTranscriptBindingChanged,
  createUserInput,
  deserialize,
  serialize,
} from '../src/index.ts';

const RID = 'remi0000-0000-0000-0000-000000000001' as UUID;
const CID = 'claude00-0000-0000-0000-000000000002' as UUID;
const QID = 'ques0000-0000-0000-0000-000000000003' as UUID;

describe('binding fields on the wire (#429)', () => {
  test('hello_ack carries claudeSessionId + transcriptPath when binding present', () => {
    const msg = createHelloAck('1.0.0', RID, undefined, {
      claudeSessionId: CID,
      transcriptPath: '/home/u/.claude/projects/-x/abc.jsonl',
    });
    const round = deserialize(serialize(msg));
    if (round?.type !== 'hello_ack') throw new Error('wrong type');
    expect(round.claudeSessionId).toBe(CID);
    expect(round.transcriptPath).toBe('/home/u/.claude/projects/-x/abc.jsonl');
  });

  test('hello_ack with null binding (no resolved id yet)', () => {
    const msg = createHelloAck('1.0.0', RID, undefined, {
      claudeSessionId: null,
      transcriptPath: null,
    });
    const round = deserialize(serialize(msg));
    if (round?.type !== 'hello_ack') throw new Error('wrong type');
    expect(round.claudeSessionId).toBeNull();
    expect(round.transcriptPath).toBeNull();
  });

  test('hello_ack without binding arg omits the fields (back-compat)', () => {
    const msg = createHelloAck('1.0.0', RID);
    const round = deserialize(serialize(msg));
    if (round?.type !== 'hello_ack') throw new Error('wrong type');
    expect('claudeSessionId' in round).toBe(false);
    expect('transcriptPath' in round).toBe(false);
  });

  test('question carries claudeSessionId when provided', () => {
    const msg = createQuestion(
      { id: QID, text: 'continue?', options: [], freeText: false },
      RID,
      CID,
    );
    const round = deserialize(serialize(msg));
    if (round?.type !== 'question') throw new Error('wrong type');
    expect(round.claudeSessionId).toBe(CID);
    expect(round.sessionId).toBe(RID);
  });

  test('answer carries claudeSessionId echo when provided', () => {
    const msg = createAnswer(RID, QID, 'y', CID);
    const round = deserialize(serialize(msg));
    if (round?.type !== 'answer') throw new Error('wrong type');
    expect(round.claudeSessionId).toBe(CID);
    expect(round.questionId).toBe(QID);
    expect(round.answer).toBe('y');
  });

  test('user_input carries claudeSessionId when provided', () => {
    const msg = createUserInput(RID, 'ls', false, CID);
    const round = deserialize(serialize(msg));
    if (round?.type !== 'user_input') throw new Error('wrong type');
    expect(round.claudeSessionId).toBe(CID);
    expect(round.content).toBe('ls');
  });

  test('transcript_binding_changed event round-trips with all fields', () => {
    const msg = createTranscriptBindingChanged(
      RID,
      CID,
      '/home/u/.claude/projects/-x/abc.jsonl',
      'resume',
    );
    const round = deserialize(serialize(msg));
    if (round?.type !== 'transcript_binding_changed') throw new Error('wrong type');
    expect(round.sessionId).toBe(RID);
    expect(round.claudeSessionId).toBe(CID);
    expect(round.transcriptPath).toBe('/home/u/.claude/projects/-x/abc.jsonl');
    expect(round.reason).toBe('resume');
  });

  test('transcript_binding_changed defaults reason to "unknown"', () => {
    const msg = createTranscriptBindingChanged(RID, CID, '/x.jsonl');
    expect(msg.reason).toBe('unknown');
  });
});
