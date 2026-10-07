/**
 * Source scans for the daemon's own conventions (`question-identity-sources.test.ts`,
 * `hello-ack-sources.test.ts`): split a call's top-level arguments out of source text whose
 * comments are already stripped. Strings, template literals and nested brackets are skipped.
 */

/** The text between the parentheses that open at `open`, and the top-level arguments in it. */
export function callArguments(source: string, open: number): { args: string[]; spread: boolean } {
  const args: string[] = [];
  let depth = 0;
  let current = '';
  let quote: string | null = null;
  for (let i = open; i < source.length; i++) {
    const c = source[i] as string;
    if (quote !== null) {
      current += c;
      if (c === '\\') {
        current += source[++i] ?? '';
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      current += c;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      depth++;
      if (depth === 1) continue;
    }
    if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) {
        if (current.trim() !== '') args.push(current.trim());
        break;
      }
    }
    if (c === ',' && depth === 1) {
      if (current.trim() !== '') args.push(current.trim());
      current = '';
      continue;
    }
    current += c;
  }
  return { args, spread: args.some((a) => a.startsWith('...')) };
}
