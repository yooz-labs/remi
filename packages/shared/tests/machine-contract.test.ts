import { expect, test } from 'bun:test';
import { createHelloAck, createSessionListResponse } from '../src/protocol.ts';
import { FIXED_MACHINE, FIXTURE_BUILDERS } from './fixtures/protocol/builders.ts';

test('a single machine snapshot supplies matching hello version, harnesses and connection capabilities', () => {
  const ack = createHelloAck('1.0.0', null, {
    machine: FIXED_MACHINE,
    daemonVersion: 'older-snapshot',
    harnesses: [],
    capabilities: [],
  });
  expect(ack.machine).toEqual(FIXED_MACHINE);
  expect(ack.daemonVersion).toBe(ack.machine?.remiVersion);
  expect(ack.harnesses).toEqual(ack.machine?.harnesses);
  expect(ack.capabilities).toEqual(ack.machine?.capabilities);
});

test('every listed session is stamped with the hosting machine without mutating the original', () => {
  const original = FIXTURE_BUILDERS.session_list_response();
  const response = createSessionListResponse(
    original.sessions,
    original.requestId,
    undefined,
    FIXED_MACHINE,
  );
  expect(response.sessions.length).toBeGreaterThan(0);
  for (const entry of response.sessions) expect(entry.machineId).toBe(FIXED_MACHINE.id);
  for (const entry of original.sessions) expect(entry.machineId).toBeUndefined();
  expect(response.machine).toEqual(FIXED_MACHINE);
  expect(createHelloAck('1.0.0', null).machine).toBeUndefined();
  expect(original.machine).toBeUndefined();
});
