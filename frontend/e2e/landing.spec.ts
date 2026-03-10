import { test, expect } from '@playwright/test';
import { mockPythHermes } from './helpers/mockPyth';
import { mockBlockchainRpc } from './helpers/mockRpc';

test.describe('Landing page branding', () => {
  test.beforeEach(async ({ page }) => {
    await mockPythHermes(page);
    await mockBlockchainRpc(page);
  });

  test('shows live prices from the oracle feed', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText(/\$215\.00/)).toBeVisible({ timeout: 8000 });
  });

  test('shows company logo images', async ({ page }) => {
    await page.goto('/');
    const logos = page.locator('img[src*="/images/logos/"]');
    await expect(logos.first()).toBeVisible({ timeout: 5000 });
  });
});
