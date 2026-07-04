import { describe, expect, test } from 'bun:test';
import { mergeResyncSurvivors, selectResyncSurvivors } from '../../src/lib/message-resync';
import type { UIMessage } from '../../src/types';

function makeUIMessage(overrides: Partial<UIMessage> = {}): UIMessage {
  return {
    id: 'msg-1' as UIMessage['id'],
    sessionId: 'session-1' as UIMessage['sessionId'],
    sender: 'user',
    content: 'hello',
    timestamp: '2024-01-01T00:00:00Z',
    state: 'delivered',
    isEditing: false,
    ...overrides,
  };
}

describe('selectResyncSurvivors', () => {
  test('empty transcript: no messages for the session returns empty', () => {
    expect(selectResyncSurvivors([], 'session-1')).toEqual([]);
  });

  test('a delivered/read message is not a survivor (already confirmed)', () => {
    const messages = [
      makeUIMessage({ id: 'm1' as UIMessage['id'], state: 'delivered' }),
      makeUIMessage({ id: 'm2' as UIMessage['id'], state: 'read' }),
    ];
    expect(selectResyncSurvivors(messages, 'session-1')).toEqual([]);
  });

  test('a failed-only send survives, unrelated agent/system history does not', () => {
    const failed = makeUIMessage({ id: 'failed-1' as UIMessage['id'], state: 'failed' });
    const messages = [
      makeUIMessage({ id: 'history' as UIMessage['id'], sender: 'agent', state: 'delivered' }),
      failed,
    ];
    expect(selectResyncSurvivors(messages, 'session-1')).toEqual([failed]);
  });

  test('a failed send with its attached system note keeps both, in order', () => {
    const failed = makeUIMessage({ id: 'failed-1' as UIMessage['id'], state: 'failed' });
    const note = makeUIMessage({
      id: 'note-1' as UIMessage['id'],
      sender: 'system',
      state: 'delivered',
      content: 'Failed to send message: connection unavailable',
      relatedMessageId: 'failed-1' as UIMessage['id'],
    });
    const messages = [failed, note];
    expect(selectResyncSurvivors(messages, 'session-1')).toEqual([failed, note]);
  });

  test('in-flight sending and unacked sent messages both survive', () => {
    const sending = makeUIMessage({ id: 'sending-1' as UIMessage['id'], state: 'sending' });
    const sent = makeUIMessage({ id: 'sent-1' as UIMessage['id'], state: 'sent' });
    const messages = [sending, sent];
    expect(selectResyncSurvivors(messages, 'session-1')).toEqual([sending, sent]);
  });

  test('mixed landed (delivered) + failed: only the failed one survives', () => {
    const delivered = makeUIMessage({ id: 'delivered-1' as UIMessage['id'], state: 'delivered' });
    const failed = makeUIMessage({ id: 'failed-1' as UIMessage['id'], state: 'failed' });
    const messages = [delivered, failed];
    expect(selectResyncSurvivors(messages, 'session-1')).toEqual([failed]);
  });

  test('a system note whose related send is NOT a survivor is not pulled in', () => {
    const note = makeUIMessage({
      id: 'note-1' as UIMessage['id'],
      sender: 'system',
      state: 'delivered',
      content: 'unrelated note',
      relatedMessageId: 'some-other-delivered-id' as UIMessage['id'],
    });
    const messages = [note];
    expect(selectResyncSurvivors(messages, 'session-1')).toEqual([]);
  });

  test('only considers messages for the requested sessionId', () => {
    const failedHere = makeUIMessage({
      id: 'failed-here' as UIMessage['id'],
      sessionId: 'session-1' as UIMessage['sessionId'],
      state: 'failed',
    });
    const failedElsewhere = makeUIMessage({
      id: 'failed-elsewhere' as UIMessage['id'],
      sessionId: 'session-2' as UIMessage['sessionId'],
      state: 'failed',
    });
    const messages = [failedHere, failedElsewhere];
    expect(selectResyncSurvivors(messages, 'session-1')).toEqual([failedHere]);
  });

  test('an agent message is never a survivor even if in a sending-like state', () => {
    // Sanity check: only 'user'-sender messages are eligible; agent/system
    // content is always authoritative from the transcript.
    const agentMsg = makeUIMessage({
      id: 'agent-1' as UIMessage['id'],
      sender: 'agent',
      state: 'sent' as UIMessage['state'],
    });
    expect(selectResyncSurvivors([agentMsg], 'session-1')).toEqual([]);
  });
});

