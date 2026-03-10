import { test, expect } from '@playwright/test';
import { mockPythHermes } from './helpers/mockPyth';
import { mockBlockchainRpc } from './helpers/mockRpc';
import { injectMockWallet } from './helpers/mockWallet';
import { connectWallet } from './helpers/connectWallet';

test.describe('Wallet connection flow', () => {
  test('opens the wallet modal from the landing page', async ({ page }) => {
    await mockPythHermes(page);
    await mockBlockchainRpc(page);

    await page.goto('/');
    await page.getByRole('button', { name: /connect wallet/i }).first().click();

    await expect(page.getByRole('dialog').first()).toBeVisible({ timeout: 5000 });
  });

  test('connects through the injected wallet flow', async ({ page }) => {
    await injectMockWallet(page);
    await mockPythHermes(page);
    await mockBlockchainRpc(page);

    await page.goto('/');
    await connectWallet(page);

    await expect(
      page.locator('[data-testid^="rk-account-button"]').first(),
    ).toBeVisible({ timeout: 8000 });
  });
});
