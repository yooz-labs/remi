/**
 * Tests for status parsing.
 */

import { describe, expect, test } from 'bun:test';
import { getToolFromStatus, isActive, parseStatus } from '../src/parser/status-parser.ts';

describe('parseStatus()', () => {
  describe('Executing state', () => {
    test('detects Reading file', () => {
      const result = parseStatus('Reading package.json');
      expect(result.status).toBe('executing');
      expect(result.context).toBe('read');
    });

    test('detects Writing file', () => {
      const result = parseStatus('Writing index.ts');
      expect(result.status).toBe('executing');
      expect(result.context).toBe('write');
    });

    test('detects Editing file', () => {
      const result = parseStatus('Editing config.json');
      expect(result.status).toBe('executing');
      expect(result.context).toBe('edit');
    });

    test('detects Running command', () => {
      const result = parseStatus('Running npm install');
      expect(result.status).toBe('executing');
      expect(result.context).toBe('bash');
    });

    test('detects shell command with $', () => {
      const result = parseStatus('$ npm run build');
      expect(result.status).toBe('executing');
      expect(result.context).toBe('bash');
    });

    test('detects Searching', () => {
      const result = parseStatus('Searching for files...');
      expect(result.status).toBe('executing');
      expect(result.context).toBe('search');
    });

    test('detects Fetching', () => {
      const result = parseStatus('Fetching https://api.example.com');
      expect(result.status).toBe('executing');
      expect(result.context).toBe('fetch');
    });

    test('detects Downloading', () => {
      const result = parseStatus('Downloading dependency');
      expect(result.status).toBe('executing');
      expect(result.context).toBe('download');
    });

    test('detects Installing', () => {
      const result = parseStatus('Installing packages');
      expect(result.status).toBe('executing');
      expect(result.context).toBe('install');
    });

    test('detects Building', () => {
      const result = parseStatus('Building project');
      expect(result.status).toBe('executing');
      expect(result.context).toBe('build');
    });

    test('detects Testing', () => {
      const result = parseStatus('Testing components');
      expect(result.status).toBe('executing');
      expect(result.context).toBe('test');
    });

    test('detects Compiling', () => {
      const result = parseStatus('Compiling TypeScript');
      expect(result.status).toBe('executing');
      expect(result.context).toBe('compile');
    });

    test('tool detection is case insensitive', () => {
      const result = parseStatus('READING file.txt');
      expect(result.status).toBe('executing');
      expect(result.context).toBe('read');
    });
  });

  describe('Thinking state', () => {
    test('detects thinking...', () => {
      const result = parseStatus('thinking...');
      expect(result.status).toBe('thinking');
    });

    test('detects analyzing', () => {
      const result = parseStatus('analyzing the codebase');
      expect(result.status).toBe('thinking');
    });

    test('detects planning', () => {
      const result = parseStatus('planning the implementation');
      expect(result.status).toBe('thinking');
    });

    test('detects considering', () => {
      const result = parseStatus('considering options');
      expect(result.status).toBe('thinking');
    });

    test('detects "let me think"', () => {
      const result = parseStatus('Let me think about this');
      expect(result.status).toBe('thinking');
    });

    test('detects processing', () => {
      const result = parseStatus('processing your request');
      expect(result.status).toBe('thinking');
    });

    test('detects examining', () => {
      const result = parseStatus('examining the files');
      expect(result.status).toBe('thinking');
    });

    test('detects reviewing', () => {
      const result = parseStatus('reviewing the changes');
      expect(result.status).toBe('thinking');
    });
  });

  describe('Waiting state', () => {
    test('detects question ending', () => {
      const result = parseStatus('What would you like to do?');
      expect(result.status).toBe('waiting');
    });

    test('detects (y/n)', () => {
      const result = parseStatus('Continue? (y/n)');
      expect(result.status).toBe('waiting');
    });

    test('detects [y/n]', () => {
      const result = parseStatus('Proceed? [y/n]');
      expect(result.status).toBe('waiting');
    });

    test('detects waiting for', () => {
      const result = parseStatus('waiting for your response');
      expect(result.status).toBe('waiting');
    });

    test('detects enter your', () => {
      const result = parseStatus('enter your name:');
      expect(result.status).toBe('waiting');
    });

    test('detects please type', () => {
      const result = parseStatus('please type your response');
      expect(result.status).toBe('waiting');
    });

    test('detects what would you like', () => {
      const result = parseStatus('what would you like me to do');
      expect(result.status).toBe('waiting');
    });

    test('detects selection-box chrome as waiting', () => {
      // The ❯ cursor on a numbered option is the new chrome signal, kept in
      // sync with question-parser's PROMPT_CHROME.
      expect(parseStatus('❯ 1. Yes\n  2. No').status).toBe('waiting');
    });

    test('does NOT treat a bare trailing question mark as waiting', () => {
      // Regression guard for the removed /\?\s*$/ pattern (the false-positive source).
      expect(parseStatus('Are you sure?').status).not.toBe('waiting');
      expect(parseStatus('Is this a question?').status).not.toBe('waiting');
    });
  });

  describe('Idle state', () => {
    test('detects done', () => {
      const result = parseStatus('done');
      expect(result.status).toBe('idle');
    });

    test('detects complete', () => {
      const result = parseStatus('complete');
      expect(result.status).toBe('idle');
    });

    test('detects finished', () => {
      const result = parseStatus('finished');
      expect(result.status).toBe('idle');
    });

    test('detects ready', () => {
      const result = parseStatus('ready');
      expect(result.status).toBe('idle');
    });

    test('detects task completed', () => {
      const result = parseStatus('task completed successfully');
      expect(result.status).toBe('idle');
    });

    test('detects successfully', () => {
      const result = parseStatus('Files saved successfully');
      expect(result.status).toBe('idle');
    });

    test('detects empty prompt', () => {
      const result = parseStatus('> ');
      expect(result.status).toBe('idle');
    });

    test('empty string suggests idle with low confidence', () => {
      const result = parseStatus('');
      expect(result.status).toBe('idle');
      expect(result.confidence).toBeLessThan(0.5);
    });
  });

  describe('Default behavior', () => {
    test('defaults to idle for unrecognized output', () => {
      // Changed from thinking to idle - more conservative default
      // Only show "thinking" when we're confident (matched a thinking pattern)
      const result = parseStatus('Some random output text here');
      expect(result.status).toBe('idle');
      expect(result.confidence).toBe(0.3);
    });

    test('handles multiline output', () => {
      const result = parseStatus('Line 1\nLine 2\nReading file.txt');
      expect(result.status).toBe('executing');
    });
  });

  describe('Confidence levels', () => {
    test('executing has high confidence', () => {
      const result = parseStatus('Reading file.txt');
      expect(result.confidence).toBeGreaterThanOrEqual(0.8);
    });

    test('waiting has high confidence', () => {
      const result = parseStatus('Continue? (y/n)');
      expect(result.confidence).toBeGreaterThanOrEqual(0.8);
    });

    test('thinking has moderate confidence', () => {
      const result = parseStatus('thinking...');
      expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    });

    test('idle has moderate confidence', () => {
      const result = parseStatus('done');
      expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    });
  });

  describe('ANSI code handling', () => {
    test('strips ANSI before parsing', () => {
      const result = parseStatus('\x1b[32mReading\x1b[0m file.txt');
      expect(result.status).toBe('executing');
    });
  });
});

describe('getToolFromStatus()', () => {
  test('returns tool for executing status', () => {
    const result = parseStatus('Reading file.txt');
    expect(getToolFromStatus(result)).toBe('read');
  });

  test('returns undefined for non-executing status', () => {
    const result = parseStatus('thinking...');
    expect(getToolFromStatus(result)).toBeUndefined();
  });

  test('returns undefined for idle', () => {
    const result = parseStatus('done');
    expect(getToolFromStatus(result)).toBeUndefined();
  });
});

describe('isActive()', () => {
  test('returns true for executing', () => {
    expect(isActive('Reading file.txt')).toBe(true);
  });

  test('returns true for thinking', () => {
    expect(isActive('thinking...')).toBe(true);
  });

  test('returns true for waiting', () => {
    expect(isActive('Continue? (y/n)')).toBe(true);
  });

  test('returns false for idle', () => {
    expect(isActive('done')).toBe(false);
  });

  test('returns false for empty prompt', () => {
    expect(isActive('> ')).toBe(false);
  });
});
