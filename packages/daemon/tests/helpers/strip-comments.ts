/**
 * Source-text pins read a daemon source file and assert that a statement is
 * (or is not) in it. Reading the raw file lets a commented-out copy of the
 * statement satisfy the pin, so a pin reads the file through this first.
 *
 * A regex, not a parser: it removes block comments and `//` line comments, and
 * keeps a `//` preceded by `:` (a URL) or `\`. Use it only to read pinned
 * statements, never to rewrite source.
 */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
}
