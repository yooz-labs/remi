#!/usr/bin/env bun
/**
 * Remi Daemon CLI
 * Starts connection adapters and manages Claude Code PTY sessions.
 *
 * Usage:
 *   bun run remi-daemon [--port PORT] [--no-telegram]
 *   remi-daemon [--port PORT] [--no-telegram]
 *
 * Environment variables:
 * - REMI_PORT: WebSocket port (default: 18765)
 * - TELEGRAM_BOT_TOKEN: Telegram bot token (optional)
 * - TELEGRAM_ENABLED: Enable Telegram adapter (default: true if token provided)
 *
 * Loads .env from current directory automatically.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Load .env file if present
const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex > 0) {
      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();
      // Remove quotes if present
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  }
  console.log(`Loaded environment from ${envPath}`);
}
import {
  createBulletExpandResponse,
  createHelloAck,
  createReplayBatch,
  createStructuredAgentOutput,
  generateId,
  now,
} from '@remi/shared';
import type { AgentStatus, ProtocolMessage, UUID } from '@remi/shared';
import {
  type AdapterMetadata,
  AdapterRegistry,
  TelegramAdapter,
  WebSocketAdapter,
} from './adapters/index.ts';
import { MessageAPI } from './api/index.ts';
import { OutputProcessor } from './parser/index.ts';
import { PTYManager, PTYSession } from './pty/index.ts';
import { SessionRegistry } from './session/index.ts';

/**
 * Resolve a directory path, expanding ~ and validating it exists.
 * Returns resolved path or null with error message.
 */
function resolveDirectory(
  inputPath: string | null | undefined,
): { resolved: string } | { error: string } {
  if (!inputPath) {
    return { resolved: process.cwd() };
  }

  let resolved = inputPath;

  // Expand ~ to home directory
  if (resolved.startsWith('~/')) {
    resolved = path.join(os.homedir(), resolved.slice(2));
  } else if (resolved === '~') {
    resolved = os.homedir();
  }

  // Resolve to absolute path
  resolved = path.resolve(resolved);

  // Check if directory exists
  if (!fs.existsSync(resolved)) {
    return { error: `Directory not found: ${resolved}` };
  }

  // Check if it's actually a directory
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    return { error: `Not a directory: ${resolved}` };
  }

  return { resolved };
}

// Parse CLI arguments
const args = process.argv.slice(2);
let cliPort: number | undefined;
let cliNoTelegram = false;
let cliMaxBulletLength: number | undefined;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  const nextArg = args[i + 1];
  if (arg === '--port' && nextArg) {
    cliPort = Number.parseInt(nextArg);
    i++;
  } else if (arg === '--max-bullet-length' && nextArg) {
    cliMaxBulletLength = Number.parseInt(nextArg);
    i++;
  } else if (arg === '--no-telegram') {
    cliNoTelegram = true;
  } else if (args[i] === '--help' || args[i] === '-h') {
    console.log(`
Remi Daemon - Claude Code session monitor

Usage: remi-daemon [options]

Options:
  --port PORT              WebSocket port (default: 18765, env: REMI_PORT)
  --max-bullet-length N    Truncate bullets longer than N chars (default: 500, 0=disabled)
  --no-telegram            Disable Telegram adapter
  --help, -h               Show this help

Environment:
  REMI_PORT                WebSocket port
  REMI_MAX_BULLET_LENGTH   Max bullet length before truncation (default: 500, 0=disabled)
  TELEGRAM_BOT_TOKEN       Telegram bot token (enables Telegram adapter)
  TELEGRAM_ENABLED         Set to 'false' to disable Telegram

The daemon loads .env from current directory automatically.
`);
    process.exit(0);
  }
}

// Obscure default port (18765) - less likely to conflict
const PORT =
  cliPort || (process.env['REMI_PORT'] ? Number.parseInt(process.env['REMI_PORT']) : 18765);
