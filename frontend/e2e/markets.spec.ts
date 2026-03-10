import { test, expect } from '@playwright/test';
import { mockPythHermes } from './helpers/mockPyth';
import { mockBlockchainRpc } from './helpers/mockRpc';

test.describe('Markets page filters', () => {
  test.beforeEach(async ({ page }) => {
    await mockPythHermes(page);
    await mockBlockchainRpc(page);
  });

  test('filters by ticker', async ({ page }) => {
    await page.goto('/markets');
    await expect(page.getByText(/aapl above/i)).toBeVisible({ timeout: 8000 });
    await expect(page.getByText(/msft above/i)).toBeVisible({ timeout: 8000 });

    await page.getByRole('button', { name: /^AAPL$/ }).click();

    await expect(page.getByText(/aapl above/i)).toBeVisible();
    await expect(page.getByText(/msft above/i)).not.toBeVisible();
  });

  test('filters by settled status', async ({ page }) => {
    await page.goto('/markets');

    await expect(page.getByText(/aapl above/i)).toBeVisible({ timeout: 8000 });
    await expect(page.getByText(/msft above/i)).toBeVisible({ timeout: 8000 });

    await page.getByRole('button', { name: /^Settled$/ }).click();

    await expect(page.getByText(/msft above/i)).toBeVisible();
    await expect(page.getByText(/aapl above/i)).not.toBeVisible();
  });
});
