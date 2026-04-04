import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';

export const DAEMON1_PORT = 19765;
export const DAEMON2_PORT = 19766;

const DAEMON_CONTAINERS: Record<number, string> = {
  [DAEMON1_PORT]: 'remi-test-daemon1',
  [DAEMON2_PORT]: 'remi-test-daemon2',
};

const DAEMON_PROJECTS: Record<number, string> = {
  [DAEMON1_PORT]: '/projects/sample-app',
  [DAEMON2_PORT]: '/projects/api-server',
};

/**
 * Seed a daemon with replayable history before the browser attaches.
 * Writes a fresh Claude transcript entry into the daemon container and waits
 * for the fallback transcript watcher to ingest it.
 */
export async function seedReplayableHistory(
  port: number = DAEMON1_PORT,
  prompt = `remi-replay-${Date.now()}`,
): Promise<string> {
  const container = DAEMON_CONTAINERS[port];
  const projectPath = DAEMON_PROJECTS[port];

  if (!container || !projectPath) {
    throw new Error(`No E2E daemon mapping configured for port ${port}`);
  }

  const transcriptDir = `/root/.claude/projects/${projectPath.replace(/\//g, '-')}`;
  const transcriptFile = `${transcriptDir}/e2e_${Date.now()}_${randomUUID()}.jsonl`;
  const entry = JSON.stringify({
    type: 'user',
    uuid: randomUUID(),
    parentUuid: null,
    sessionId: randomUUID(),
    timestamp: new Date().toISOString(),
    cwd: projectPath,
    version: 'e2e',
    message: {
      role: 'user',
      content: prompt,
    },
  });

  const script = [
    `mkdir -p ${JSON.stringify(transcriptDir)}`,
    `cat > ${JSON.stringify(transcriptFile)} <<'EOF'`,
    entry,
    'EOF',
  ].join('\n');

  execFileSync('docker', ['exec', container, 'sh', '-lc', script], {
    stdio: 'pipe',
  });

  // The daemon polls for fresh transcripts every 2s when hooks are unavailable.
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  return prompt;
}

/**
 * Connect to a Remi daemon via the web UI's ConnectModal.
 * Opens the modal, fills in the host, and waits for connection.
 */
export async function connectToDaemon(page: Page, port: number = DAEMON1_PORT): Promise<void> {
  // Click the connect button in the session list header
  await page.click('[aria-label="Connect to daemon"]');

  // Wait for modal to appear
  await page.getByRole('heading', { name: 'Connect' }).waitFor();

  // Clear the host input and point it at the requested daemon.
  const hostInput = page.locator('input[placeholder="localhost"]');
  await hostInput.clear();
  await hostInput.fill(`localhost:${port}`);

  // Click the Connect button in the modal footer if it's enabled.
  // The app may auto-connect when the URL changes (if previously connected),
  // in which case the button is already disabled and "Connected!" is shown.
  const connectButton = page.locator('button:has-text("Connect")').last();
  const isEnabled = await connectButton.isEnabled().catch(() => false);
  if (isEnabled) {
    await connectButton.click();
  }

  // Wait for the modal to close (auto-closes on first connection)
  // or wait for "Connected!" and close manually (when switching daemons)
  const modalClosed = await page
    .getByRole('heading', { name: 'Connect' })
    .waitFor({ state: 'hidden', timeout: 3_000 })
    .then(() => true)
    .catch(() => false);

  if (!modalClosed) {
    // Modal still open; should show "Connected" status
    await page.waitForSelector('text=Connected', { timeout: 5_000 });
    await page.locator('[aria-label="Close"]').first().click();
    await page
      .getByRole('heading', { name: 'Connect' })
      .waitFor({ state: 'hidden', timeout: 3_000 });
  }
}

/**
 * Wait for the main Remi shell to appear (indicates connection is active).
 */
export async function waitForSessionList(page: Page): Promise<void> {
  await page.waitForSelector('h1:has-text("Remi")', { timeout: 10_000 });
}

/**
 * Open the settings panel.
 */
export async function openSettings(page: Page): Promise<void> {
  await page.click('[aria-label="Settings"]');
  await page.waitForSelector('text=Settings');
}

/**
 * Close the settings panel.
 */
export async function closeSettings(page: Page): Promise<void> {
  await page.click('[aria-label="Close settings"]');
  await page.waitForSelector('[aria-label="Close settings"]', { state: 'hidden' });
}
