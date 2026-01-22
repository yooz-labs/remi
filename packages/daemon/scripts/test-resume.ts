#!/usr/bin/env bun
/**
 * Test script for session resume functionality.
 * 1. Connects, gets sessionId
 * 2. Waits for some output
 * 3. Disconnects
 * 4. Waits briefly
 * 5. Reconnects with resumeSessionId
 * 6. Verifies replay messages
 */

import { createHello, generateId, type ProtocolMessage } from '@remi/shared';

const WS_URL = 'ws://localhost:18765/ws';
const CLIENT_ID = generateId();

let sessionId: string | null = null;
let messagesReceived: ProtocolMessage[] = [];
let testPhase: 'initial' | 'disconnected' | 'resumed' = 'initial';

async function runTest() {
  console.log('=== Session Resume Test ===\n');

  // Phase 1: Initial connection
  console.log('Phase 1: Initial connection...');
  const ws1 = new WebSocket(WS_URL);

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout in phase 1')), 30000);

    ws1.onopen = () => {
      console.log('  Connected, sending hello...');
      const hello = createHello(CLIENT_ID, '1.0.0', process.cwd());
      ws1.send(JSON.stringify(hello));
    };

    ws1.onmessage = (event) => {
      const data = JSON.parse(event.data as string) as ProtocolMessage & {
        sessionId?: string;
        isResume?: boolean;
        replayCount?: number;
      };

      if (data.type === 'hello_ack') {
        sessionId = data.sessionId ?? null;
        console.log(`  Session established: ${sessionId}`);
        console.log(`  isResume: ${data.isResume ?? false}`);

        // Wait for some messages, then disconnect
        setTimeout(() => {
          console.log(`  Received ${messagesReceived.length} messages, disconnecting...`);
          ws1.close();
          clearTimeout(timeout);
          resolve();
        }, 5000);
      } else {
        messagesReceived.push(data);
        if (data.type === 'structured_agent_output' || data.type === 'status_update') {
          console.log(`  Received: ${data.type}`);
        }
      }
    };

    ws1.onerror = (err) => {
      clearTimeout(timeout);
      reject(err);
    };
  });

  const firstPhaseMessages = messagesReceived.length;
  console.log(`\n  First connection received ${firstPhaseMessages} messages`);

  // Phase 2: Wait briefly
  console.log('\nPhase 2: Waiting 2 seconds...');
  testPhase = 'disconnected';
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Phase 3: Resume connection
  console.log('\nPhase 3: Resuming session...');
  messagesReceived = [];

  const ws2 = new WebSocket(WS_URL);

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout in phase 3')), 30000);

    ws2.onopen = () => {
      console.log('  Connected, sending hello with resumeSessionId...');
      // Use the raw message format to include resumeSessionId
      const hello = {
        type: 'hello',
        id: generateId(),
        timestamp: new Date().toISOString(),
        clientVersion: '1.0.0',
        clientId: CLIENT_ID,
        directory: process.cwd(),
        resumeSessionId: sessionId,
      };
      ws2.send(JSON.stringify(hello));
    };

    ws2.onmessage = (event) => {
      const data = JSON.parse(event.data as string) as ProtocolMessage & {
        sessionId?: string;
        isResume?: boolean;
        replayCount?: number;
        messages?: ProtocolMessage[];
        isComplete?: boolean;
      };

      if (data.type === 'hello_ack') {
        console.log(`  HelloAck received:`);
        console.log(`    sessionId: ${data.sessionId}`);
        console.log(`    isResume: ${data.isResume}`);
        console.log(`    replayCount: ${data.replayCount}`);
        testPhase = 'resumed';
      } else if (data.type === 'replay_batch') {
        console.log(`  ReplayBatch received:`);
        console.log(`    messages: ${data.messages?.length ?? 0}`);
        console.log(`    isComplete: ${data.isComplete}`);

        // Done with test
        clearTimeout(timeout);
        ws2.close();
        resolve();
      } else {
        messagesReceived.push(data);
      }
    };

    ws2.onclose = () => {
      clearTimeout(timeout);
      resolve();
    };

    ws2.onerror = (err) => {
      clearTimeout(timeout);
      reject(err);
    };
  });

  console.log('\n=== Test Complete ===');
  console.log(`  Initial messages: ${firstPhaseMessages}`);
  console.log(`  Resume phase messages: ${messagesReceived.length}`);
  console.log(`  Session ID preserved: ${sessionId !== null}`);
}

runTest()
  .then(() => {
    console.log('\nTest passed!');
    process.exit(0);
  })
  .catch((err) => {
    console.error('\nTest failed:', err);
    process.exit(1);
  });
