import { expect, test } from '@playwright/test';
import { DAEMON1_PORT, DAEMON2_PORT, connectToDaemon, waitForSessionList } from '../helpers/daemon';

test.describe('Session list', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
  });

  test('shows Sessions heading after connection', async ({ page }) => {
    await connectToDaemon(page, DAEMON1_PORT);
    await waitForSessionList(page);
  });

  test('shows session after connecting to daemon (one session per daemon)', async ({ page }) => {
    await connectToDaemon(page, DAEMON1_PORT);
    // With one-session-per-daemon, the daemon always has a session.
    // The session list should show at least one session card.
    await waitForSessionList(page);
  });

  test('connect and settings buttons in header', async ({ page }) => {
    await connectToDaemon(page, DAEMON1_PORT);
    await expect(page.locator('[aria-label="Connect to daemon"]')).toBeVisible();
    await expect(page.locator('[aria-label="Settings"]')).toBeVisible();
  });

  test('can switch between daemons', async ({ page }) => {
    // Connect to daemon1
    await connectToDaemon(page, DAEMON1_PORT);
    await waitForSessionList(page);

    // Connect to daemon2 using the helper (handles the full modal flow)
    await connectToDaemon(page, DAEMON2_PORT);
    await waitForSessionList(page);
  });
});