const MAX_BULLET_LENGTH =
  cliMaxBulletLength ??
  (process.env['REMI_MAX_BULLET_LENGTH']
    ? Number.parseInt(process.env['REMI_MAX_BULLET_LENGTH'])
    : 500);
const TELEGRAM_TOKEN = process.env['TELEGRAM_BOT_TOKEN'];
const TELEGRAM_ENABLED =
  !cliNoTelegram && process.env['TELEGRAM_ENABLED'] !== 'false' && !!TELEGRAM_TOKEN;

console.log('Starting Remi daemon...');

// Create PTY manager (may be used for multi-session management later)
const _ptyManager = new PTYManager();

// Session registry for managing session lifecycle independently of connections
const sessionRegistry = new SessionRegistry(
  {
    orphanTimeoutMs: 5 * 60 * 1000, // 5 minutes
    maxReplayHistory: 1000,
  },
  {
    onSessionCreated: (sessionId) => {
      console.log(`Session created: ${sessionId}`);
    },
    onSessionClosed: (sessionId, reason) => {
      console.log(`Session closed: ${sessionId} (reason: ${reason})`);
    },
    onSessionOrphaned: (sessionId) => {
      console.log(`Session orphaned: ${sessionId} (will timeout in 5 minutes)`);
    },
    onSessionResumed: (sessionId, connectionId) => {
      console.log(`Session resumed: ${sessionId} by connection ${connectionId}`);
    },
  },
);

/**
 * Create a new PTY session and register it.
 * Returns the session ID.
 */
async function createNewSession(
  sessionId: UUID,
  workingDirectory: string,
  sendMessage: (sessionId: UUID, message: ProtocolMessage) => void,
): Promise<void> {
  // Helper to send and record messages
  const sendAndRecord = (message: ProtocolMessage) => {
    sendMessage(sessionId, message);
    sessionRegistry.recordOutgoingMessage(sessionId, message);
  };

  // Create MessageAPI with event handlers for adapters
  const messageApi = new MessageAPI(
    {
      sessionId: sessionId,
      initialBulletId: 1,
      maxBulletLength: MAX_BULLET_LENGTH,
    },
    {
      onStructuredMessage: (message) => {
        const bulletCount = message.bullets.length;
        console.log(
          `New message with ${bulletCount} bullets (IDs: ${message.firstBulletId}-${message.lastBulletId})`,
        );
        sendAndRecord(createStructuredAgentOutput(message, false));
      },
      onStructuredMessageUpdate: (msgId, message, changedBulletIds) => {
        console.log(`Update message ${msgId}: ${changedBulletIds.length} bullets changed`);
        sendAndRecord(createStructuredAgentOutput(message, true, changedBulletIds));
      },
      onMessageFinalized: (msgId) => {
        console.log(`Message ${msgId} finalized`);
      },
      onQuestion: (question) => {
        console.log(`Question detected: ${question.text.substring(0, 50)}...`);
        const msg: ProtocolMessage = {
          type: 'question',
          id: generateId(),
          timestamp: now(),
          question: question,
        };
        sendAndRecord(msg);
        sessionRegistry.updateQuestion(sessionId, question);
      },
      onStatusChange: (status: AgentStatus, context?: string) => {
        console.log(`Status: ${status}${context ? ` (${context})` : ''}`);
        const msg: ProtocolMessage = {
          type: 'session_update',
          id: generateId(),
          timestamp: now(),
          session: {
            id: sessionId,
            name: '',
            startedAt: now(),
            status,
            isActive: status !== 'idle',
          },
        };
        sendAndRecord(msg);
        sessionRegistry.updateStatus(sessionId, status);
      },
    },
  );

  // Create PTYSession with custom event handlers
  const ptySession = new PTYSession(
    {
      command: 'claude',
      args: [],
      cwd: workingDirectory,
    },
    {
      onData: (output: string) => {
        // Process output through the processor
        if (processor) {
          processor.process(output);
        }
        // Log raw output locally for debugging
        process.stdout.write(output);
      },
      onExit: (code: number | null) => {
        console.log(`PTY ${ptySession.id} exited with code ${code}`);
        if (processor) {
          processor.flush();
        }
        sessionRegistry.handlePTYExit(sessionId);
      },
      onError: (error: Error) => {
        console.error(`PTY ${ptySession.id} error:`, error);
      },
    },
  );

  // Create output processor that feeds into MessageAPI
  const processor = new OutputProcessor(
    {
      sessionId: sessionId,
      updateThrottleMs: 100,
    },
    {
      onMessage: (message) => {
        messageApi.handleMessage(message);
      },
      onMessageUpdate: (messageId, content, tool) => {
        messageApi.handleMessageUpdate(messageId, content, tool);
      },
      onQuestion: (question) => {
        messageApi.handleQuestion(question);
      },
      onStatusChange: (status: AgentStatus, context?: string) => {
        messageApi.handleStatusChange(status, context);
      },
    },
  );

  // Register the session before starting PTY
  sessionRegistry.registerSession(sessionId, workingDirectory, ptySession, processor, messageApi);

  // Start the session
  await ptySession.start();
}

