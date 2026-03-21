import { execSync } from 'node:child_process';
import * as path from 'node:path';

const COMPOSE_FILE = path.resolve(__dirname, '../integration/docker-compose.yml');

export default async function globalTeardown() {
  console.log('Stopping Docker daemons...');

  try {
    execSync(`docker compose -f ${COMPOSE_FILE} down --remove-orphans`, {
      stdio: 'inherit',
      timeout: 30_000,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`Failed to stop Docker daemons cleanly: ${detail}`);
  }

  console.log('Docker daemons stopped.');
}
