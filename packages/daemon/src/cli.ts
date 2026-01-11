#!/usr/bin/env bun
/**
 * Remi Daemon CLI
 * Starts the WebSocket server and manages Claude Code PTY sessions.
 */

import { PTYManager, PTYSession } from './pty/index.ts';
import { WebSocketServer } from './server/index.ts';
import { OutputProcessor } from './parser/index.ts';
import { generateId, now } from '@remi/shared';

const PORT = process.env.REMI_PORT ? Number.parseInt(process.env.REMI_PORT) : 8765;

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

        // Create PTYSession directly with custom event handlers
        ptySession = new PTYSession(
          {
            command: 'claude',
            args: [],
            cwd: process.cwd(),
          },
          {
            onData: (output: string) => {
              // Process output for questions, status, etc.
              if (processor) {
                processor.process(output);
              }

              // Log locally for debugging
              process.stdout.write(output);

              // Send output to client as agent_output message
              connection.send({
                type: 'agent_output',
                id: generateId(),
                timestamp: now(),
                message: {
                  id: generateId(),
                  sessionId: ptySession.id,
                  sender: 'agent' as const,
                  content: output,
                  createdAt: now(),
                  state: 'sent' as const,
                  stateChangedAt: now(),
                  isEditing: false,
                },
              });
            },
            onExit: (code: number | null) => {
              console.log(`👋 Session ${ptySession.id} exited with code ${code}`);
              activeSessions.delete(connection.id);
            },
            onError: (error: Error) => {
              console.error(`❌ Session ${ptySession.id} error:`, error);
            },
          }
        );

        // Create output processor for this session
        processor = new OutputProcessor(
          { sessionId: ptySession.id },
          {
            onQuestion: (question) => {
              console.log(`❓ Question detected: ${question.type}`);
              // TODO: Send question to client via protocol
            },
            onStatus: (status) => {
              console.log(`📊 Status: ${status.status}`);
              // TODO: Send status to client via protocol
            },
            onMessage: (message) => {
              console.log(`💬 Message: ${message.content.substring(0, 50)}...`);
              // TODO: Send message to client via protocol
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
