/**
 * HTTP server receiving Claude Code hook events.
 *
 * Claude Code posts JSON to this endpoint when configured hooks fire.
 * The server parses the payload and emits typed events for the daemon
 * to consume (status changes, question detection, session info).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { errorToString } from '@remi/shared';
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

/**
 * Synchronous decision for a PermissionRequest (#496). Claude Code BLOCKS on
 * the hook response and honors `hookSpecificOutput.decision`:
 *   - 'allow' / 'deny' => Claude proceeds WITHOUT rendering the prompt, via
 *                         `{behavior: decision}`.
 *   - 'passthrough'    => `{}` body; Claude renders the prompt as usual (the
 *                         resolver has already escalated to the user / injected
 *                         a multi-choice pick).
 *   - `{behavior:'allow', updatedPermissions}` (#718) => Claude proceeds AND
 *     persists the echoed `permission_suggestions` entry, exactly as if the
 *     user had picked that "always allow" option in its own dialog (ground
 *     truth: code.claude.com/docs/en/hooks). Produced when the user's answer
 *     picked a suggestion-derived option on a HELD escalation
 *     (`AutoApproveGate.resolveHeld` with a `suggestionIndex`).
 */
export type PermissionDecision =
  | 'allow'
  | 'deny'
  | 'passthrough'
  | { readonly behavior: 'allow'; readonly updatedPermissions: readonly unknown[] };

export type PermissionResolver = (input: PermissionRequestHookInput) => Promise<PermissionDecision>;

export class HookServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private readonly config: Required<HookServerConfig>;
  private readonly events: Partial<HookServerEvents>;
  private readonly listeners: Map<string, Listener<HookInput>[]> = new Map();
  /**
   * Synchronous PermissionRequest decider (#496). When set, `handleRequest`
   * AWAITS it for PermissionRequest events and returns the decision in the 2xx
   * body INSTEAD of the fire-and-forget dispatch + `{}`. Null => legacy path
   * (dispatch to listeners, return `{}`; the old PTY-injection answers).
   */
  private permissionResolver: PermissionResolver | null = null;
  /** Whether we've already warned about REMI_HOOK_DEBUG write failures. Throttles spam. */
  private diagLogWarned = false;

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

  /**
   * Install the synchronous PermissionRequest decider (#496). At most one; a
   * later call replaces the earlier. Pass null to clear (revert to the legacy
   * dispatch path). The resolver MUST resolve (not reject) — it is wrapped so a
   * rejection is treated as 'passthrough' (fail to the user), but it should
   * return 'passthrough' explicitly on its own errors.
   */
  setPermissionResolver(resolver: PermissionResolver | null): void {
    this.permissionResolver = resolver;
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

    // Diagnostic dump: when REMI_HOOK_DEBUG=1, write every raw hook payload
    // to ~/.remi/hook-diag.jsonl for inspecting what Claude Code actually sends.
    // Used to investigate team/subagent event filtering (issue #316).
    if (process.env['REMI_HOOK_DEBUG'] === '1') {
      try {
        const logLine = JSON.stringify({ _ts: new Date().toISOString(), ...body });
        const remiDir = path.join(os.homedir(), '.remi');
        const logPath = path.join(remiDir, 'hook-diag.jsonl');
        fs.mkdirSync(remiDir, { recursive: true });
        fs.appendFileSync(logPath, `${logLine}\n`);
      } catch (err) {
        // Diagnostic logging must never break the hook path.
        // But warn ONCE so an enabled flag producing no output is visible.
        if (!this.diagLogWarned) {
          this.diagLogWarned = true;
          console.warn(
            `[HookServer] REMI_HOOK_DEBUG enabled but writing failed: ${errorToString(err)}`,
          );
        }
      }
    }

    const eventName = body['hook_event_name'] as string;

    if (!eventName) {
      return new Response(JSON.stringify({ error: 'missing hook_event_name' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Synchronous PermissionRequest decision (#496). When a resolver is
    // installed, Claude BLOCKS on this response; we AWAIT the verdict and
    // return allow/deny (Claude proceeds without rendering the prompt) or
    // passthrough ({}). The resolver owns the eval + escalate-to-user side
    // effects, so we do NOT also fire the legacy dispatch for this event.
    if (eventName === 'PermissionRequest' && this.permissionResolver) {
      let decision: PermissionDecision = 'passthrough';
      try {
        decision = await this.permissionResolver(body as unknown as PermissionRequestHookInput);
      } catch (err) {
        // Fail to the user: a resolver error must never block Claude or
        // silently allow. passthrough renders the prompt for a human.
        this.events.onError?.(err instanceof Error ? err : new Error(String(err)));
        decision = 'passthrough';
      }
      return this.permissionDecisionResponse(decision);
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

  /**
   * Serialise a PermissionDecision into the Claude Code hook response. allow/
   * deny use the verified `hookSpecificOutput.decision.behavior` shape;
   * passthrough is the bare `{}` that lets Claude render the prompt; the
   * object variant (#718) passes its `{behavior:'allow', updatedPermissions}`
   * through verbatim, so Claude persists the echoed suggestion.
   */
  private permissionDecisionResponse(decision: PermissionDecision): Response {
    const headers = { 'Content-Type': 'application/json' };
    if (decision === 'passthrough') {
      return new Response('{}', { status: 200, headers });
    }
    const hookDecision = typeof decision === 'string' ? { behavior: decision } : decision;
    const body = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: hookDecision,
      },
    });
    return new Response(body, { status: 200, headers });
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
