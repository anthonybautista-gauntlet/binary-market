import { test, expect } from '@playwright/test';
import { mockPythHermes } from './helpers/mockPyth';
import { mockBlockchainRpc } from './helpers/mockRpc';
import { injectMockWallet } from './helpers/mockWallet';
import { connectWallet } from './helpers/connectWallet';
import { ENCODED_YES_BALANCE, ENCODED_ZERO, MOCK_MARKETS } from './fixtures';

const MARKET_PATH = `/market/${MOCK_MARKETS[0].marketId}`;
test.describe('Trade panel features', () => {
  test.beforeEach(async ({ page }) => {
    await injectMockWallet(page);
    await mockPythHermes(page);
    await mockBlockchainRpc(page, {
      yesBalance: ENCODED_ZERO,
      noBalance: ENCODED_ZERO,
    });
    await page.goto(MARKET_PATH);
    await connectWallet(page);
  });

  test('shows trade actions plus USDC balance and allowance controls', async ({ page }) => {
    const tabs = [
      /^buy yes$/i,
      /^buy no$/i,
      /^sell yes$/i,
      /^sell no$/i,
      /^no limit$/i,
      /^mint$/i,
    ];

    for (const tab of tabs) {
      await expect(page.getByRole('tab', { name: tab })).toBeVisible({
        timeout: 8000,
      });
    }
    await expect(page.getByText(/usdc balance/i)).toBeVisible({ timeout: 8000 });
    await expect(
      page.getByRole('button', { name: /mint test collateral/i }),
    ).toBeVisible({ timeout: 8000 });
  });

  test('shows the live order book for both YES and NO trading perspectives', async ({ page }) => {
    await expect(page.getByText(/depth analysis/i)).toBeVisible({ timeout: 8000 });
    await expect(page.getByText(/market spread/i)).toBeVisible();
    await expect(page.getByText(/mid price/i)).toBeVisible();
    await expect(page.getByText('48¢')).toBeVisible();
    await expect(page.getByText('52¢')).toBeVisible();

    await page.getByRole('tab', { name: /^buy no$/i }).click();
    await expect(page.getByText(/depth analysis/i)).toBeVisible();
    await expect(page.getByText('48¢')).toBeVisible();
    await expect(page.getByText('52¢')).toBeVisible();
  });

  test('places a YES order and completes the signing flow', async ({ page }) => {
    await page.getByRole('button', { name: /place yes order/i }).click();
    await expect(page.getByText(/buy yes submitted successfully/i)).toBeVisible({ timeout: 8000 });
  });

  test('blocks Buy NO when user holds YES tokens', async ({ page }) => {
    await injectMockWallet(page);
    await mockPythHermes(page);
    await mockBlockchainRpc(page, {
      yesBalance: ENCODED_YES_BALANCE,
      noBalance: ENCODED_ZERO,
    });
    await page.goto(MARKET_PATH);
    await connectWallet(page);

    const buyNoTab = page.getByRole('tab', { name: /^buy no$/i });
    await buyNoTab.click();

    await expect(
      page.getByText(/position conflict/i),
    ).toBeVisible({ timeout: 8000 });
  });

  test('blocks Buy YES when user holds NO tokens', async ({ page }) => {
    await injectMockWallet(page);
    await mockPythHermes(page);
    await mockBlockchainRpc(page, {
      yesBalance: ENCODED_ZERO,
      noBalance: ENCODED_YES_BALANCE,
    });
    await page.goto(MARKET_PATH);
    await connectWallet(page);

    const buyYesTab = page.getByRole('tab', { name: /^buy yes$/i });
    await buyYesTab.click();

    await expect(
      page.getByText(/position conflict/i),
    ).toBeVisible({ timeout: 8000 });
  });

  test('accepts quantity inputs for minting and NO market buys', async ({ page }) => {
    const mintTab = page.getByRole('tab', { name: /^mint$/i });
    await mintTab.click();

    const qtyInput = page.getByRole('spinbutton').first();
    await expect(qtyInput).toBeVisible({ timeout: 5000 });
    await qtyInput.fill('5');
    await expect(qtyInput).toHaveValue('5');

    const buyNoTab = page.getByRole('tab', { name: /^buy no$/i });
    await buyNoTab.click();

    const buyNoQtyInput = page.getByRole('spinbutton').first();
    await expect(buyNoQtyInput).toBeVisible({ timeout: 5000 });
    await buyNoQtyInput.fill('3');
    await expect(buyNoQtyInput).toHaveValue('3');
  });
});
