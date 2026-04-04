import { expect, test } from '@playwright/test';
import { DAEMON1_PORT, connectToDaemon, waitForSessionList } from '../helpers/daemon';

test.describe('Connection flow', () => {
  test.beforeEach(async ({ page }) => {
    // Clear localStorage to start fresh
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
  });

  test('app loads with empty state', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'No Sessions' })).toBeVisible();
    await expect(page.locator('[aria-label="Connect to daemon"]')).toBeVisible();
  });

  test('connect modal opens on click', async ({ page }) => {
    await page.goto('/');
    await page.click('[aria-label="Connect to daemon"]');
    await expect(page.locator('text=Connect to Daemon')).toBeVisible();
    // Direct tab should be active by default
    await expect(page.locator('input[placeholder="localhost"]')).toBeVisible();
  });

  test('connect modal can be closed', async ({ page }) => {
    await page.goto('/');
    await page.click('[aria-label="Connect to daemon"]');
    await expect(page.locator('text=Connect to Daemon')).toBeVisible();

    // Click close button
    await page.click('[aria-label="Close"]');
    await expect(page.locator('text=Connect to Daemon')).toBeHidden();
  });

  test('direct connection to daemon succeeds', async ({ page }) => {
    await page.goto('/');
    await connectToDaemon(page, DAEMON1_PORT);

    await waitForSessionList(page);
  });

  test('connection persists across reload', async ({ page }) => {
    await page.goto('/');
    await connectToDaemon(page, DAEMON1_PORT);

    await waitForSessionList(page);

    // Reload the page
    await page.reload();

    // Should auto-reconnect from localStorage
    await waitForSessionList(page);
  });

  test('invalid URL shows connection failure', async ({ page }) => {
    await page.goto('/');
    await page.click('[aria-label="Connect to daemon"]');

    const hostInput = page.locator('input[placeholder="localhost"]');
    await hostInput.clear();
    await hostInput.fill('localhost:99999');

    const connectButton = page.locator('button:has-text("Connect")').last();
    await connectButton.click();

    // Modal should remain open (connection failed)
    await expect(page.locator('text=Connect to Daemon')).toBeVisible({ timeout: 5_000 });
  });
});
