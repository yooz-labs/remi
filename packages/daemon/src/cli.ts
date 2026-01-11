#!/usr/bin/env bun
/**
 * Remi Daemon CLI
 * Starts the WebSocket server and manages Claude Code PTY sessions.
 */

import { PTYManager, PTYSession } from './pty/index.ts';
import { WebSocketServer } from './server/index.ts';
import { OutputProcessor } from './parser/index.ts';
import { generateId, now } from '@remi/shared';
import type { AgentStatus } from '@remi/shared';

const PORT = process.env['REMI_PORT'] ? Number.parseInt(process.env['REMI_PORT']) : 8765;

console.log('🚀 Starting Remi daemon...');
console.log(`📡 WebSocket server will listen on ws://localhost:${PORT}`);

// Create PTY manager
const ptyManager = new PTYManager();

// Track active sessions
const activeSessions = new Map<string, { session: PTYSession; processor: OutputProcessor }>();

// Create WebSocket server with event handlers
const server = new WebSocketServer(
  {
    port: PORT,
    host: '0.0.0.0',
  },
  {
    onClientConnect: async (connection) => {
      console.log(`✅ Client connected: ${connection.id}`);
      console.log(`   Connection state: ${connection.connectionState}`);
      console.log(`   Session ID: ${connection.connectionSessionId}`);

      // Auto-spawn a Claude Code session for this client
      // TODO: In the future, client should request session spawn via protocol
      console.log('🎯 Auto-spawning Claude Code session for client...');

      try {
        // Create variables that will be set
        let ptySession: PTYSession;
        let processor: OutputProcessor;

        // Track current message state for aggregation
        let currentMessageId: string | null = null;

        // Create PTYSession directly with custom event handlers
        ptySession = new PTYSession(
          {
            command: 'claude',
            args: [],
            cwd: process.cwd(),
          },
          {
            onData: (output: string) => {
              // Process output through the processor (handles ANSI stripping and aggregation)
              if (processor) {
                processor.process(output);
              }

              // Log raw output locally for debugging
              process.stdout.write(output);
            },
            onExit: (code: number | null) => {
              console.log(`👋 Session ${ptySession.id} exited with code ${code}`);
              // Flush any pending output
              if (processor) {
                processor.flush();
              }
              activeSessions.delete(connection.id);
            },
            onError: (error: Error) => {
              console.error(`❌ Session ${ptySession.id} error:`, error);
            },
          }
        );

        // Create output processor for this session
        // The processor handles ANSI stripping and message aggregation
        // Use connection.id as sessionId for consistency with hello_ack
        processor = new OutputProcessor(
          {
            sessionId: connection.id,
            updateThrottleMs: 100, // Throttle updates to reduce message frequency
          },
          {
            onMessage: (message) => {
              // New message from Claude - send to client
              currentMessageId = message.id;
              console.log(`💬 New message: ${message.content.substring(0, 50)}...`);

              connection.send({
                type: 'agent_output',
                id: generateId(),
                timestamp: now(),
                message: {
                  id: message.id,
                  sessionId: message.sessionId,
                  sender: message.sender,
                  content: message.content,
                  createdAt: message.createdAt,
                  state: message.state,
                  stateChangedAt: message.stateChangedAt,
                  isEditing: message.isEditing,
                  tool: message.tool,
                },
              });
            },
            onMessageUpdate: (messageId, content, tool) => {
              // Update existing message - send update to client
              console.log(`📝 Update message: ${content.substring(0, 50)}...`);

              connection.send({
                type: 'agent_output',
                id: generateId(),
                timestamp: now(),
                message: {
                  id: messageId,
                  sessionId: connection.id,  // Use connection.id for consistency
                  sender: 'agent' as const,
                  content: content,
                  createdAt: now(),
                  state: 'sent' as const,
                  stateChangedAt: now(),
                  isEditing: true,
                  tool: tool,
                },
              });
            },
            onQuestion: (question) => {
              console.log(`❓ Question detected: ${question.type}`);
              // Send question to client
              connection.send({
                type: 'question',
                id: generateId(),
                timestamp: now(),
                question: question,
              });
            },
            onStatusChange: (status: AgentStatus, context?: string) => {
              console.log(`📊 Status: ${status}${context ? ` (${context})` : ''}`);
              // Send status update to client
              connection.send({
                type: 'status_update',
                id: generateId(),
                timestamp: now(),
                sessionId: connection.id,  // Use connection.id for consistency
                status: status,
                context: context,
              });
            },
          }
        );

        // Start the session
        await ptySession.start();

        // Store session for this connection
        activeSessions.set(connection.id, { session: ptySession, processor });

        console.log(`✅ Session ${ptySession.id} spawned for client ${connection.id}`);
      } catch (error) {
        console.error(`❌ Failed to spawn session:`, error);
      }
    },

    onClientDisconnect: async (connectionId, reason) => {
      console.log(`❌ Client disconnected: ${connectionId}`);
      console.log(`   Reason: ${reason}`);

      // Clean up session
      const sessionData = activeSessions.get(connectionId);
      if (sessionData) {
        await sessionData.session.close();
        activeSessions.delete(connectionId);
      }
    },

    onUserInput: async (connectionId, sessionId, content) => {
      console.log(`📨 User input: ${content}`);

      const sessionData = activeSessions.get(connectionId);
      if (sessionData) {
        // Submit input with proper text + Enter separation
        // This is required for Claude Code to properly process the input
        await sessionData.session.submitInput(content);
      } else {
        console.warn(`⚠️  No session found for connection ${connectionId}`);
      }
    },

    onError: (error) => {
      console.error(`💥 Server error:`, error);
    },
  }
);

// Start the server
await server.start();

console.log(`✨ Remi daemon ready on ws://localhost:${PORT}`);
console.log(`🔗 Connect your client to ws://localhost:${PORT}/ws`);

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  await server.stop();

  // Close all active PTY sessions
  const closePromises = Array.from(activeSessions.values()).map(({ session }) => session.close());
  await Promise.all(closePromises);

  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  await server.stop();

  // Close all active PTY sessions
  const closePromises = Array.from(activeSessions.values()).map(({ session }) => session.close());
  await Promise.all(closePromises);

  process.exit(0);
});
