/**
 * HTTP server receiving Claude Code hook events.
 *
 * Claude Code posts JSON to this endpoint when configured hooks fire.
 * The server parses the payload and emits typed events for the daemon
 * to consume (status changes, question detection, session info).
 */

import type {
  HookInput,
  NotificationHookInput,
  PermissionRequestHookInput,
  PostToolUseFailureHookInput,
  PostToolUseHookInput,
  PreToolUseHookInput,
  SessionEndHookInput,
  SessionStartHookInput,
  StopFailureHookInput,
  StopHookInput,
  SubagentStartHookInput,
  SubagentStopHookInput,
} from './hook-types.ts';
import { isValidHookEvent } from './hook-types.ts';

export interface HookServerEvents {
  onPreToolUse: (input: PreToolUseHookInput) => void;
  onPostToolUse: (input: PostToolUseHookInput) => void;
  onNotification: (input: NotificationHookInput) => void;
  onStop: (input: StopHookInput) => void;
  onSessionStart: (input: SessionStartHookInput) => void;
  onPermissionRequest: (input: PermissionRequestHookInput) => void;
  onPostToolUseFailure: (input: PostToolUseFailureHookInput) => void;
  onSubagentStart: (input: SubagentStartHookInput) => void;
  onSubagentStop: (input: SubagentStopHookInput) => void;
  onStopFailure: (input: StopFailureHookInput) => void;
  onSessionEnd: (input: SessionEndHookInput) => void;
  onError: (error: Error) => void;
}

/** Maps hook event names to their input types, derived from the HookInput union */
type HookEventMap = {
  [E in HookInput['hook_event_name']]: Extract<HookInput, { hook_event_name: E }>;
};

export interface HookServerConfig {
  port: number;
  hostname?: string;
}

type Listener<T> = (input: T) => void;

export class HookServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private readonly config: Required<HookServerConfig>;
  private readonly events: Partial<HookServerEvents>;
  private readonly listeners: Map<string, Listener<HookInput>[]> = new Map();

  constructor(config: HookServerConfig, events: Partial<HookServerEvents> = {}) {
    this.config = {
      port: config.port,
      hostname: config.hostname ?? '127.0.0.1',
    };
    this.events = events;
  }

  get port(): number {
    return this.config.port;
  }

  get url(): string {
    return `http://${this.config.hostname}:${this.config.port}/hooks`;
  }

  get isRunning(): boolean {
    return this.server !== null;
  }

  /** Register a listener for a specific hook event. Returns a dispose function to remove it. */
  on<K extends keyof HookEventMap>(event: K, listener: Listener<HookEventMap[K]>): () => void {
    const arr = this.listeners.get(event) ?? [];
    const wrapped = listener as Listener<HookInput>;
    arr.push(wrapped);
    this.listeners.set(event, arr);
    return () => {
      const current = this.listeners.get(event);
      if (current) {
        const idx = current.indexOf(wrapped);
        if (idx !== -1) current.splice(idx, 1);
      }
    };
  }

  /** Remove all listeners for a specific event or all events */
  removeListeners(event?: keyof HookEventMap): void {
    if (event) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
  }

  start(): void {
    if (this.server) return;

    this.server = Bun.serve({
      port: this.config.port,
      hostname: this.config.hostname,
      fetch: (req) => this.handleRequest(req),
    });

    // Update config with the actual port assigned by the OS (matters when port=0)
    if (this.server.port != null) {
      this.config.port = this.server.port;
    }
  }

  stop(): void {
    if (this.server) {
      this.server.stop(true);
      this.server = null;
    }
  }

  private async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (req.method !== 'POST' || url.pathname !== '/hooks') {
      return new Response('Not Found', { status: 404 });
    }

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch (err) {
      this.events.onError?.(err instanceof Error ? err : new Error(String(err)));
      return new Response(JSON.stringify({ error: 'parse error' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const eventName = body['hook_event_name'] as string;

    if (!eventName) {
      return new Response(JSON.stringify({ error: 'missing hook_event_name' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Accept all events with 200 to future-proof against new Claude Code events.
    // Only dispatch known events to typed handlers; unknown events are logged.
    if (isValidHookEvent(eventName)) {
      try {
        this.dispatch(body as unknown as HookInput);
      } catch (err) {
        this.events.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    } else {
      console.debug(`[HookServer] Unknown hook event accepted: ${eventName}`);
    }

    return new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private dispatch(input: HookInput): void {
    const eventName = input.hook_event_name;

    // Fire constructor-provided events
    try {
      switch (eventName) {
        case 'PreToolUse':
          this.events.onPreToolUse?.(input);
          break;
        case 'PostToolUse':
          this.events.onPostToolUse?.(input);
          break;
        case 'Notification':
          this.events.onNotification?.(input);
          break;
        case 'Stop':
          this.events.onStop?.(input);
          break;
        case 'SessionStart':
          this.events.onSessionStart?.(input);
          break;
        case 'PermissionRequest':
          this.events.onPermissionRequest?.(input);
          break;
        case 'PostToolUseFailure':
          this.events.onPostToolUseFailure?.(input);
          break;
        case 'SubagentStart':
          this.events.onSubagentStart?.(input);
          break;
        case 'SubagentStop':
          this.events.onSubagentStop?.(input);
          break;
        case 'StopFailure':
          this.events.onStopFailure?.(input);
          break;
        case 'SessionEnd':
          this.events.onSessionEnd?.(input);
          break;
        default:
          // Medium/low priority events (UserPromptSubmit, InstructionsLoaded,
          // TaskCompleted, TeammateIdle, ConfigChange, WorktreeCreate,
          // WorktreeRemove, PreCompact, PostCompact, Elicitation,
          // ElicitationResult) are accepted but only dispatched
          // to dynamic listeners below.
          break;
      }
    } catch (err) {
      this.events.onError?.(err instanceof Error ? err : new Error(String(err)));
    }

    // Fire dynamic listeners
    const listeners = this.listeners.get(eventName);
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(input);
        } catch (err) {
          this.events.onError?.(err instanceof Error ? err : new Error(String(err)));
        }
      }
    }
  }
}
