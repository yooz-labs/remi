import { expect, test } from '@playwright/test';
import { DAEMON1_PORT, DAEMON2_PORT, connectToDaemon } from '../helpers/daemon';

test.describe('Session list', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
  });

  test('shows Sessions heading after connection', async ({ page }) => {
    await connectToDaemon(page, DAEMON1_PORT);
    await expect(page.locator('h1:has-text("Sessions")')).toBeVisible();
  });

  test('empty state visible with fresh daemon (no Claude sessions)', async ({ page }) => {
    await connectToDaemon(page, DAEMON1_PORT);
    // Fresh Docker daemons have no Claude sessions, so the session list is empty.
    // The empty state heading and connect prompt should be visible in the sidebar.
    await expect(page.getByRole('heading', { name: 'No Sessions' })).toBeVisible();
    await expect(page.getByText('Connect to a Claude daemon to start monitoring')).toBeVisible();
  });

  test('connect and settings buttons in header', async ({ page }) => {
    await connectToDaemon(page, DAEMON1_PORT);
    await expect(page.locator('[aria-label="Connect to daemon"]')).toBeVisible();
    await expect(page.locator('[aria-label="Settings"]')).toBeVisible();
  });

  test('can switch between daemons', async ({ page }) => {
    // Connect to daemon1
    await connectToDaemon(page, DAEMON1_PORT);
    await expect(page.locator('h1:has-text("Sessions")')).toBeVisible();

    // Connect to daemon2 using the helper (handles the full modal flow)
    await connectToDaemon(page, DAEMON2_PORT);
    await expect(page.locator('h1:has-text("Sessions")')).toBeVisible();
  });
});
