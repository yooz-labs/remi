/**
 * TypeScript-side mirror of the macOS fixture-conformance tests (#901,
 * epic #883).
 *
 * `HubClient` (packages/macos/Remi/HubClient.swift) decodes exactly 5 frame
 * types, all from these SAME checked-in golden fixtures
 * (packages/shared/tests/fixtures/protocol/, #895): `hello_ack`,
 * `hub_status`, `pong`, `auth_challenge`, `auth_result` — the cases of the
 * `handleFrame` switch (HubClient.swift:359-406). An undecodable frame is
 * dropped SILENTLY there (`guard ... else { return }`,
 * HubClient.swift:355-357): today a TS-side wire change that drops a field
 * Swift's `Decodable` structs require produces no failure anywhere the
 * macOS app can see, it just stops seeing that frame.
 *
 * The macOS CI workflow (.github/workflows/macos-app.yml) is path-filtered
 * to `packages/macos/**` — a change to `packages/shared/src/protocol.ts`
 * alone does not trigger it, so the Swift decode tests
 * (packages/macos/RemiTests/HubFixtureConformanceTests.swift) never even
 * run against that change. THIS test is what actually catches the break,
 * on the CI path that runs for every `protocol.ts`/fixture change.
 *
 * The required-field lists below were read directly off
 * packages/macos/Remi/HubProtocol.swift (line numbers cited per field) when
 * this test was written. They are a hand-verified snapshot of the Swift
 * contract, not a derivation from it — there is no cross-language schema to
 * derive them from, so keep them in sync by hand if HubProtocol.swift's
 * required fields change.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'protocol');

function loadFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.json`), 'utf-8')) as Record<
    string,
    unknown
  >;
}

/**
 * A field a Swift `Decodable` struct requires: JSON key + the JS `typeof`
 * it must decode as. Swift fails the WHOLE struct decode if a non-optional
 * key is absent or type-mismatched; an optional (`String?` etc.) field is
 * NOT listed here, since Swift decodes an absent/null optional to `nil`
 * without error.
 */
interface RequiredField {
  key: string;
  type: 'string' | 'number' | 'boolean';
}

/** Missing/mismatched fields, or `[]` if every required field checks out. */
function requiredFieldProblems(
  fixture: Record<string, unknown>,
  fields: readonly RequiredField[],
): string[] {
  const problems: string[] = [];
  for (const field of fields) {
    if (!(field.key in fixture)) {
      problems.push(`missing "${field.key}"`);
      continue;
    }
    const actual = typeof fixture[field.key];
    if (actual !== field.type) {
      problems.push(`"${field.key}" is ${actual}, not ${field.type}`);
    }
  }
  return problems;
}

describe('macOS HubClient fixture conformance (#901)', () => {
  // HubClient.swift:360-370, HubProtocol.swift:136-142 (HelloAckFrame).
  // `sessionId`/`daemonVersion` are `String?` in Swift — not required.
  test('hello_ack keeps the fields HelloAckFrame requires', () => {
    const problems = requiredFieldProblems(loadFixture('hello_ack'), [
      { key: 'type', type: 'string' },
      { key: 'serverVersion', type: 'string' },
    ]);
    expect(problems).toEqual([]);
  });

  // HubClient.swift:383-397, HubProtocol.swift:155-172 (HubStatusFrame).
  // `pendingQuestions`/`questions`/`autostart` are optional in Swift.
  test('hub_status keeps the fields HubStatusFrame requires', () => {
    const problems = requiredFieldProblems(loadFixture('hub_status'), [
      { key: 'type', type: 'string' },
      { key: 'localClients', type: 'number' },
      { key: 'remoteClients', type: 'number' },
      { key: 'sessions', type: 'number' },
      { key: 'hubVersion', type: 'string' },
    ]);
    expect(problems).toEqual([]);
  });

  // The checked-in hub_status fixture carries a non-empty `questions`
  // array. `questions` itself is optional on HubStatusFrame, but Swift
  // decodes array ELEMENTS strictly: once the key is present, every
  // HubPendingQuestionFrame field (HubProtocol.swift:146-152, all
  // non-optional) must decode too, or the WHOLE HubStatusFrame decode
  // throws — dropping the frame, not just the questions list.
  test('hub_status.questions[0] keeps the fields HubPendingQuestionFrame requires', () => {
    const fixture = loadFixture('hub_status');
    const questions = fixture['questions'];
    expect(Array.isArray(questions)).toBe(true);
    const list = questions as Record<string, unknown>[];
    expect(list.length).toBeGreaterThan(0);
    const first = list[0];
    if (!first) throw new Error('hub_status.questions[0] is missing');
    const problems = requiredFieldProblems(first, [
      { key: 'id', type: 'string' },
      { key: 'sessionId', type: 'string' },
      { key: 'sessionName', type: 'string' },
      { key: 'label', type: 'string' },
      { key: 'createdAt', type: 'string' },
    ]);
    expect(problems).toEqual([]);
  });

  // HubClient.swift:398-399: the "pong" case reads nothing but the
  // envelope `type` (IncomingFrameType, HubProtocol.swift:73-75) — there is
  // no dedicated payload struct, so `type` is the entire contract.
  test('pong keeps the field the envelope decode requires', () => {
    const problems = requiredFieldProblems(loadFixture('pong'), [{ key: 'type', type: 'string' }]);
    expect(problems).toEqual([]);
  });

  // HubClient.swift:400-401 -> handleAuthChallenge (417-436),
  // HubProtocol.swift:88-96 (AuthChallengeFrame).
  test('auth_challenge keeps the fields AuthChallengeFrame requires', () => {
    const problems = requiredFieldProblems(loadFixture('auth_challenge'), [
      { key: 'type', type: 'string' },
      { key: 'challenge', type: 'string' },
      { key: 'serverFingerprint', type: 'string' },
      { key: 'serverPublicKey', type: 'string' },
    ]);
    expect(problems).toEqual([]);
  });

  // HubClient.swift:402-403 -> handleAuthResult (446-466),
  // HubProtocol.swift:127-132 (AuthResultFrame). `error`/`serverSignature`
  // are optional in Swift.
  test('auth_result keeps the fields AuthResultFrame requires', () => {
    const problems = requiredFieldProblems(loadFixture('auth_result'), [
      { key: 'type', type: 'string' },
      { key: 'success', type: 'boolean' },
    ]);
    expect(problems).toEqual([]);
  });
});
