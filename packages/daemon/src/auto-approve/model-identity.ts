/**
 * Naming and identity for engine models (#843).
 *
 * A model has two names. `yooz-instruct-4b` is the engine's canonical wire id;
 * `YoozLabs/Qwen3.5-4B-qat-lean-4bit-mlx` is the repo that actually exists on
 * HuggingFace, and is the name a user recognizes, types, and can go look up.
 * The engine accepts either wherever a model id is taken.
 *
 * Two rules follow, and this module exists so they are stated once rather than
 * re-derived at each call site:
 *
 *   - **Match on either name.** remi's own config holds one of them (the
 *     shipped default is the repo id) and a row carries both. Comparing `id`
 *     to `id` alone reports a present, working model as missing.
 *   - **Show the registered name.** The nickname is an internal wire value; a
 *     user asked to manage models by nickname cannot verify what they are
 *     running (owner call, #843).
 *
 * ## Why absence is handled rather than assumed away
 *
 * `huggingFaceID` arrived in yooz-engine 0.7.8. remi attaches to whatever
 * engine is already on the port — a super-yooz host, a hand-built one, an
 * older cached helper — so an engine without the field is a live case, not a
 * migration window. There, remi can still see that an id has a slash and is
 * therefore repo-shaped, but it cannot map one name to the other. Every
 * function here degrades to "cannot tell" instead of guessing, because the
 * guess would be a confident wrong answer: reporting a working model as absent
 * is precisely the bug this replaces.
 */

/** The two names a row can be known by. Structural, so both `EngineModel` and
 *  `ManagedModel` satisfy it without either importing the other. */
export interface ModelNames {
  readonly id: string;
  readonly huggingFaceID?: string | undefined;
}

/**
 * Does this id look like a HuggingFace repo id rather than a canonical wire id?
 *
 * The `owner/name` slash is the only signal available without the engine's
 * mapping. Conservative on purpose: it is used to decide when a comparison
 * CANNOT be trusted, so a false positive costs an honest "cannot tell" while a
 * false negative costs a confident wrong answer.
 */
export function looksLikeRepoId(id: string): boolean {
  return id.includes('/');
}

/** Does `row` name the model `configured` refers to, under either name? */
export function matchesModel(row: ModelNames, configured: string): boolean {
  // An empty or absent `configured` matches NOTHING. Without this, comparing
  // against an absent value makes `row.huggingFaceID === configured` true for
  // every row that has no alias — `undefined === undefined` — so a listing
  // whose `current` field the engine omitted would mark every row as the
  // active one. Typed `string`, but it arrives off the wire.
  if (!configured) return false;
  return row.id === configured || row.huggingFaceID === configured;
}

/** The row for `configured`, or undefined when none names it. */
export function findModel<T extends ModelNames>(
  rows: readonly T[],
  configured: string,
): T | undefined {
  return rows.find((row) => matchesModel(row, configured));
}

/**
 * The name to SHOW for a row: the registered repo id when the engine reports
 * one, else whatever id it has.
 *
 * Never invents a name. A swept hub directory's id (`models--ns--repo`) is
 * already the repo in flattened form, and un-flattening it means guessing
 * where the namespace ends — so it is shown as-is.
 */
export function displayId(row: ModelNames): string {
  return row.huggingFaceID ?? row.id;
}

/**
 * How a configured id relates to a row set, as a value — so callers report the
 * three cases differently instead of collapsing "absent" and "cannot tell".
 *
 *   `found`      a row names it; `row` is that row.
 *   `absent`     the rows are alias-aware and none names it. Genuinely missing.
 *   `unknowable` the rows predate the alias field and the configured id is
 *                repo-shaped, so it may well be present under its canonical
 *                id. Nothing here can decide it.
 */
export type ModelLookup<T> =
  | { readonly kind: 'found'; readonly row: T }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unknowable' };

export function lookupModel<T extends ModelNames>(
  rows: readonly T[],
  configured: string,
): ModelLookup<T> {
  const row = findModel(rows, configured);
  if (row !== undefined) return { kind: 'found', row };
  // "None of these rows knows its repo id" is the condition that makes a
  // negative result meaningless, and it is a property of the ROW SET, not of
  // any single row: one alias-aware row proves the engine reports the field,
  // and a nil alias on some other row is then real information (a swept
  // directory) rather than a gap.
  const aliasAware = rows.some((r) => r.huggingFaceID !== undefined);
  if (!aliasAware && looksLikeRepoId(configured)) return { kind: 'unknowable' };
  return { kind: 'absent' };
}
