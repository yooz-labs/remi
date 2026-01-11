/**
 * Adapter Registry - Manages multiple connection adapters.
 *
 * Allows the daemon to run WebSocket, Telegram, etc. simultaneously.
 */

import type { UUID, ProtocolMessage, Message, Question, AgentStatus } from '@remi/shared';
import type { ConnectionAdapter, AdapterEvents } from './connection-adapter.ts';

/** Events emitted by the registry */
export interface RegistryEvents extends AdapterEvents {
  /** Adapter started */
  onAdapterStart: (adapterType: string) => void;

  /** Adapter stopped */
  onAdapterStop: (adapterType: string) => void;
}

/**
 * Manages multiple connection adapters.
 *
 * Routes events from all adapters to a single set of handlers.
 * Tracks which connections belong to which adapter for message routing.
 */
export class AdapterRegistry {
  private readonly adapters: Map<string, ConnectionAdapter> = new Map();
  private readonly connectionToAdapter: Map<UUID, string> = new Map();
  private readonly events: Partial<RegistryEvents>;

  constructor(events: Partial<RegistryEvents> = {}) {
    this.events = events;
  }

  /** Get total connection count across all adapters */
  get totalConnections(): number {
    let total = 0;
    for (const adapter of this.adapters.values()) {
      total += adapter.connectionCount;
    }
    return total;
  }

  /** Get registered adapter types */
  get adapterTypes(): string[] {
    return Array.from(this.adapters.keys());
  }

  /**
   * Register an adapter.
   * The adapter's events will be wired to this registry's handlers.
   */
  register(adapter: ConnectionAdapter): void {
    if (this.adapters.has(adapter.type)) {
      throw new Error(`Adapter type '${adapter.type}' already registered`);
    }
    this.adapters.set(adapter.type, adapter);
  }

  /**
   * Unregister an adapter.
   * Stops the adapter if running.
   */
  async unregister(adapterType: string): Promise<void> {
    const adapter = this.adapters.get(adapterType);
    if (!adapter) {
      return;
    }

    if (adapter.isRunning) {
      await adapter.stop();
    }

    // Remove connection mappings for this adapter
    for (const [connId, type] of this.connectionToAdapter.entries()) {
      if (type === adapterType) {
        this.connectionToAdapter.delete(connId);
      }
    }

    this.adapters.delete(adapterType);
  }

  /**
   * Start all registered adapters.
   */
  async startAll(): Promise<void> {
    const startPromises = Array.from(this.adapters.entries()).map(
      async ([type, adapter]) => {
        try {
          await adapter.start();
          this.events.onAdapterStart?.(type);
        } catch (error) {
          console.error(`Failed to start adapter '${type}':`, error);
          throw error;
        }
      },
    );

    await Promise.all(startPromises);
  }

  /**
   * Stop all registered adapters.
   */
  async stopAll(): Promise<void> {
    const stopPromises = Array.from(this.adapters.entries()).map(
      async ([type, adapter]) => {
        try {
          await adapter.stop();
          this.events.onAdapterStop?.(type);
        } catch (error) {
          console.error(`Failed to stop adapter '${type}':`, error);
        }
      },
    );

    await Promise.all(stopPromises);
    this.connectionToAdapter.clear();
  }

  /**
   * Track a new connection from an adapter.
   * Called by adapters when a new connection is established.
   */
  trackConnection(connectionId: UUID, adapterType: string): void {
    this.connectionToAdapter.set(connectionId, adapterType);
  }

  /**
   * Untrack a connection.
   * Called by adapters when a connection is closed.
   */
  untrackConnection(connectionId: UUID): void {
    this.connectionToAdapter.delete(connectionId);
  }

  /**
   * Get the adapter type for a connection.
   */
  getAdapterType(connectionId: UUID): string | undefined {
    return this.connectionToAdapter.get(connectionId);
  }

  /**
   * Get an adapter by type.
   */
  getAdapter(adapterType: string): ConnectionAdapter | undefined {
    return this.adapters.get(adapterType);
  }

  /**
   * Send a message to a specific connection.
   * Automatically routes to the correct adapter.
   */
  sendMessage(connectionId: UUID, message: Message): boolean {
    const adapterType = this.connectionToAdapter.get(connectionId);
    if (!adapterType) {
      return false;
    }

    const adapter = this.adapters.get(adapterType);
    return adapter?.sendMessage(connectionId, message) ?? false;
  }

  /**
   * Send a question to a specific connection.
   */
  sendQuestion(connectionId: UUID, question: Question): boolean {
    const adapterType = this.connectionToAdapter.get(connectionId);
    if (!adapterType) {
      return false;
    }

    const adapter = this.adapters.get(adapterType);
    return adapter?.sendQuestion(connectionId, question) ?? false;
  }

  /**
   * Send a status update to a specific connection.
   */
  sendStatus(connectionId: UUID, status: AgentStatus, context?: string): boolean {
    const adapterType = this.connectionToAdapter.get(connectionId);
    if (!adapterType) {
      return false;
    }

    const adapter = this.adapters.get(adapterType);
    return adapter?.sendStatus(connectionId, status, context) ?? false;
  }

  /**
   * Send a raw protocol message to a specific connection.
   */
  sendRaw(connectionId: UUID, message: ProtocolMessage): boolean {
    const adapterType = this.connectionToAdapter.get(connectionId);
    if (!adapterType) {
      return false;
    }

    const adapter = this.adapters.get(adapterType);
    return adapter?.sendRaw(connectionId, message) ?? false;
  }

  /**
   * Broadcast a message to all connections on all adapters.
   */
  broadcast(message: ProtocolMessage): void {
    for (const adapter of this.adapters.values()) {
      adapter.broadcast(message);
    }
  }

  /**
   * Check if a connection exists.
   */
  hasConnection(connectionId: UUID): boolean {
    return this.connectionToAdapter.has(connectionId);
  }
}
