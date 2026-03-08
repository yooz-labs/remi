import { describe, expect, test } from 'bun:test';
import { parseContent, type ContentSegment } from '../../src/lib/parse-content';

describe('parseContent', () => {
  test('returns empty array for empty string', () => {
    expect(parseContent('')).toEqual([]);
  });

  test('returns empty array for undefined-ish input', () => {
    // @ts-expect-error testing null input
    expect(parseContent(null)).toEqual([]);
    // @ts-expect-error testing undefined input
    expect(parseContent(undefined)).toEqual([]);
  });

  test('returns text segment for plain text', () => {
    const result = parseContent('Hello world');
    expect(result).toEqual([{ type: 'text', text: 'Hello world' }]);
  });

  test('returns text segment for whitespace-only input', () => {
    const result = parseContent('   ');
    expect(result).toEqual([{ type: 'text', text: '   ' }]);
  });

  describe('fenced code blocks', () => {
    test('parses code block without language', () => {
      const result = parseContent('```\nconsole.log("hi")\n```');
      expect(result).toEqual([
        { type: 'code_block', language: '', code: 'console.log("hi")' },
      ]);
    });

    test('parses code block with language', () => {
      const result = parseContent('```typescript\nconst x = 1;\n```');
      expect(result).toEqual([
        { type: 'code_block', language: 'typescript', code: 'const x = 1;' },
      ]);
    });

    test('parses multiple code blocks with text between', () => {
      const input = 'Before\n```js\nfoo()\n```\nMiddle\n```py\nbar()\n```\nAfter';
      const result = parseContent(input);

      // Verify structure: text, code, text, code, text
      const types = result.map((s) => s.type);
      expect(types).toEqual(['text', 'code_block', 'text', 'code_block', 'text']);
      expect(result[1]).toEqual({ type: 'code_block', language: 'js', code: 'foo()' });
      expect(result[3]).toEqual({ type: 'code_block', language: 'py', code: 'bar()' });
    });

    test('handles unclosed code block as plain text', () => {
      const result = parseContent('```js\nsome code without closing');
      // Unclosed block is not matched by regex, treated as inline content
      expect(result.length).toBeGreaterThan(0);
      // Should not produce a code_block segment
      const codeBlocks = result.filter((s) => s.type === 'code_block');
      expect(codeBlocks).toEqual([]);
    });

    test('preserves multiline code in block', () => {
      const code = 'line1\nline2\nline3';
      const result = parseContent(`\`\`\`\n${code}\n\`\`\``);
      expect(result).toEqual([{ type: 'code_block', language: '', code }]);
    });
  });

  describe('inline code', () => {
    test('parses single inline code', () => {
      const result = parseContent('Use `foo()` here');
      expect(result).toEqual([
        { type: 'text', text: 'Use ' },
        { type: 'inline_code', code: 'foo()' },
        { type: 'text', text: ' here' },
      ]);
    });

    test('parses multiple inline codes', () => {
      const result = parseContent('`a` and `b`');
      expect(result).toEqual([
        { type: 'inline_code', code: 'a' },
        { type: 'text', text: ' and ' },
        { type: 'inline_code', code: 'b' },
      ]);
    });
  });

  describe('bold and italic', () => {
    test('parses bold text', () => {
      const result = parseContent('This is **bold** text');
      expect(result).toEqual([
        { type: 'text', text: 'This is ' },
        { type: 'bold', text: 'bold' },
        { type: 'text', text: ' text' },
      ]);
    });

    test('parses italic text', () => {
      const result = parseContent('This is *italic* text');
      expect(result).toEqual([
        { type: 'text', text: 'This is ' },
        { type: 'italic', text: 'italic' },
        { type: 'text', text: ' text' },
      ]);
    });

    test('parses bold and italic in same line', () => {
      const result = parseContent('**bold** and *italic*');
      expect(result).toEqual([
        { type: 'bold', text: 'bold' },
        { type: 'text', text: ' and ' },
        { type: 'italic', text: 'italic' },
      ]);
    });
  });

  describe('lists', () => {
    test('parses ordered list', () => {
      const result = parseContent('1. First\n2. Second\n3. Third');
      expect(result).toEqual([
        { type: 'list_item', text: 'First', ordered: true, index: 1 },
        { type: 'list_item', text: 'Second', ordered: true, index: 2 },
        { type: 'list_item', text: 'Third', ordered: true, index: 3 },
      ]);
    });

    test('parses unordered list with dashes', () => {
      const result = parseContent('- Apple\n- Banana');
      expect(result).toEqual([
        { type: 'list_item', text: 'Apple', ordered: false, index: 0 },
        { type: 'list_item', text: 'Banana', ordered: false, index: 0 },
      ]);
    });

    test('parses unordered list with asterisks', () => {
      const result = parseContent('* One\n* Two');
      expect(result).toEqual([
        { type: 'list_item', text: 'One', ordered: false, index: 0 },
        { type: 'list_item', text: 'Two', ordered: false, index: 0 },
      ]);
    });
  });

  describe('combined content (realistic Claude output)', () => {
    test('parses paragraph with code block and list', () => {
      const input = [
        'Here is how to do it:',
        '',
        '```typescript',
        'const x = 42;',
        'console.log(x);',
        '```',
        '',
        'Key points:',
        '- Use `const` for constants',
        '- Prefer **strict** mode',
        '',
        '1. First step',
        '2. Second step',
      ].join('\n');

      const result = parseContent(input);

      // Should contain text, code_block, list items, inline formatting
      const types = result.map((s) => s.type);
      expect(types).toContain('text');
      expect(types).toContain('code_block');
      expect(types).toContain('list_item');

      // Verify the code block
      const codeBlock = result.find((s) => s.type === 'code_block') as Extract<
        ContentSegment,
        { type: 'code_block' }
      >;
      expect(codeBlock.language).toBe('typescript');
      expect(codeBlock.code).toContain('const x = 42;');

      // Verify ordered list items exist
      const orderedItems = result.filter(
        (s) => s.type === 'list_item' && (s as Extract<ContentSegment, { type: 'list_item' }>).ordered,
      );
      expect(orderedItems.length).toBe(2);

      // Verify unordered list items exist
      const unorderedItems = result.filter(
        (s) => s.type === 'list_item' && !(s as Extract<ContentSegment, { type: 'list_item' }>).ordered,
      );
      expect(unorderedItems.length).toBe(2);
    });

    test('handles text with only newlines', () => {
      const result = parseContent('\n\n\n');
      // Should produce text segments (whitespace only lines)
      expect(result.length).toBeGreaterThan(0);
    });
  });
});
