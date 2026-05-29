/**
 * Tests for AdapterRegistry.
 *
 * Uses a minimal real adapter implementation for testing.
 */

import { describe, expect, test } from 'bun:test';
import type { AgentStatus, Message, ProtocolMessage, Question, UUID } from '@remi/shared';
import { generateId } from '@remi/shared';
import { AdapterRegistry } from '../src/adapters/adapter-registry.ts';
import type { ConnectionAdapter } from '../src/adapters/connection-adapter.ts';

/**
 * Minimal real adapter implementation for testing.
 * Not a mock - actually tracks state and connections.
 */
class TestAdapter implements ConnectionAdapter {
  readonly type: string;
  private connections: Set<UUID> = new Set();
  private running = false;
  sentMessages: Array<{ connectionId: UUID; message: Message }> = [];
  sentQuestions: Array<{ connectionId: UUID; question: Question }> = [];
  sentStatuses: Array<{ connectionId: UUID; status: AgentStatus }> = [];
  sentRaw: Array<{ connectionId: UUID; message: ProtocolMessage }> = [];
  broadcasts: ProtocolMessage[] = [];

  constructor(type = 'test') {
    this.type = type;
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  get isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
    this.connections.clear();
  }

  addConnection(id: UUID): void {
    this.connections.add(id);
  }

  sendMessage(connectionId: UUID, message: Message): boolean {
    if (!this.connections.has(connectionId)) return false;
    this.sentMessages.push({ connectionId, message });
    return true;
  }

  sendQuestion(connectionId: UUID, question: Question, _sessionId?: UUID): boolean {
    if (!this.connections.has(connectionId)) return false;
    this.sentQuestions.push({ connectionId, question });
    return true;
  }

  sendStatus(connectionId: UUID, status: AgentStatus, _context?: string): boolean {
    if (!this.connections.has(connectionId)) return false;
    this.sentStatuses.push({ connectionId, status });
    return true;
  }

  sendRaw(connectionId: UUID, message: ProtocolMessage): boolean {
    if (!this.connections.has(connectionId)) return false;
    this.sentRaw.push({ connectionId, message });
    return true;
  }

  broadcast(message: ProtocolMessage): void {
    this.broadcasts.push(message);
  }

  hasConnection(connectionId: UUID): boolean {
    return this.connections.has(connectionId);
  }
}

