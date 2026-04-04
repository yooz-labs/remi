import { expect, test } from '@playwright/test';
import {
  DAEMON1_PORT,
  connectToDaemon,
  seedReplayableHistory,
  waitForSessionList,
} from '../helpers/daemon';

test.describe('Connection flow', () => {
  test.beforeEach(async ({ page }) => {
    // Clear localStorage to start fresh
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
  });

  test('app loads with empty state', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'No Active Sessions' })).toBeVisible();
    await expect(page.locator('[aria-label="Connect to daemon"]')).toBeVisible();
  });

  test('connect modal opens on click', async ({ page }) => {
    await page.goto('/');
    await page.click('[aria-label="Connect to daemon"]');
    await expect(page.getByRole('heading', { name: 'Connect' })).toBeVisible();
    // Direct tab should be active by default
    await expect(page.locator('input[placeholder="localhost"]')).toBeVisible();
  });

  test('connect modal can be closed', async ({ page }) => {
    await page.goto('/');
    await page.click('[aria-label="Connect to daemon"]');
    await expect(page.getByRole('heading', { name: 'Connect' })).toBeVisible();

    // Click close button
    await page.click('[aria-label="Close"]');
    await expect(page.getByRole('heading', { name: 'Connect' })).toBeHidden();
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

  test('first attach replays existing history immediately', async ({ page }) => {
    await page.goto('/');

    const replayPrompt = await seedReplayableHistory(DAEMON1_PORT);

    await connectToDaemon(page, DAEMON1_PORT);
    await waitForSessionList(page);

    await expect(page.getByText(replayPrompt, { exact: false })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Waiting for agent output')).toHaveCount(0);
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
    await expect(page.getByRole('heading', { name: 'Connect' })).toBeVisible({ timeout: 5_000 });
  });
});
