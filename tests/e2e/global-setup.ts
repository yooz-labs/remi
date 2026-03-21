import { execSync } from 'node:child_process';
import * as path from 'node:path';

const COMPOSE_FILE = path.resolve(__dirname, '../integration/docker-compose.yml');

export default async function globalSetup() {
  console.log('Starting Docker daemons for E2E tests...');

  try {
    // --wait blocks until all services with healthchecks report healthy
    execSync(`docker compose -f ${COMPOSE_FILE} up -d --build --wait`, {
      stdio: 'inherit',
      timeout: 120_000,
      env: { ...process.env },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`Failed to start Docker daemons: ${detail}`);
    throw new Error(`Docker compose up failed: ${detail}`);
  }

  console.log('Docker daemons ready.');
}
