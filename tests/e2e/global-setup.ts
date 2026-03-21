import { execSync } from 'node:child_process';
import * as path from 'node:path';

const COMPOSE_FILE = path.resolve(__dirname, '../integration/docker-compose.yml');
const MAX_WAIT_MS = 60_000;
const POLL_INTERVAL_MS = 2_000;

export default async function globalSetup() {
  console.log('Starting Docker daemons for E2E tests...');

  try {
    execSync(`docker compose -f ${COMPOSE_FILE} up -d --build --wait`, {
      stdio: 'inherit',
      timeout: MAX_WAIT_MS,
      env: { ...process.env },
    });
  } catch {
    console.error('Failed to start Docker daemons. Is Docker running?');
    throw new Error('Docker compose up failed');
  }

  // Wait for daemon1 to be healthy via WebSocket health endpoint
  const start = Date.now();
  let healthy = false;

  while (Date.now() - start < MAX_WAIT_MS) {
    try {
      const res = await fetch('http://localhost:19765/health');
      if (res.ok) {
        healthy = true;
        break;
      }
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  if (!healthy) {
    throw new Error('Daemon health check timed out after 60s');
  }

  console.log('Docker daemons ready.');
}