describe('mergeResyncSurvivors', () => {
  test('no survivors: reloaded is returned unchanged', () => {
    const reloaded = [makeUIMessage({ id: 'r1' as UIMessage['id'] })];
    expect(mergeResyncSurvivors(reloaded, [])).toEqual(reloaded);
  });

  test('failed-only survivor is appended after the reloaded transcript', () => {
    const reloaded = [
      makeUIMessage({ id: 'r1' as UIMessage['id'], sender: 'agent', content: 'history' }),
    ];
    const failed = makeUIMessage({ id: 'failed-1' as UIMessage['id'], content: 'never sent' });
    const merged = mergeResyncSurvivors(reloaded, [failed]);
    expect(merged).toEqual([...reloaded, failed]);
  });

  test('empty reloaded transcript still appends survivors', () => {
    const failed = makeUIMessage({ id: 'failed-1' as UIMessage['id'] });
    expect(mergeResyncSurvivors([], [failed])).toEqual([failed]);
  });

  test('a survivor whose content landed in the reload is deduped, not duplicated', () => {
    const landed = makeUIMessage({
      id: 'sent-1' as UIMessage['id'],
      state: 'sent',
      content: 'it actually made it',
    });
    // The transcript reload has an entry with the same sender+content but a
    // server-generated id -- the ack was lost, not the send.
    const reloadedEquivalent = makeUIMessage({
      id: 'transcript-entry-9' as UIMessage['id'],
      sender: 'user',
      content: 'it actually made it',
      state: 'read',
      entryUuid: 'entry-9',
    });
    const merged = mergeResyncSurvivors([reloadedEquivalent], [landed]);
    expect(merged).toEqual([reloadedEquivalent]);
  });

  test('mixed landed + failed: landed is deduped, failed survives', () => {
    const landed = makeUIMessage({
      id: 'sent-1' as UIMessage['id'],
      state: 'sent',
      content: 'landed after all',
    });
    const failed = makeUIMessage({
      id: 'failed-1' as UIMessage['id'],
      state: 'failed',
      content: 'never made it',
    });
    const reloadedEquivalent = makeUIMessage({
      id: 'transcript-entry-1' as UIMessage['id'],
      content: 'landed after all',
      state: 'read',
      entryUuid: 'entry-1',
    });
    const merged = mergeResyncSurvivors([reloadedEquivalent], [landed, failed]);
    expect(merged).toEqual([reloadedEquivalent, failed]);
  });

  test('a failed send + its note both dropped when the send turns out to have landed', () => {
    const landed = makeUIMessage({
      id: 'sent-1' as UIMessage['id'],
      state: 'sent',
      content: 'landed after all',
    });
    const note = makeUIMessage({
      id: 'note-1' as UIMessage['id'],
      sender: 'system',
      content: 'Failed to send message: connection unavailable',
      relatedMessageId: 'sent-1' as UIMessage['id'],
    });
    const reloadedEquivalent = makeUIMessage({
      id: 'transcript-entry-1' as UIMessage['id'],
      content: 'landed after all',
      state: 'read',
      entryUuid: 'entry-1',
    });
    const merged = mergeResyncSurvivors([reloadedEquivalent], [landed, note]);
    expect(merged).toEqual([reloadedEquivalent]);
  });

  test('a failed send + its note both survive together when the send never landed', () => {
    const failed = makeUIMessage({ id: 'failed-1' as UIMessage['id'], state: 'failed' });
    const note = makeUIMessage({
      id: 'note-1' as UIMessage['id'],
      sender: 'system',
      content: 'Failed to send message: connection unavailable',
      relatedMessageId: 'failed-1' as UIMessage['id'],
    });
    const reloaded = [makeUIMessage({ id: 'r1' as UIMessage['id'], sender: 'agent' })];
    const merged = mergeResyncSurvivors(reloaded, [failed, note]);
    expect(merged).toEqual([...reloaded, failed, note]);
  });

  test('retry-after-merge lookup: the survivor keeps its original id post-merge', () => {
    const failed = makeUIMessage({ id: 'failed-1' as UIMessage['id'], state: 'failed' });
    const merged = mergeResyncSurvivors([], [failed]);
    const lookedUp = merged.find((m) => m.id === 'failed-1');
    expect(lookedUp).toEqual(failed);
  });

  test('preserves relative order of multiple survivors', () => {
    const first = makeUIMessage({ id: 'a' as UIMessage['id'], content: 'first', state: 'failed' });
    const second = makeUIMessage({
      id: 'b' as UIMessage['id'],
      content: 'second',
      state: 'sending',
    });
    const merged = mergeResyncSurvivors([], [first, second]);
    expect(merged).toEqual([first, second]);
  });
});
