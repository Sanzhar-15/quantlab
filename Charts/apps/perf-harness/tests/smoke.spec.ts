import { test, expect } from '@playwright/test';

test('renders a canvas', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('canvas')).toHaveCount(4);
});
