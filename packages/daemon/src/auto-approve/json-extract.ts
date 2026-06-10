/**
 * Tolerant JSON extraction for local-LLM verdicts.
 *
 * Small instruct models (notably qwen3.6:35b-mlx, but most reasoning-tuned
 * models intermittently) wrap their JSON answer in a markdown code fence
 * (```json … ```), emit a leading language tag, or prepend a short preamble
 * before the object even when asked for raw JSON. A strict `JSON.parse` of the
 * whole response then throws, and the auto-approve service escalates EVERY such
 * verdict to the user — which made qwen3.6:35b-mlx (the second-opinion model)
 * escalate 13/38 safe-read scenarios in the sweep purely on formatting.
 *
 * This helper performs a DETERMINISTIC, SAFE recovery: it strips a recognised
 * code-fence wrapper and, failing that, extracts the first balanced top-level
 * `{ … }` object, then parses THAT strictly. It never guesses a decision from
 * free text — if no parseable object is present the caller still escalates. The
 * historical "no guessing" caution (a substring `approve` in free text must not
 * approve) is preserved: we only ever return a parsed JSON object, never a
 * keyword match.
 */

/**
 * Extract and parse the first JSON object from a raw LLM response.
 *
 * Returns the parsed object, or null when no balanced `{…}` object parses.
 * Order of attempts:
 *   1. Parse the whole string (the fast, well-behaved path).
 *   2. Strip a leading/trailing markdown code fence (``` or ```json) and parse.
 *   3. Scan for the first balanced top-level `{…}` (brace-aware, string- and
 *      escape-aware so braces inside string values do not miscount) and parse.
 *
 * Only object literals are accepted; arrays, numbers, and `null` return null so
 * the caller's "must be a JSON object with a decision field" contract is
 * unchanged.
 */
export function extractJsonObject(raw: string): Record<string, unknown> | null {
  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(s);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };

  const whole = tryParse(raw.trim());
  if (whole !== null) return whole;

  const defenced = stripCodeFence(raw);
  if (defenced !== null) {
    const parsed = tryParse(defenced);
    if (parsed !== null) return parsed;
    // A fence around a preamble: scan the de-fenced text for a balanced object
    // (so the fence markers don't count). Deliberately NOT applied when the
    // de-fenced content is array-shaped — a `[ … ]` must escalate, never have an
    // inner object lifted out of it (same conservatism as the preamble branch).
    if (!isArrayShaped(defenced)) {
      const inner = firstBalancedObject(defenced);
      if (inner !== null) {
        const innerParsed = tryParse(inner);
        if (innerParsed !== null) return innerParsed;
      }
    }
    return null;
  }

  // Preamble case ("Here it is: {…}"). Deliberately NOT applied when the
  // response is array-shaped: a top-level `[ … ]` must escalate rather than
  // have an object silently lifted out of it (conservative for an approve path).
  // isArrayShaped also catches a preamble BEFORE an array ("Here: [ {…} ]") so
  // an object nested inside an array is never lifted out as the verdict.
  if (!isArrayShaped(raw)) {
    const candidate = firstBalancedObject(raw);
    if (candidate !== null) {
      const parsed = tryParse(candidate);
      if (parsed !== null) return parsed;
    }
  }

  return null;
}

/**
 * True when the response is array-shaped at the top level: the first structural
 * bracket is a `[` (or there is a `[` but no `{` at all). Such a response must
 * escalate — an object nested inside an array must never be lifted out and
 * treated as the verdict (conservative for an approve path). Erring toward
 * "array-shaped" (e.g. prose that happens to contain a `[` before the object)
 * over-escalates to the user, which is the safe direction.
 */
function isArrayShaped(raw: string): boolean {
  const obj = raw.indexOf('{');
  const arr = raw.indexOf('[');
  if (arr === -1) return false; // no array bracket → object/preamble path is safe
  if (obj === -1) return true; // an array and no object → array-shaped
  return arr < obj; // whichever bracket opens first decides the shape
}

/**
 * Strip one surrounding markdown code fence, returning the inner text, or null
 * when the input is not fenced. Handles an optional language tag (```json) and
 * leading/trailing whitespace around the fences.
 */
function stripCodeFence(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('```')) return null;
  // Drop the opening fence line (``` or ```json plus the rest of that line).
  const firstNewline = trimmed.indexOf('\n');
  if (firstNewline === -1) return null;
  const afterOpen = trimmed.slice(firstNewline + 1);
  const closeIdx = afterOpen.lastIndexOf('```');
  const inner = closeIdx === -1 ? afterOpen : afterOpen.slice(0, closeIdx);
  return inner.trim();
}

/**
 * Return the first balanced top-level `{…}` substring, or null. String-literal
 * aware: braces and the closing scan ignore `{`/`}` that appear inside double-
 * quoted strings, and honour backslash escapes, so a brace inside a reasoning
 * value does not prematurely close the object.
 */
function firstBalancedObject(raw: string): string | null {
  const start = raw.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}