// Create adapter registry with shared event handlers
const registry = new AdapterRegistry({
  onAdapterStart: (type) => {
    console.log(`Adapter '${type}' started`);
  },
  onAdapterStop: (type) => {
    console.log(`Adapter '${type}' stopped`);
  },
});

// Helper to send message to connection
const sendToConnection = (connectionId: UUID, message: ProtocolMessage): void => {
  registry.sendRaw(connectionId, message as any);
};

// Shared event handlers for all adapters
const sharedEvents = {
  onConnect: async (connectionId: UUID, metadata: AdapterMetadata) => {
    console.log(`Client connected: ${connectionId} (${metadata.adapterType})`);
    console.log(`   Display name: ${metadata.displayName}`);

    // Track connection in adapter registry
    registry.trackConnection(connectionId, metadata.adapterType);

    // Check if this is a resume request
    const resumeSessionId = metadata.platformData?.['resumeSessionId'] as UUID | undefined;

    if (resumeSessionId && sessionRegistry.canResume(resumeSessionId)) {
      // Resume existing session
      console.log(`Resuming session ${resumeSessionId}...`);
      const result = sessionRegistry.attachConnection(resumeSessionId, connectionId);

      if (result.success) {
        // Send HelloAck with resume info
        sendToConnection(
          connectionId,
          createHelloAck('1.0.0', resumeSessionId, {
            isResume: true,
            replayCount: result.replayMessages.length,
            nextBulletId: result.nextBulletId,
          }),
        );

        // Send replay batch if there are messages to replay
        if (result.replayMessages.length > 0) {
          sendToConnection(
            connectionId,
            createReplayBatch(resumeSessionId, result.replayMessages, true),
          );
        }

        console.log(
          `Session ${resumeSessionId} resumed with ${result.replayMessages.length} messages replayed`,
        );
        return;
      }

      console.log(`Resume failed: ${result.error}, creating new session`);
    }

    // Create new session
    const requestedDir = metadata.platformData?.['directory'] as string | undefined;
    const dirResult = resolveDirectory(requestedDir);

    if ('error' in dirResult) {
      console.error(`Directory error: ${dirResult.error}`);
      // TODO: Send error message to client
      return;
    }

    const workingDirectory = dirResult.resolved;
    const sessionId = sessionRegistry.createSessionId();

    console.log(`Creating new session ${sessionId} in ${workingDirectory}...`);

    try {
      // Create the session (registers with sessionRegistry)
      await createNewSession(sessionId, workingDirectory, (sid, msg) => {
        const session = sessionRegistry.getSession(sid);
        if (session?.activeConnectionId) {
          sendToConnection(session.activeConnectionId, msg);
        }
      });

      // Attach connection to session
      const result = sessionRegistry.attachConnection(sessionId, connectionId);

      if (result.success) {
        // Send HelloAck with new session info
        sendToConnection(
          connectionId,
          createHelloAck('1.0.0', sessionId, {
            isResume: false,
            replayCount: 0,
            nextBulletId: 1,
          }),
        );
        console.log(`Session ${sessionId} created and attached to connection ${connectionId}`);
      } else {
        console.error(`Failed to attach connection: ${result.error}`);
      }
    } catch (error) {
      console.error('Failed to create session:', error);
    }
  },

  onDisconnect: async (connectionId: UUID, reason: string) => {
    console.log(`Client disconnected: ${connectionId}`);
    console.log(`   Reason: ${reason}`);

    // Detach connection from session (session stays alive for 5 minutes)
    sessionRegistry.detachConnection(connectionId);

    // Untrack connection from adapter registry
    registry.untrackConnection(connectionId);
  },

  onUserInput: async (connectionId: UUID, _sessionId: UUID, content: string) => {
    console.log(`User input from ${connectionId}: ${content}`);

    const session = sessionRegistry.getSessionForConnection(connectionId);
    if (session) {
      await session.pty.submitInput(content);
    } else {
      console.warn(`No session found for connection ${connectionId}`);
    }
  },

  onAnswer: async (connectionId: UUID, _questionId: UUID, answer: string) => {
    console.log(`Answer from ${connectionId}: ${answer}`);

    const session = sessionRegistry.getSessionForConnection(connectionId);
    if (session) {
      // Submit answer as input to the PTY
      await session.pty.submitInput(answer);
      // Clear the question
      sessionRegistry.updateQuestion(session.sessionId, null);
    } else {
      console.warn(`No session found for connection ${connectionId}`);
    }
  },

  onBulletExpandRequest: (
    connectionId: UUID,
    sessionId: UUID,
    bulletId: number,
    requestId: UUID,
  ) => {
    const session = sessionRegistry.getSession(sessionId);
    if (!session) {
      console.warn(`Bullet expand: session ${sessionId} not found`);
      return;
    }

    const fullContent = session.messageApi.getFullBulletContent(bulletId);
    if (fullContent === null) {
      console.warn(`Bullet expand: content for bullet ${bulletId} not found or expired`);
      return;
    }

    // Send expand response
    sendToConnection(connectionId, createBulletExpandResponse(bulletId, fullContent, requestId));
  },

  onError: (connectionId: UUID, error: Error) => {
    console.error(`Error from ${connectionId}:`, error);
  },
};

