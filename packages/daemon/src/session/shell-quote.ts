/** `text` as one shell word: unchanged when it is plain, else in single quotes. */
export function shellQuote(text: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;
}
