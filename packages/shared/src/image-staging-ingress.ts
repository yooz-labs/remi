/** Dormant raw candidacy probe; selection is neither JSON validation nor transfer authority. */
export function isImageStagingCandidate(input: string | Uint8Array): boolean {
  if (typeof input !== 'string' && !(input instanceof Uint8Array)) return false;
  // Read the received units directly: no input-sized copy, UTF-8/JSON/base64 conversion or cutoff.
  const code = (index: number): number =>
    typeof input === 'string' ? input.charCodeAt(index) : (input[index] ?? -1);
  const whitespace = (c: number): boolean => c === 32 || c === 9 || c === 10 || c === 13;
  const hex = (c: number): number =>
    c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1;
  let at = 0;
  while (at < input.length && whitespace(code(at))) at++;
  if (code(at++) !== 123) return false;
  // Match only fixed ASCII tokens. All other string content is traversed without being retained.
  const string = (expected: string, prefix = false): boolean => {
    at++; // Opening quote.
    let length = 0;
    let matches = true;
    while (at < input.length) {
      let c = code(at++);
      if (c === 34) return expected.length > 0 && matches && length === expected.length;
      if (c === 92) {
        c = code(at++);
        if (c === 117) {
          let decoded = 0;
          let valid = true;
          for (let digit = 0; digit < 4; digit++) {
            const value = hex(code(at++));
            if (value < 0) valid = false;
            decoded = decoded * 16 + value;
          }
          c = valid ? decoded : -1;
        } else if (c === 98) c = 8;
        else if (c === 102) c = 12;
        else if (c === 110) c = 10;
        else if (c === 114) c = 13;
        else if (c === 116) c = 9;
        else if (c !== 34 && c !== 92 && c !== 47) c = -1;
      }
      if (length >= expected.length || c !== expected.charCodeAt(length)) matches = false;
      length++;
      // A recognizable partial value still routes to strict rejection, never legacy parsing.
      if (prefix && matches && length === expected.length) return true;
    }
    return false;
  };
  let depth = 1;
  let member = 0; // Root key, colon, value, or consumed value (0, 1, 2, 3).
  let typeKey = false;
  while (at < input.length && depth > 0) {
    const c = code(at);
    if (c === 34) {
      if (depth === 1 && member === 0) {
        typeKey = string('type');
        member = 1;
      } else {
        if (string(depth === 1 && member === 2 && typeKey ? 'image_upload_' : '', true))
          return true;
        if (depth === 1) member = 3;
      }
      continue;
    }
    at++;
    if (c === 123 || c === 91) {
      if (depth === 1) member = 3;
      depth++;
    } else if (c === 125 || c === 93) depth--;
    else if (depth === 1 && c === 44) {
      member = 0;
      typeKey = false;
    } else if (depth === 1 && member === 1 && c === 58) member = 2;
  }
  return false;
}
