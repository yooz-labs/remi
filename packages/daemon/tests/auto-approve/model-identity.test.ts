import { describe, expect, test } from 'bun:test';
import {
  displayId,
  findModel,
  looksLikeRepoId,
  lookupModel,
  matchesModel,
} from '../../src/auto-approve/model-identity.ts';

const HF = 'YoozLabs/Qwen3.5-4B-qat-lean-4bit-mlx';

/** Rows as an engine >= 0.7.8 reports them (yooz-engine#308). */
const INSTRUCT = { id: 'yooz-instruct-4b', huggingFaceID: HF };
const ALIASED = [
  INSTRUCT,
  { id: 'yooz-light-v3', huggingFaceID: 'YoozLabs/Yooz-Light-v3-Qwen3.5-0.8B' },
];

/** The same models on an engine that does not report the alias. */
const LEGACY = [{ id: 'yooz-instruct-4b' }, { id: 'yooz-light-v3' }];

describe('matchesModel / findModel', () => {
  test('matches on the canonical id', () => {
    expect(matchesModel(INSTRUCT, 'yooz-instruct-4b')).toBe(true);
  });

  test('matches on the registered repo id', () => {
    // The case that matters: this is remi's shipped default, so an id-only
    // comparison reports the default configuration as an unknown model.
    expect(matchesModel(INSTRUCT, HF)).toBe(true);
    expect(findModel(ALIASED, HF)?.id).toBe('yooz-instruct-4b');
  });

  test('does not match a different model under either name', () => {
    expect(matchesModel(INSTRUCT, 'yooz-light-v3')).toBe(false);
    expect(matchesModel(INSTRUCT, 'YoozLabs/Something-Else')).toBe(false);
    expect(findModel(ALIASED, 'nope')).toBeUndefined();
  });

  test('an absent alias never matches an absent configured value', () => {
    // Guards the undefined === undefined trap: two rows with no alias must not
    // collapse into "the same model" when compared through it.
    expect(matchesModel({ id: 'a' }, undefined as unknown as string)).toBe(false);
  });
});

describe('displayId', () => {
  test('prefers the registered name a user can actually look up', () => {
    expect(displayId(INSTRUCT)).toBe(HF);
  });

  test('falls back to the id when the engine reports no alias', () => {
    expect(displayId({ id: 'yooz-instruct-4b' })).toBe('yooz-instruct-4b');
  });

  test('never invents a repo id for a swept hub directory', () => {
    // `models--a--b--c` could be `a/b--c` or `a--b/c`; a wrong repo id is
    // worse than the flattened one the user can still read.
    const swept = { id: 'models--mlx-community--parakeet-tdt-0.6b-v3' };
    expect(displayId(swept)).toBe('models--mlx-community--parakeet-tdt-0.6b-v3');
  });
});

describe('looksLikeRepoId', () => {
  test('the slash is the signal', () => {
    expect(looksLikeRepoId(HF)).toBe(true);
    expect(looksLikeRepoId('yooz-instruct-4b')).toBe(false);
  });
});

describe('lookupModel — absent vs unknowable', () => {
  test('found: the row is returned', () => {
    const r = lookupModel(ALIASED, HF);
    expect(r.kind).toBe('found');
    expect(r.kind === 'found' && r.row.id).toBe('yooz-instruct-4b');
  });

  test('absent: alias-aware rows that genuinely do not include it', () => {
    // A negative is real information here, so callers may act on it (offer a
    // pull, warn that nothing is downloaded).
    expect(lookupModel(ALIASED, 'YoozLabs/Not-Installed').kind).toBe('absent');
  });

  test('unknowable: legacy rows and a repo-shaped id cannot be decided', () => {
    // The model is very likely present under its canonical id. Reporting
    // "absent" here is the false alarm that shipped in 0.7.0.
    expect(lookupModel(LEGACY, HF).kind).toBe('unknowable');
  });

  test('absent: legacy rows but a CANONICAL id is still decidable', () => {
    // No alias needed to answer this one — the ids are directly comparable.
    expect(lookupModel(LEGACY, 'yooz-nonexistent-9b').kind).toBe('absent');
  });

  test('one alias-aware row makes the whole set decidable', () => {
    // Alias-awareness is a property of the ENGINE, not of a row: a single row
    // carrying the field proves the engine reports it, so a nil alias
    // elsewhere (a swept directory) is information rather than a gap.
    const mixed = [{ id: 'yooz-instruct-4b', huggingFaceID: HF }, { id: 'models--x--y' }];
    expect(lookupModel(mixed, 'YoozLabs/Other').kind).toBe('absent');
  });

  test('an empty listing is never decidable for a repo-shaped id', () => {
    expect(lookupModel([], HF).kind).toBe('unknowable');
  });
});
