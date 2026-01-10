#!/usr/bin/env bun
/**
 * Remi Daemon CLI
 * Starts the WebSocket server and manages Claude Code PTY sessions.
 */

import { PTYManager } from './pty/index.ts';
import { WebSocketServer } from './server/index.ts';
import { OutputProcessor } from './parser/index.ts';
import type { PTYSession } from './pty/index.ts';

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

      // Auto-spawn a Claude Code session for this client
      // TODO: In the future, client should request session spawn via protocol
      console.log('🎯 Auto-spawning Claude Code session for client...');

      try {
        const ptySession = ptyManager.createSession({
          command: 'claude',
          args: [],
          cwd: process.cwd(),
        });

        // Create output processor for this session
        const processor = new OutputProcessor(
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

        // Forward PTY output to client (as raw text for now)
        ptySession.on('data', (output: string) => {
          // Process output for questions, status, etc.
          processor.process(output);

          // For now, just log it - we'll add proper protocol messages later
          process.stdout.write(output);
        });

        ptySession.on('exit', (code: number) => {
          console.log(`👋 Session ${ptySession.id} exited with code ${code}`);
          activeSessions.delete(connection.id);
        });

        // Store session for this connection
        activeSessions.set(connection.id, { session: ptySession, processor });

        console.log(`✅ Session ${ptySession.id} spawned for client ${connection.id}`);
      } catch (error) {
        console.error(`❌ Failed to spawn session:`, error);
      }
    },

    onClientDisconnect: (connectionId) => {
      console.log(`❌ Client disconnected: ${connectionId}`);

      // Clean up session
      const sessionData = activeSessions.get(connectionId);
      if (sessionData) {
        sessionData.session.kill();
        activeSessions.delete(connectionId);
      }
    },

    onUserInput: (connectionId, sessionId, content) => {
      console.log(`📨 User input: ${content}`);

      const sessionData = activeSessions.get(connectionId);
      if (sessionData) {
        // Send input to PTY (with newline)
        sessionData.session.write(content + '\n');
      } else {
        console.warn(`⚠️  No session found for connection ${connectionId}`);
      }
    },
  }
);

// Start the server
await server.start();

console.log(`✨ Remi daemon ready on ws://localhost:${PORT}`);
console.log(`🔗 Connect your client to ws://localhost:${PORT}/ws`);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down gracefully...');
  server.stop();
  ptyManager.cleanup();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Shutting down gracefully...');
  server.stop();
  ptyManager.cleanup();
  process.exit(0);
});
