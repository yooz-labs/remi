/**
 * Contract-drift regression gate (#886 part 2).
 *
 * Validates every event in the checked-in fixture corpus
 * (`fixtures/hook-corpus.jsonl` -- real, redacted Claude Code hook traffic,
 * see `fixtures/build-hook-corpus.ts`) against the field-presence contract
 * `fixtures/contract-spec.ts` mirrors from `hook-types.ts`. This is the
 * regression gate the #886 epic exists to build: when a future Claude Code
 * upgrade changes a payload shape (adds a field, drops one, flips
 * optionality), a fresh capture that no longer matches this corpus's shapes
 * would fail here BEFORE it fails silently at runtime.
 *
 * WHAT A FAILURE HERE MEANS: this test is supposed to be strict. An unknown
 * field appearing in a capture, or a declared-required field going missing,
 * is a FINDING -- the fix is to go update `hook-types.ts` (and this file's
 * mirror of it) with real evidence, the same way #929/#905 were handled, not
 * to loosen an assertion here to make it pass again. Loosening this file to
 * silence a real finding defeats the only reason it exists.
 *
 * SCOPE, worth repeating from `fixtures/contract-spec.ts`: this corpus can
 * only ever contain events remi has registered (`REMI_REGISTERED_HOOK_EVENTS`
 * -- Claude Code has no URL to POST an unregistered event to, #203 design).
 * `contract-drift.test.ts` passing green is NOT a claim that every one of
 * the 31 names in `HOOK_EVENT_NAMES` is covered -- most never fire, and this
 * corpus grows with the epic (each future Q that registers a new event
 * extends fixture coverage for it) rather than preceding it. Silence about
 * an unregistered event, or a registered-but-uncaptured one (see
 * `EVENTS_WITHOUT_FIXTURES`), is not evidence about that event's shape.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REMI_REGISTERED_HOOK_EVENTS } from '../../src/hooks/hook-types.ts';
import {
  COMMON_OPTIONAL,
  COMMON_REQUIRED,
  EVENTS_WITHOUT_FIXTURES,
  EVENT_SPECS,
  REMI_OWN_FIELDS,
} from './fixtures/contract-spec.ts';

const CORPUS_PATH = join(import.meta.dir, 'fixtures', 'hook-corpus.jsonl');

function loadCorpus(): Record<string, unknown>[] {
  const raw = readFileSync(CORPUS_PATH, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function groupByEvent(records: Record<string, unknown>[]): Map<string, Record<string, unknown>[]> {
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const record of records) {
    const event = String(record['hook_event_name'] ?? '<missing>');
    const group = groups.get(event);
    if (group) {
      group.push(record);
    } else {
      groups.set(event, [record]);
    }
  }
  return groups;
}

const corpus = loadCorpus();
const byEvent = groupByEvent(corpus);

describe('contract-drift corpus sanity', () => {
  it('is non-empty', () => {
    expect(corpus.length).toBeGreaterThan(0);
  });

  it('contract-spec.ts EVENT_SPECS matches REMI_REGISTERED_HOOK_EVENTS exactly', () => {
    // Keeps the spec honest: a 15th registered event that never gets a spec
    // entry would otherwise pass silently (nothing iterates it).
    const specNames = Object.keys(EVENT_SPECS).sort();
    const registeredNames = [...REMI_REGISTERED_HOOK_EVENTS].sort();
    expect(specNames).toEqual(registeredNames);
  });

  it('every corpus event name is a registered hook event', () => {
    // #203 design: Claude Code can only POST an event remi registered a URL
    // for. A name outside REMI_REGISTERED_HOOK_EVENTS showing up here would
    // mean either a corpus-build bug or a Claude Code change to that design.
    for (const event of byEvent.keys()) {
      expect(REMI_REGISTERED_HOOK_EVENTS as readonly string[]).toContain(event);
    }
  });

  it('EVENTS_WITHOUT_FIXTURES stays accurate', () => {
    for (const event of Object.keys(EVENTS_WITHOUT_FIXTURES)) {
      const group = byEvent.get(event) ?? [];
      // A failure here is GOOD news: fixtures exist now for an event this
      // file claims has none. Update EVENTS_WITHOUT_FIXTURES (and add the
      // event's real assertions below) rather than re-asserting emptiness.
      expect(group.length).toBe(0);
    }
  });
});

for (const [event, spec] of Object.entries(EVENT_SPECS)) {
  const expectedEmpty = event in EVENTS_WITHOUT_FIXTURES;

  describe(`contract-drift: ${event}`, () => {
    const records = byEvent.get(event) ?? [];

    if (expectedEmpty) {
      it('has no fixtures yet (see EVENTS_WITHOUT_FIXTURES)', () => {
        expect(records.length).toBe(0);
      });
      return;
    }

    it('has at least one fixture', () => {
      expect(records.length).toBeGreaterThan(0);
    });

    const knownAbsentRequired = new Set(spec.knownAbsentRequired ?? []);
    const extraKnownFields = new Set(spec.extraKnownFields ?? []);
    const knownFields = new Set<string>([
      ...COMMON_REQUIRED,
      ...COMMON_OPTIONAL,
      ...REMI_OWN_FIELDS,
      ...spec.required,
      ...spec.optional,
      ...extraKnownFields,
    ]);
    const requiredFields = [...COMMON_REQUIRED, ...spec.required].filter(
      (field) => !knownAbsentRequired.has(field),
    );

    it('every captured field is known to hook-types.ts (or an explicitly cited exception)', () => {
      for (const record of records) {
        for (const key of Object.keys(record)) {
          expect(knownFields.has(key)).toBe(true);
        }
      }
    });

    it('every field hook-types.ts declares non-optional is present in every capture', () => {
      for (const record of records) {
        for (const field of requiredFields) {
          expect(Object.hasOwn(record, field)).toBe(true);
        }
      }
    });

    if (knownAbsentRequired.size > 0) {
      it('cited known-absent-required fields are, in fact, always absent', () => {
        for (const record of records) {
          for (const field of knownAbsentRequired) {
            // A failure here means Claude Code started sending a field it
            // previously never sent for this event -- informative, not a
            // regression: go narrow (or drop) the knownAbsentRequired entry.
            expect(Object.hasOwn(record, field)).toBe(false);
          }
        }
      });
    }

    if (extraKnownFields.size > 0) {
      it('cited extra-known fields are, in fact, present on at least one capture', () => {
        // Guards the exception itself from going stale in the other
        // direction: a field cited as "Claude Code sends this" that no
        // fixture actually carries anymore is a stale citation, not a
        // finding worth keeping quiet about.
        for (const field of extraKnownFields) {
          const seen = records.some((record) => Object.hasOwn(record, field));
          expect(seen).toBe(true);
        }
      });
    }
  });
}
