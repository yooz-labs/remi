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
  } catch {
    console.warn('Failed to stop Docker daemons cleanly.');
  }

  console.log('Docker daemons stopped.');
}
