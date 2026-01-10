/**
 * Parser module - Output parsing for Claude Code sessions.
 */

// ANSI utilities
export { stripAnsi, hasAnsi, normalizeLineEndings, cleanForParsing, splitLines } from './ansi.ts';

// Question parser
export { parseQuestion, hasQuestionIndicator } from './question-parser.ts';
export type { QuestionType, ParseResult } from './question-parser.ts';

// Status parser
export { parseStatus, getToolFromStatus, isActive } from './status-parser.ts';
export type { StatusResult } from './status-parser.ts';

// Output processor
export { OutputProcessor, processOutput } from './output-processor.ts';
export type { OutputEvents, ProcessorConfig } from './output-processor.ts';
