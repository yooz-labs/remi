/**
 * #960 second review: real shell quote and escape removal.
 *
 * Three separate vetoes each reasoned about raw command TEXT with their own
 * hand-rolled quote handling, and each was defeated by a different one-
 * character trick. The shell removes quotes and CONCATENATES adjacent spans
 * into one word, so any check matching raw text is matching a string the
 * program will never receive.
 *
 * Every expectation below was confirmed against real `bash -c 'printf "[%s]"'`
 * output before being written down.
 */

import { describe, expect, test } from 'bun:test';
import { shellWords } from '../../src/auto-approve/shell-safety.ts';

describe('shellWords matches bash word-splitting', () => {
  const cases: Array<[string, string[]]> = [
    // Quotes vanish and adjacent spans concatenate -- the property every
    // hand-rolled tokenizer in this module got wrong.
    ['-"o" out.txt', ['-o', 'out.txt']],
    ['-sS"o" x', ['-sSo', 'x']],
    ['--"output" y', ['--output', 'y']],
    ['a"b"c', ['abc']],
    ["a'b'c", ['abc']],
    // Backslash escapes the next character and removes itself. This needs no
    // quote placement at all, which made it the sharpest of the three.
    ['--o\\utput z', ['--output', 'z']],
    ['a\\ b', ['a b']],
    // ANSI-C quoting.
    ["$'o' q", ['o', 'q']],
    // Single quotes are literal; whitespace inside does not split.
    ["'lit eral'", ['lit eral']],
    ['"two words"', ['two words']],
    // Escapes honoured inside double quotes, literal inside single.
    ['"a\\"b"', ['a"b']],
    // Ordinary splitting.
    ['x  y', ['x', 'y']],
    ['git checkout "."', ['git', 'checkout', '.']],
    ['cp -r src dest', ['cp', '-r', 'src', 'dest']],
  ];
  for (const [input, expected] of cases) {
    test(JSON.stringify(input), () => expect(shellWords(input)).toEqual(expected));
  }

  test('an empty quoted string is a real, empty word', () => {
    // bash: `printf "[%s]" ""` prints `[]` -- the word exists.
    expect(shellWords('""')).toEqual(['']);
  });

  test('empty input yields no words', () => {
    expect(shellWords('')).toEqual([]);
    expect(shellWords('   ')).toEqual([]);
  });

  test('an unterminated quote consumes the rest rather than throwing', () => {
    // Malformed input must degrade, not crash: this runs on the 0ms path.
    expect(shellWords('cp "unterminated')).toEqual(['cp', 'unterminated']);
    expect(shellWords("cp 'x")).toEqual(['cp', 'x']);
    expect(shellWords('cp x\\')).toEqual(['cp', 'x']);
  });
});