describe('AdapterRegistry', () => {
  test('constructs with empty state', () => {
    const registry = new AdapterRegistry();
    expect(registry.totalConnections).toBe(0);
    expect(registry.adapterTypes).toEqual([]);
  });

  describe('register()', () => {
    test('registers an adapter', () => {
      const registry = new AdapterRegistry();
      const adapter = new TestAdapter('websocket');
      registry.register(adapter);

      expect(registry.adapterTypes).toEqual(['websocket']);
    });

    test('registers multiple adapters', () => {
      const registry = new AdapterRegistry();
      registry.register(new TestAdapter('websocket'));
      registry.register(new TestAdapter('telegram'));

      expect(registry.adapterTypes).toContain('websocket');
      expect(registry.adapterTypes).toContain('telegram');
    });

    test('throws when registering duplicate type', () => {
      const registry = new AdapterRegistry();
      registry.register(new TestAdapter('websocket'));

      expect(() => registry.register(new TestAdapter('websocket'))).toThrow(
        "Adapter type 'websocket' already registered",
      );
    });
  });

  describe('unregister()', () => {
    test('unregisters an adapter', async () => {
      const registry = new AdapterRegistry();
      const adapter = new TestAdapter('websocket');
      registry.register(adapter);
      await adapter.start();

      await registry.unregister('websocket');

      expect(registry.adapterTypes).toEqual([]);
      expect(adapter.isRunning).toBe(false);
    });

    test('does nothing for unknown adapter type', async () => {
      const registry = new AdapterRegistry();
      await registry.unregister('unknown'); // Should not throw
    });

    test('cleans up connection mappings', async () => {
      const registry = new AdapterRegistry();
      const adapter = new TestAdapter('websocket');
      registry.register(adapter);

      const connId = generateId();
      registry.trackConnection(connId, 'websocket');
      expect(registry.hasConnection(connId)).toBe(true);

      await registry.unregister('websocket');
      expect(registry.hasConnection(connId)).toBe(false);
    });
  });

  describe('startAll() / stopAll()', () => {
    test('starts all adapters', async () => {
      const registry = new AdapterRegistry();
      const adapter1 = new TestAdapter('ws');
      const adapter2 = new TestAdapter('tg');
      registry.register(adapter1);
      registry.register(adapter2);

      await registry.startAll();

      expect(adapter1.isRunning).toBe(true);
      expect(adapter2.isRunning).toBe(true);
    });

    test('stops all adapters', async () => {
      const registry = new AdapterRegistry();
      const adapter1 = new TestAdapter('ws');
      const adapter2 = new TestAdapter('tg');
      registry.register(adapter1);
      registry.register(adapter2);

      await registry.startAll();
      await registry.stopAll();

      expect(adapter1.isRunning).toBe(false);
      expect(adapter2.isRunning).toBe(false);
    });

    test('emits onAdapterStart events', async () => {
      const started: string[] = [];
      const registry = new AdapterRegistry({
        onAdapterStart: (type) => started.push(type),
      });
      registry.register(new TestAdapter('ws'));
      registry.register(new TestAdapter('tg'));

      await registry.startAll();

      expect(started).toContain('ws');
      expect(started).toContain('tg');
    });

    test('emits onAdapterStop events', async () => {
      const stopped: string[] = [];
      const registry = new AdapterRegistry({
        onAdapterStop: (type) => stopped.push(type),
      });
      registry.register(new TestAdapter('ws'));

      await registry.startAll();
      await registry.stopAll();

      expect(stopped).toContain('ws');
    });

    test('clears connection tracking on stopAll', async () => {
      const registry = new AdapterRegistry();
      registry.register(new TestAdapter('ws'));
      const connId = generateId();
      registry.trackConnection(connId, 'ws');

      await registry.stopAll();

      expect(registry.hasConnection(connId)).toBe(false);
    });
  });

  describe('connection tracking', () => {
    test('trackConnection and getAdapterType', () => {
      const registry = new AdapterRegistry();
      registry.register(new TestAdapter('ws'));

      const connId = generateId();
      registry.trackConnection(connId, 'ws');

      expect(registry.getAdapterType(connId)).toBe('ws');
    });

    test('untrackConnection removes mapping', () => {
      const registry = new AdapterRegistry();
      registry.register(new TestAdapter('ws'));

      const connId = generateId();
      registry.trackConnection(connId, 'ws');
      registry.untrackConnection(connId);

      expect(registry.getAdapterType(connId)).toBeUndefined();
      expect(registry.hasConnection(connId)).toBe(false);
    });

    test('hasConnection returns true for tracked connections', () => {
      const registry = new AdapterRegistry();
      registry.register(new TestAdapter('ws'));

      const connId = generateId();
      registry.trackConnection(connId, 'ws');

      expect(registry.hasConnection(connId)).toBe(true);
    });

    test('hasConnection returns false for untracked connections', () => {
      const registry = new AdapterRegistry();
      expect(registry.hasConnection(generateId())).toBe(false);
    });

    test('totalConnections reflects adapter connection counts', () => {
      const registry = new AdapterRegistry();
      const adapter = new TestAdapter('ws');
      adapter.addConnection(generateId());
      adapter.addConnection(generateId());
      registry.register(adapter);

      expect(registry.totalConnections).toBe(2);
    });
  });

  describe('message routing', () => {
    test('sendMessage routes to correct adapter', () => {
      const registry = new AdapterRegistry();
      const adapter = new TestAdapter('ws');
      const connId = generateId();
      adapter.addConnection(connId);
      registry.register(adapter);
      registry.trackConnection(connId, 'ws');

      const message: Message = {
        id: generateId(),
        sessionId: generateId(),
        sender: 'agent',
        content: 'Hello',
        createdAt: new Date().toISOString(),
        state: 'sent',
        stateChangedAt: new Date().toISOString(),
        isEditing: false,
      };

      const result = registry.sendMessage(connId, message);
      expect(result).toBe(true);
      expect(adapter.sentMessages.length).toBe(1);
      expect(adapter.sentMessages[0]?.message.content).toBe('Hello');
    });

    test('sendMessage returns false for unknown connection', () => {
      const registry = new AdapterRegistry();
      const message: Message = {
        id: generateId(),
        sessionId: generateId(),
        sender: 'agent',
        content: 'Hello',
        createdAt: new Date().toISOString(),
        state: 'sent',
        stateChangedAt: new Date().toISOString(),
        isEditing: false,
      };

      const result = registry.sendMessage(generateId(), message);
      expect(result).toBe(false);
    });

    test('sendQuestion routes to correct adapter', () => {
      const registry = new AdapterRegistry();
      const adapter = new TestAdapter('ws');
      const connId = generateId();
      adapter.addConnection(connId);
      registry.register(adapter);
      registry.trackConnection(connId, 'ws');

      const question: Question = {
        id: generateId(),
        text: 'Continue?',
        allowsFreeText: false,
        isAnswered: false,
        options: [
          { label: 'Yes', value: 'y', isRecommended: true, isYes: true, isNo: false },
          { label: 'No', value: 'n', isRecommended: false, isYes: false, isNo: true },
        ],
      };

      const result = registry.sendQuestion(connId, question, generateId());
      expect(result).toBe(true);
      expect(adapter.sentQuestions.length).toBe(1);
    });

    test('sendQuestion returns false for unknown connection', () => {
      const registry = new AdapterRegistry();
      const question: Question = {
        id: generateId(),
        text: 'Continue?',
        allowsFreeText: false,
        isAnswered: false,
        options: [],
      };

      expect(registry.sendQuestion(generateId(), question, generateId())).toBe(false);
    });

    test('sendStatus routes to correct adapter', () => {
      const registry = new AdapterRegistry();
      const adapter = new TestAdapter('ws');
      const connId = generateId();
      adapter.addConnection(connId);
      registry.register(adapter);
      registry.trackConnection(connId, 'ws');

      const result = registry.sendStatus(connId, 'thinking');
      expect(result).toBe(true);
      expect(adapter.sentStatuses.length).toBe(1);
      expect(adapter.sentStatuses[0]?.status).toBe('thinking');
    });

    test('sendStatus returns false for unknown connection', () => {
      const registry = new AdapterRegistry();
      expect(registry.sendStatus(generateId(), 'idle')).toBe(false);
    });

    test('sendRaw routes to correct adapter', () => {
      const registry = new AdapterRegistry();
      const adapter = new TestAdapter('ws');
      const connId = generateId();
      adapter.addConnection(connId);
      registry.register(adapter);
      registry.trackConnection(connId, 'ws');

      const rawMsg: ProtocolMessage = {
        type: 'ping',
        id: generateId(),
        timestamp: new Date().toISOString(),
      };

      const result = registry.sendRaw(connId, rawMsg);
      expect(result).toBe(true);
      expect(adapter.sentRaw.length).toBe(1);
    });

    test('sendRaw returns false for unknown connection', () => {
      const registry = new AdapterRegistry();
      const rawMsg: ProtocolMessage = {
        type: 'ping',
        id: generateId(),
        timestamp: new Date().toISOString(),
      };
      expect(registry.sendRaw(generateId(), rawMsg)).toBe(false);
    });
  });

  describe('broadcast()', () => {
    test('broadcasts to all adapters', () => {
      const registry = new AdapterRegistry();
      const adapter1 = new TestAdapter('ws');
      const adapter2 = new TestAdapter('tg');
      registry.register(adapter1);
      registry.register(adapter2);

      const msg: ProtocolMessage = {
        type: 'ping',
        id: generateId(),
        timestamp: new Date().toISOString(),
      };

      registry.broadcast(msg);

      expect(adapter1.broadcasts.length).toBe(1);
      expect(adapter2.broadcasts.length).toBe(1);
    });

    test('broadcast with no adapters does not throw', () => {
      const registry = new AdapterRegistry();
      const msg: ProtocolMessage = {
        type: 'ping',
        id: generateId(),
        timestamp: new Date().toISOString(),
      };

      expect(() => registry.broadcast(msg)).not.toThrow();
    });
  });

  describe('getAdapter()', () => {
    test('returns registered adapter', () => {
      const registry = new AdapterRegistry();
      const adapter = new TestAdapter('ws');
      registry.register(adapter);

      expect(registry.getAdapter('ws')).toBe(adapter);
    });

    test('returns undefined for unregistered type', () => {
      const registry = new AdapterRegistry();
      expect(registry.getAdapter('unknown')).toBeUndefined();
    });
  });

  describe('startAdapter()', () => {
    test('starts a single adapter by type', async () => {
      const registry = new AdapterRegistry();
      const adapter = new TestAdapter('ws');
      registry.register(adapter);
      await registry.startAdapter('ws');
      expect(adapter.isRunning).toBe(true);
    });

    test('throws for unregistered type', async () => {
      const registry = new AdapterRegistry();
      await expect(registry.startAdapter('unknown')).rejects.toThrow('not registered');
    });

    test('emits onAdapterStart event', async () => {
      const started: string[] = [];
      const registry = new AdapterRegistry({ onAdapterStart: (t) => started.push(t) });
      registry.register(new TestAdapter('ws'));
      await registry.startAdapter('ws');
      expect(started).toEqual(['ws']);
    });

    test('does not affect other adapters', async () => {
      const registry = new AdapterRegistry();
      const ws = new TestAdapter('ws');
      const relay = new TestAdapter('relay');
      registry.register(ws);
      registry.register(relay);
      await registry.startAdapter('ws');
      expect(ws.isRunning).toBe(true);
      expect(relay.isRunning).toBe(false);
    });
  });

  describe('startAllExcept()', () => {
    test('starts all except excluded types', async () => {
      const registry = new AdapterRegistry();
      const ws = new TestAdapter('ws');
      const tg = new TestAdapter('telegram');
      const relay = new TestAdapter('relay');
      registry.register(ws);
      registry.register(tg);
      registry.register(relay);

      await registry.startAllExcept(['ws']);

      expect(ws.isRunning).toBe(false);
      expect(tg.isRunning).toBe(true);
      expect(relay.isRunning).toBe(true);
    });

    test('starts all when exclude list is empty', async () => {
      const registry = new AdapterRegistry();
      const ws = new TestAdapter('ws');
      registry.register(ws);
      await registry.startAllExcept([]);
      expect(ws.isRunning).toBe(true);
    });

    test('emits onAdapterStart for started adapters only', async () => {
      const started: string[] = [];
      const registry = new AdapterRegistry({ onAdapterStart: (t) => started.push(t) });
      registry.register(new TestAdapter('ws'));
      registry.register(new TestAdapter('relay'));
      await registry.startAllExcept(['ws']);
      expect(started).toEqual(['relay']);
    });

    test('can exclude multiple types', async () => {
      const registry = new AdapterRegistry();
      const ws = new TestAdapter('ws');
      const tg = new TestAdapter('telegram');
      const relay = new TestAdapter('relay');
      registry.register(ws);
      registry.register(tg);
      registry.register(relay);

      await registry.startAllExcept(['ws', 'telegram']);

      expect(ws.isRunning).toBe(false);
      expect(tg.isRunning).toBe(false);
      expect(relay.isRunning).toBe(true);
    });

    test('propagates error when a non-excluded adapter fails', async () => {
      const registry = new AdapterRegistry();
      const good = new TestAdapter('relay');
      const bad = new TestAdapter('telegram');
      // Override start to throw
      bad.start = async () => {
        throw new Error('Simulated telegram start failure');
      };
      registry.register(good);
      registry.register(bad);

      await expect(registry.startAllExcept(['ws'])).rejects.toThrow(
        'Simulated telegram start failure',
      );
    });
  });

  describe('startAdapter() error propagation', () => {
    test('propagates error from adapter.start()', async () => {
      const registry = new AdapterRegistry();
      const adapter = new TestAdapter('ws');
      adapter.start = async () => {
        throw new Error('listen EADDRINUSE :::18765');
      };
      registry.register(adapter);

      await expect(registry.startAdapter('ws')).rejects.toThrow('EADDRINUSE');
    });

    test('does not emit onAdapterStart when start fails', async () => {
      const started: string[] = [];
      const registry = new AdapterRegistry({ onAdapterStart: (t) => started.push(t) });
      const adapter = new TestAdapter('ws');
      adapter.start = async () => {
        throw new Error('start failure');
      };
      registry.register(adapter);

      await expect(registry.startAdapter('ws')).rejects.toThrow();
      expect(started).toEqual([]);
    });
  });
});
