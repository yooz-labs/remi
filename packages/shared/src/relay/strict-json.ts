/** Internal bounded JSON scanner shared by signed relay payloads. */
import { utf8 } from './bytes.ts';
import { RelayError } from './errors.ts';
const malformed = (): never => {
  throw new RelayError('MALFORMED');
};

/** Scan decoded member names BEFORE JSON.parse can discard duplicates. Raw bytes stay unchanged. */
export function parseStrictJson(value: string, max: number): unknown {
  if (utf8(value).length > max) throw new RelayError('OVERSIZE');
  let at = 0;
  let nodes = 0;
  const whitespace = () => {
    while (/[\x20\t\r\n]/.test(value[at] ?? '\0')) at++;
  };
  const string = (): string => {
    const start = at++;
    while (at < value.length) {
      const c = value[at++];
      if (c === '\\') {
        at++;
        continue;
      }
      if (c === '"') {
        try {
          return JSON.parse(value.slice(start, at)) as string;
        } catch {
          return malformed();
        }
      }
    }
    return malformed();
  };
  const scan = (depth: number): void => {
    if (depth > 8 || ++nodes > 512) malformed();
    whitespace();
    const c = value[at];
    if (c === '"') {
      string();
      return;
    }
    if (c === '{') {
      at++;
      whitespace();
      const seen = new Set<string>();
      if (value[at] === '}') {
        at++;
        return;
      }
      while (true) {
        if (value[at] !== '"') malformed();
        const key = string();
        if (seen.has(key)) malformed();
        seen.add(key);
        whitespace();
        if (value[at++] !== ':') malformed();
        scan(depth + 1);
        whitespace();
        const end = value[at++];
        if (end === '}') return;
        if (end !== ',') malformed();
        whitespace();
      }
    }
    if (c === '[') {
      at++;
      whitespace();
      if (value[at] === ']') {
        at++;
        return;
      }
      while (true) {
        scan(depth + 1);
        whitespace();
        const end = value[at++];
        if (end === ']') return;
        if (end !== ',') malformed();
      }
    }
    const start = at;
    while (at < value.length && !/[\x20\t\r\n,\]}]/.test(value[at] ?? '')) at++;
    if (at === start) malformed();
    // JSON.parse below validates exact literal/number grammar and numeric semantics.
  };
  scan(0);
  whitespace();
  if (at !== value.length) malformed();
  try {
    return JSON.parse(value);
  } catch {
    return malformed();
  }
}
