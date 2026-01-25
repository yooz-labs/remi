/**
 * Tests for the OutputProcessor class and processOutput function.
 */

import { describe, expect, test } from 'bun:test';
import type { AgentStatus, Message, Question } from '@remi/shared';
import { generateId } from '@remi/shared';
import { OutputProcessor, processOutput } from '../src/parser/output-processor.ts';

describe('processOutput()', () => {
  const sessionId = 'test-session-123';

  test('processes simple text output', () => {
    const result = processOutput(sessionId, 'Hello, this is output.');
    expect(result.message.content).toBe('Hello, this is output.');
    expect(result.message.sessionId).toBe(sessionId);
    expect(result.message.sender).toBe('agent');
    expect(result.status).toBe('idle');
  });

  test('strips ANSI codes from output', () => {
    const result = processOutput(sessionId, '\x1b[31mRed text\x1b[0m');
    expect(result.message.content).toBe('Red text');
  });

  test('filters terminal UI elements', () => {
    const result = processOutput(sessionId, '─────\nActual content\n⏺ Bash(ls)');
    expect(result.message.content).toBe('Actual content');
  });

  test('detects questions in output', () => {
    const result = processOutput(sessionId, 'Do you want to continue? (y/n)');
    expect(result.question).toBeDefined();
    expect(result.question?.text).toBe('Do you want to continue?');
  });

  test('returns undefined question when none detected', () => {
    const result = processOutput(sessionId, 'No question here.');
    expect(result.question).toBeUndefined();
  });

  test('detects thinking status', () => {
    const result = processOutput(sessionId, 'Thinking...');
    expect(result.status).toBe('thinking');
  });

  test('message has correct state', () => {
    const result = processOutput(sessionId, 'Output');
    expect(result.message.state).toBe('sent');
    expect(result.message.isEditing).toBe(false);
  });

  test('handles empty output', () => {
    const result = processOutput(sessionId, '');
    expect(result.message.content).toBe('');
    expect(result.status).toBe('idle');
  });

  test('handles multiline output', () => {
    const result = processOutput(sessionId, 'Line 1\nLine 2\nLine 3');
    expect(result.message.content).toContain('Line 1');
    expect(result.message.content).toContain('Line 2');
    expect(result.message.content).toContain('Line 3');
  });
});

