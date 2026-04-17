/**
 * Content parser for chat messages.
 *
 * Parses message text into structured segments: plain text, code blocks,
 * inline code, bold, italic, and list items.
 */

/** Segment types that can appear in parsed content */
export type ContentSegment =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'code_block';
      readonly language: string;
      readonly code: string;
    }
  | { readonly type: 'inline_code'; readonly code: string }
  | { readonly type: 'bold'; readonly text: string }
  | { readonly type: 'italic'; readonly text: string }
  | {
      readonly type: 'list_item';
      readonly text: string;
      readonly ordered: boolean;
      readonly index: number;
    };

/**
 * Parse message content into structured segments.
 *
 * Handles fenced code blocks (triple backtick), then parses remaining
 * text for inline formatting.
 */
export function parseContent(content: string): ContentSegment[] {
  if (!content) return [];

  const segments: ContentSegment[] = [];

  // Split on fenced code blocks first
  const codeBlockRegex = /```(\w*)\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null = null;

  match = codeBlockRegex.exec(content);
  while (match !== null) {
    // Text before the code block
    if (match.index > lastIndex) {
      const textBefore = content.slice(lastIndex, match.index);
      segments.push(...parseInlineContent(textBefore));
    }

    // The code block itself
    segments.push({
      type: 'code_block',
      language: match[1] || '',
      code: match[2].replace(/\n$/, ''),
    });

    lastIndex = match.index + match[0].length;
    match = codeBlockRegex.exec(content);
  }

  // Remaining text after last code block
  if (lastIndex < content.length) {
    const remaining = content.slice(lastIndex);
    segments.push(...parseInlineContent(remaining));
  }

  return segments;
}

/**
 * Parse inline content for formatting: inline code, bold, italic, lists.
 */
function parseInlineContent(text: string): ContentSegment[] {
  if (!text.trim()) {
    if (text) return [{ type: 'text', text }];
    return [];
  }

  const segments: ContentSegment[] = [];

  // Process line by line to detect list items
  const lines = text.split('\n');
  let currentText = '';

  for (const line of lines) {
    const trimmed = line.trimStart();

    // Ordered list: "1. ", "2. ", etc.
    const orderedMatch = trimmed.match(/^(\d+)\.\s+(.+)$/);
    if (orderedMatch) {
      if (currentText) {
        segments.push(...parseInlineFormatting(currentText));
        currentText = '';
      }
      segments.push({
        type: 'list_item',
        text: orderedMatch[2],
        ordered: true,
        index: Number.parseInt(orderedMatch[1], 10),
      });
      continue;
    }

    // Unordered list: "- ", "* "
    const unorderedMatch = trimmed.match(/^[-*]\s+(.+)$/);
    if (unorderedMatch) {
      if (currentText) {
        segments.push(...parseInlineFormatting(currentText));
        currentText = '';
      }
      segments.push({
        type: 'list_item',
        text: unorderedMatch[1],
        ordered: false,
        index: 0,
      });
      continue;
    }

    // Regular line
    currentText += (currentText ? '\n' : '') + line;
  }

  if (currentText) {
    segments.push(...parseInlineFormatting(currentText));
  }

  return segments;
}

/**
 * Parse inline formatting: backtick code, bold, italic.
 */
function parseInlineFormatting(text: string): ContentSegment[] {
  if (!text) return [];

  const segments: ContentSegment[] = [];
  // Match inline code, bold (**text**), italic (*text* but not **text**)
  const inlineRegex = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null = null;

  match = inlineRegex.exec(text);
  while (match !== null) {
    // Text before the match
    if (match.index > lastIndex) {
      segments.push({ type: 'text', text: text.slice(lastIndex, match.index) });
    }

    const matched = match[0];
    if (matched.startsWith('`')) {
      segments.push({ type: 'inline_code', code: matched.slice(1, -1) });
    } else if (matched.startsWith('**')) {
      segments.push({ type: 'bold', text: matched.slice(2, -2) });
    } else if (matched.startsWith('*')) {
      segments.push({ type: 'italic', text: matched.slice(1, -1) });
    }

    lastIndex = match.index + matched.length;
    match = inlineRegex.exec(text);
  }

  // Remaining text
  if (lastIndex < text.length) {
    segments.push({ type: 'text', text: text.slice(lastIndex) });
  }

  return segments;
}
