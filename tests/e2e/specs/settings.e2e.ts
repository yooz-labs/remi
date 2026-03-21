import { expect, test } from '@playwright/test';
import { DAEMON1_PORT, connectToDaemon, openSettings } from '../helpers/daemon';

test.describe('Settings panel', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await connectToDaemon(page, DAEMON1_PORT);
  });

  test('settings panel opens and closes', async ({ page }) => {
    await openSettings(page);
    await expect(page.getByRole('heading', { name: 'Theme' })).toBeVisible();

    await page.click('[aria-label="Close settings"]');
    // Settings heading should no longer be visible
    await expect(page.locator('[aria-label="Close settings"]')).toBeHidden();
  });

  test('theme switching to dark mode', async ({ page }) => {
    await openSettings(page);

    // Click Dark theme button
    await page.click('button:has-text("Dark")');

    // Verify data-theme attribute on html element
    const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(theme).toBe('dark');
  });

  test('theme switching to light mode', async ({ page }) => {
    await openSettings(page);

    // Click Light theme button
    await page.click('button:has-text("Light")');

    const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(theme).toBe('light');
  });

  test('theme persists across reload', async ({ page }) => {
    await openSettings(page);
    await page.click('button:has-text("Dark")');

    // Verify dark theme applied
    let theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(theme).toBe('dark');

    // Reload
    await page.reload();

    // Theme should persist from localStorage
    theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(theme).toBe('dark');
  });

  test('font size changes', async ({ page }) => {
    await openSettings(page);

    // Get initial font size
    const initialSize = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--font-size-base').trim(),
    );

    // Click Large font size
    await page.click('button:has-text("Large")');

    // Font size CSS variable should change
    const newSize = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--font-size-base').trim(),
    );

    // The sizes should differ (exact values depend on implementation)
    expect(newSize).not.toBe(initialSize);
  });
});