// Create and register WebSocket adapter
const wsAdapter = new WebSocketAdapter(
  {
    port: PORT,
    host: '0.0.0.0',
  },
  sharedEvents,
);
registry.register(wsAdapter);
console.log(`WebSocket adapter configured on port ${PORT}`);

// Create and register Telegram adapter if token is provided
if (TELEGRAM_ENABLED && TELEGRAM_TOKEN) {
  const telegramAdapter = new TelegramAdapter(
    {
      token: TELEGRAM_TOKEN,
      defaultDirectory: process.cwd(),
    },
    sharedEvents,
  );
  registry.register(telegramAdapter);
  console.log('Telegram adapter configured');
} else {
  console.log('Telegram adapter disabled (no TELEGRAM_BOT_TOKEN)');
}

// Start all adapters
await registry.startAll();

console.log('');
console.log('Remi daemon ready!');
console.log(`  WebSocket: ws://localhost:${PORT}/ws`);
console.log(`  Port: ${PORT} (use --port to change)`);
console.log(
  `  Bullet truncation: ${MAX_BULLET_LENGTH > 0 ? `${MAX_BULLET_LENGTH} chars` : 'disabled'}`,
);
if (TELEGRAM_ENABLED) {
  console.log('  Telegram: Bot is running');
}
console.log('');
console.log('Press Ctrl+C to stop');
console.log('');

// Graceful shutdown
async function shutdown() {
  console.log('\nShutting down gracefully...');

  // Stop all adapters
  await registry.stopAll();

  // Close all sessions via registry
  await sessionRegistry.shutdown();

  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
