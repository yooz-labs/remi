/**
 * Tests for BulletEngine - bullet extraction and tracking.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import type { Message } from '@remi/shared';
import { BulletEngine } from '../src/parser/bullet-engine.ts';

describe('BulletEngine', () => {
  let engine: BulletEngine;

  beforeEach(() => {
    engine = new BulletEngine('test-session');
  });

  describe('extractBullets()', () => {
    test('extracts dash bullets', () => {
      const content = `- First item
- Second item
- Third item`;

      const bullets = engine.extractBullets(content);

      expect(bullets.length).toBe(3);
      expect(bullets[0]?.type).toBe('dash');
      expect(bullets[0]?.content).toBe('- First item');
      expect(bullets[0]?.bulletId).toBe(1);
      expect(bullets[1]?.bulletId).toBe(2);
      expect(bullets[2]?.bulletId).toBe(3);
    });

    test('extracts numbered bullets', () => {
      const content = `1. First step
2. Second step
3. Third step`;

      const bullets = engine.extractBullets(content);

      expect(bullets.length).toBe(3);
      expect(bullets[0]?.type).toBe('numbered');
      expect(bullets[0]?.originalNumber).toBe('1');
      expect(bullets[1]?.originalNumber).toBe('2');
      expect(bullets[2]?.originalNumber).toBe('3');
    });

    test('extracts asterisk bullets', () => {
      const content = `* Point one
* Point two`;

      const bullets = engine.extractBullets(content);

      expect(bullets.length).toBe(2);
      expect(bullets[0]?.type).toBe('asterisk');
      expect(bullets[1]?.type).toBe('asterisk');
    });

    test('extracts unicode bullet characters', () => {
      const content = `• Bullet one
● Bullet two
◦ Bullet three`;

      const bullets = engine.extractBullets(content);

      expect(bullets.length).toBe(3);
      for (const bullet of bullets) {
        expect(bullet.type).toBe('bullet');
      }
    });

    test('handles multi-line bullets', () => {
      const content = `- First bullet with
  continuation on next line
- Second bullet`;

      const bullets = engine.extractBullets(content);

      expect(bullets.length).toBe(2);
      expect(bullets[0]?.content).toContain('continuation');
      expect(bullets[0]?.startLine).toBe(0);
      expect(bullets[0]?.endLine).toBe(1);
    });

    test('handles code blocks within bullets', () => {
      const content = `- Here is some code:
\`\`\`typescript
const x = 1;
- this is not a bullet
const y = 2;
\`\`\`
- Next bullet`;

      const bullets = engine.extractBullets(content);

      expect(bullets.length).toBe(2);
      expect(bullets[0]?.hasCodeBlock).toBe(true);
      expect(bullets[0]?.content).toContain('const x = 1');
      expect(bullets[0]?.content).toContain('this is not a bullet'); // Inside code block
      expect(bullets[1]?.content).toBe('- Next bullet');
    });

    test('continues bullet ID across calls', () => {
      engine.extractBullets('- First');
      const bullets = engine.extractBullets('- Second');

      expect(bullets[0]?.bulletId).toBe(2); // Continues from previous
    });

    test('returns empty array for content without bullets', () => {
      const content = `This is just plain text
with multiple lines
but no bullets.`;

      const bullets = engine.extractBullets(content);

      expect(bullets.length).toBe(0);
    });

    test('handles mixed bullet types', () => {
      const content = `- Dash bullet
* Asterisk bullet
1. Numbered bullet
• Unicode bullet`;

      const bullets = engine.extractBullets(content);

      expect(bullets.length).toBe(4);
      expect(bullets[0]?.type).toBe('dash');
      expect(bullets[1]?.type).toBe('asterisk');
      expect(bullets[2]?.type).toBe('numbered');
      expect(bullets[3]?.type).toBe('bullet');
    });

    test('does not treat ** bold as bullet', () => {
      const content = `**This is bold text**
- This is a real bullet`;

      const bullets = engine.extractBullets(content);

      expect(bullets.length).toBe(1);
      expect(bullets[0]?.type).toBe('dash');
    });

    test('handles numbered bullets with parenthesis', () => {
      const content = `1) First item
2) Second item`;

      const bullets = engine.extractBullets(content);

      expect(bullets.length).toBe(2);
      expect(bullets[0]?.type).toBe('numbered');
      expect(bullets[0]?.originalNumber).toBe('1');
    });
  });

  describe('structureMessage()', () => {
    test('creates structured message with bullets', () => {
      const message: Message = {
        id: 'msg-1',
        sessionId: 'session-1',
        sender: 'agent',
        content: `- First bullet
- Second bullet`,
        createdAt: '2026-01-21T00:00:00.000Z',
        state: 'sent',
        stateChangedAt: '2026-01-21T00:00:00.000Z',
        isEditing: false,
      };

      const structured = engine.structureMessage(message);

      expect(structured.bullets.length).toBe(2);
      expect(structured.firstBulletId).toBe(1);
      expect(structured.lastBulletId).toBe(2);
      expect(structured.id).toBe('msg-1'); // Preserves original fields
    });

    test('handles message without bullets', () => {
      const message: Message = {
        id: 'msg-1',
        sessionId: 'session-1',
        sender: 'agent',
        content: 'Just plain text',
        createdAt: '2026-01-21T00:00:00.000Z',
        state: 'sent',
        stateChangedAt: '2026-01-21T00:00:00.000Z',
        isEditing: false,
      };

      const structured = engine.structureMessage(message);

      expect(structured.bullets.length).toBe(0);
      expect(structured.firstBulletId).toBeUndefined();
      expect(structured.lastBulletId).toBeUndefined();
    });
  });

  describe('updateStructuredMessage()', () => {
    test('re-structures message on edit', () => {
      const message: Message = {
        id: 'msg-1',
        sessionId: 'session-1',
        sender: 'agent',
        content: '- Original bullet',
        createdAt: '2026-01-21T00:00:00.000Z',
        state: 'sent',
        stateChangedAt: '2026-01-21T00:00:00.000Z',
        isEditing: true,
      };

      const structured = engine.structureMessage(message);
      expect(structured.bullets.length).toBe(1);
      expect(structured.firstBulletId).toBe(1);

      const updated = engine.updateStructuredMessage(
        structured,
        `- Original bullet
- Added bullet`,
      );

      expect(updated.bullets.length).toBe(2);
      expect(updated.firstBulletId).toBe(1); // Same as before
      expect(updated.lastBulletId).toBe(2);
    });
  });

  describe('countBullets()', () => {
    test('counts bullets without modifying engine state', () => {
      const content = `- One
- Two
- Three`;

      const count = BulletEngine.countBullets(content);

      expect(count).toBe(3);
      // Engine state should not be affected
      expect(engine.nextId).toBe(1);
    });
  });

  describe('setInitialId()', () => {
    test('sets starting bullet ID for resume', () => {
      engine.setInitialId(100);
      const bullets = engine.extractBullets('- First after resume');

      expect(bullets[0]?.bulletId).toBe(100);
      expect(engine.bulletCount).toBe(100);
    });
  });

  describe('reset()', () => {
    test('resets bullet counter to 1', () => {
      engine.extractBullets('- One\n- Two');
      expect(engine.bulletCount).toBe(2);

      engine.reset();

      expect(engine.bulletCount).toBe(0);
      expect(engine.nextId).toBe(1);
    });
  });

  describe('edge cases', () => {
    test('handles empty content', () => {
      const bullets = engine.extractBullets('');
      expect(bullets.length).toBe(0);
    });

    test('handles whitespace-only content', () => {
      const bullets = engine.extractBullets('   \n\n   ');
      expect(bullets.length).toBe(0);
    });

    test('handles indented bullets', () => {
      const content = `  - Indented dash
    - More indented`;

      const bullets = engine.extractBullets(content);

      expect(bullets.length).toBe(2);
    });

    test('handles unclosed code block at end', () => {
      const content = `- Bullet with code:
\`\`\`
const x = 1;`;

      const bullets = engine.extractBullets(content);

      expect(bullets.length).toBe(1);
      expect(bullets[0]?.hasCodeBlock).toBe(true);
    });

    test('handles multiple code blocks in one bullet', () => {
      const content = `- Example:
\`\`\`js
const a = 1;
\`\`\`
And also:
\`\`\`js
const b = 2;
\`\`\`
- Next bullet`;

      const bullets = engine.extractBullets(content);

      expect(bullets.length).toBe(2);
      expect(bullets[0]?.hasCodeBlock).toBe(true);
    });
  });

  describe('truncation', () => {
    test('truncates bullets exceeding maxBulletLength', () => {
      const truncatingEngine = new BulletEngine('test-session', 1, { maxBulletLength: 50 });

      const content = `- This is a very long bullet point that should be truncated because it exceeds the maximum length`;

      const bullets = truncatingEngine.extractBullets(content);

      expect(bullets.length).toBe(1);
      expect(bullets[0]?.isTruncated).toBe(true);
      expect(bullets[0]?.fullLength).toBe(content.length);
      expect(bullets[0]?.content.length).toBeLessThanOrEqual(50);
      expect(bullets[0]?.content).toContain('...');
    });

    test('does not truncate bullets under maxBulletLength', () => {
      const truncatingEngine = new BulletEngine('test-session', 1, { maxBulletLength: 500 });

      const content = `- Short bullet`;

      const bullets = truncatingEngine.extractBullets(content);

      expect(bullets.length).toBe(1);
      expect(bullets[0]?.isTruncated).toBeUndefined();
      expect(bullets[0]?.fullLength).toBeUndefined();
      expect(bullets[0]?.content).toBe('- Short bullet');
    });

    test('does not truncate when maxBulletLength is 0 (disabled)', () => {
      const noTruncEngine = new BulletEngine('test-session', 1, { maxBulletLength: 0 });

      const content = `- This is a very long bullet point that would normally be truncated but truncation is disabled`;

      const bullets = noTruncEngine.extractBullets(content);

      expect(bullets.length).toBe(1);
      expect(bullets[0]?.isTruncated).toBeUndefined();
      expect(bullets[0]?.content).toBe(content);
    });

    test('truncation prefers breaking at newline', () => {
      const truncatingEngine = new BulletEngine('test-session', 1, { maxBulletLength: 60 });

      // Content with newlines - should break at the newline
      const content = `- First line here
Second line here
Third line to push us over`;

      const bullets = truncatingEngine.extractBullets(content);

      expect(bullets.length).toBe(1);
      expect(bullets[0]?.isTruncated).toBe(true);
      // Should end with newline then ...
      expect(bullets[0]?.content).toMatch(/\n\.\.\.$/);
    });

    test('truncation breaks at space when no newline available', () => {
      const truncatingEngine = new BulletEngine('test-session', 1, { maxBulletLength: 50 });

      // Single line without newlines
      const content = `- This is one long line without any newlines at all that exceeds limit`;

      const bullets = truncatingEngine.extractBullets(content);

      expect(bullets.length).toBe(1);
      expect(bullets[0]?.isTruncated).toBe(true);
      // Should not cut in the middle of a word
      expect(bullets[0]?.content).toContain('...');
    });

    test('stores full content in registry when truncated', () => {
      const { BulletContentRegistry } = require('../src/api/bullet-content-registry.ts');
      const registry = new BulletContentRegistry();
      const truncatingEngine = new BulletEngine('test-session', 1, { maxBulletLength: 50 });

      const content = `- This is a very long bullet that will be truncated and stored in the registry`;

      const bullets = truncatingEngine.extractBullets(content, registry);

      expect(bullets.length).toBe(1);
      expect(bullets[0]?.isTruncated).toBe(true);

      // Registry should have the full content
      const fullContent = registry.get(bullets[0]?.bulletId);
      expect(fullContent).toBe(content);
    });

    test('does not store in registry when not truncated', () => {
      const { BulletContentRegistry } = require('../src/api/bullet-content-registry.ts');
      const registry = new BulletContentRegistry();
      const truncatingEngine = new BulletEngine('test-session', 1, { maxBulletLength: 500 });

      const content = `- Short content`;

      const bullets = truncatingEngine.extractBullets(content, registry);

      expect(bullets.length).toBe(1);
      expect(bullets[0]?.isTruncated).toBeUndefined();

      // Registry should NOT have this content
      expect(registry.get(bullets[0]?.bulletId)).toBeNull();
    });
  });
});