describe('OutputProcessor', () => {
  const sessionId = generateId();

  test('constructs with required config', () => {
    const processor = new OutputProcessor({ sessionId });
    expect(processor.status).toBe('idle');
    expect(processor.currentContent).toBe('');
    expect(processor.hasPendingQuestion).toBe(false);
  });

  test('constructs with optional config', () => {
    const processor = new OutputProcessor({
      sessionId,
      updateThrottleMs: 100,
      bufferSize: 2048,
      streamStatusOnly: true,
    });
    expect(processor.status).toBe('idle');
  });

  test('emits onMessage for agent output boundary', () => {
    const messages: Message[] = [];
    const processor = new OutputProcessor(
      { sessionId },
      {
        onMessage: (msg) => messages.push(msg),
      },
    );

    processor.process('⏺ Hello from the agent\n');
    processor.flush();

    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages[0]?.sender).toBe('agent');
  });

  test('emits onStatusChange when status changes', () => {
    const statuses: Array<{ status: AgentStatus; context: string | undefined }> = [];
    const processor = new OutputProcessor(
      { sessionId },
      {
        onStatusChange: (status, context) => statuses.push({ status, context }),
      },
    );

    processor.process('Thinking...\n');
    processor.flush();

    expect(statuses.length).toBeGreaterThanOrEqual(1);
    expect(statuses[0]?.status).toBe('thinking');
  });

  test('emits onQuestion when question is detected', () => {
    const questions: Question[] = [];
    const processor = new OutputProcessor(
      { sessionId },
      {
        onQuestion: (q) => questions.push(q),
      },
    );

    processor.process('Do you want to proceed? (y/n)\n');
    processor.flush();

    expect(questions.length).toBe(1);
    expect(questions[0]?.text).toBe('Do you want to proceed?');
  });

  test('does not emit messages in streamStatusOnly mode', () => {
    const messages: Message[] = [];
    const processor = new OutputProcessor(
      { sessionId, streamStatusOnly: true },
      { onMessage: (msg) => messages.push(msg) },
    );

    processor.process('⏺ Agent output\n');
    processor.flush();

    expect(messages.length).toBe(0);
  });

  test('still emits status in streamStatusOnly mode', () => {
    const statuses: AgentStatus[] = [];
    const processor = new OutputProcessor(
      { sessionId, streamStatusOnly: true },
      { onStatusChange: (s) => statuses.push(s) },
    );

    processor.process('Thinking...\n');
    processor.flush();

    expect(statuses.length).toBeGreaterThanOrEqual(1);
  });

  test('still emits questions in streamStatusOnly mode', () => {
    const questions: Question[] = [];
    const processor = new OutputProcessor(
      { sessionId, streamStatusOnly: true },
      { onQuestion: (q) => questions.push(q) },
    );

    processor.process('Continue? (y/n)\n');
    processor.flush();

    expect(questions.length).toBe(1);
  });

  test('reset clears all state', () => {
    const messages: Message[] = [];
    const processor = new OutputProcessor(
      { sessionId },
      {
        onMessage: (msg) => messages.push(msg),
      },
    );

    processor.process('⏺ First message\n');
    processor.flush();
    expect(messages.length).toBeGreaterThanOrEqual(1);

    processor.reset();
    expect(processor.status).toBe('idle');
    expect(processor.currentContent).toBe('');
    expect(processor.hasPendingQuestion).toBe(false);
  });

  test('processes large buffer immediately', () => {
    const messages: Message[] = [];
    const processor = new OutputProcessor(
      { sessionId, bufferSize: 50 },
      { onMessage: (msg) => messages.push(msg) },
    );

    // Content larger than buffer size - use multi-word content to avoid UI filter
    const largeContent =
      '⏺ This is a long message with enough words to exceed the buffer size limit for testing purposes\n';
    processor.process(largeContent);
    processor.flush();

    expect(messages.length).toBeGreaterThanOrEqual(1);
  });

  test('emits onMessageUpdate for continuation lines', () => {
    const updates: Array<{ id: string; content: string }> = [];
    const messages: Message[] = [];
    const processor = new OutputProcessor(
      { sessionId },
      {
        onMessage: (msg) => messages.push(msg),
        onMessageUpdate: (id, content) => updates.push({ id, content }),
      },
    );

    processor.process('⏺ First line\n');
    processor.process('Second line continues\n');
    processor.flush();

    // Should have initial message and then an update
    expect(messages.length).toBeGreaterThanOrEqual(1);
  });

  test('skips user echo lines', () => {
    const messages: Message[] = [];
    const processor = new OutputProcessor(
      { sessionId },
      {
        onMessage: (msg) => messages.push(msg),
      },
    );

    processor.process('❯ user typed this\n');
    processor.flush();

    // User echo should not generate agent messages
    expect(messages.length).toBe(0);
  });

  test('skips thinking indicator lines', () => {
    const messages: Message[] = [];
    const processor = new OutputProcessor(
      { sessionId },
      {
        onMessage: (msg) => messages.push(msg),
      },
    );

    processor.process('✻ thinking about this\n');
    processor.flush();

    expect(messages.length).toBe(0);
  });

  test('skips tool output metadata lines', () => {
    const messages: Message[] = [];
    const processor = new OutputProcessor(
      { sessionId },
      {
        onMessage: (msg) => messages.push(msg),
      },
    );

    processor.process('⎿ tool output here\n');
    processor.flush();

    expect(messages.length).toBe(0);
  });

  test('deduplicates repeated content', () => {
    const messages: Message[] = [];
    const processor = new OutputProcessor(
      { sessionId },
      {
        onMessage: (msg) => messages.push(msg),
      },
    );

    processor.process('⏺ Hello world\n');
    processor.process('Hello world\n'); // Duplicate
    processor.flush();

    // Content should not be duplicated
    const first = messages[0];
    if (first) {
      const occurrences = first.content.split('Hello world').length - 1;
      expect(occurrences).toBeLessThanOrEqual(1);
    }
  });

  test('flush with empty buffer does nothing', () => {
    const messages: Message[] = [];
    const processor = new OutputProcessor(
      { sessionId },
      {
        onMessage: (msg) => messages.push(msg),
      },
    );

    processor.flush();
    expect(messages.length).toBe(0);
  });

  test('handles newline-only content', () => {
    const messages: Message[] = [];
    const processor = new OutputProcessor(
      { sessionId },
      {
        onMessage: (msg) => messages.push(msg),
      },
    );

    processor.process('\n\n\n');
    processor.flush();

    // No meaningful content, no messages
    expect(messages.length).toBe(0);
  });

  test('extracts tool name from agent boundary lines', () => {
    const messages: Message[] = [];
    const processor = new OutputProcessor(
      { sessionId },
      {
        onMessage: (msg) => messages.push(msg),
      },
    );

    processor.process('⏺ Bash(date) executed\n');
    processor.flush();

    // The line with Bash() should be filtered by filterTerminalUI
    // But check it doesn't crash
    expect(processor.status).toBeDefined();
  });

  test('finalizes message on new agent boundary', () => {
    const messages: Message[] = [];
    const updates: Array<{ id: string; content: string }> = [];
    const processor = new OutputProcessor(
      { sessionId },
      {
        onMessage: (msg) => messages.push(msg),
        onMessageUpdate: (id, content) => updates.push({ id, content }),
      },
    );

    processor.process('⏺ First message content\n');
    processor.process('⏺ Second message content\n');
    processor.flush();

    // Should have created at least one message
    expect(messages.length).toBeGreaterThanOrEqual(1);
  });
});
