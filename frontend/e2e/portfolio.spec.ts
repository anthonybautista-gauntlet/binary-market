import { test, expect } from '@playwright/test';
import { mockPythHermes } from './helpers/mockPyth';
import { mockBlockchainRpc } from './helpers/mockRpc';
import { injectMockWallet } from './helpers/mockWallet';
import { connectWallet } from './helpers/connectWallet';
import { ENCODED_YES_BALANCE, ENCODED_ZERO, MOCK_ADDRESS, MOCK_MARKETS } from './fixtures';
import { buildOrderFilledLog, EVENT_TOPIC0 } from './helpers/eventLogs';

test.describe('Portfolio features', () => {
  test.beforeEach(async ({ page }) => {
    await injectMockWallet(page);
    await mockPythHermes(page);
    await mockBlockchainRpc(page);
    await page.goto('/portfolio');
    await connectWallet(page);
  });

  test('shows USDC balance', async ({ page }) => {
    await expect(page.getByText(/usdc balance/i)).toBeVisible({ timeout: 8000 });
  });

  test('shows portfolio controls for positions and trade-history sync', async ({ page }) => {
    await expect(page.getByText('Active Positions', { exact: true }).first()).toBeVisible({ timeout: 8000 });
    await expect(
      page.getByRole('button', { name: /sync history/i }),
    ).toBeVisible({ timeout: 8000 });
  });
});

test.describe('Portfolio PnL and settlement', () => {
  test('shows accurate PnL from on-chain trade history', async ({ page }) => {
    await injectMockWallet(page);
    await mockPythHermes(page);
    await mockBlockchainRpc(page, {
      yesBalance: ENCODED_YES_BALANCE,
      noBalance: ENCODED_ZERO,
      rpcLogResponses: {
        [EVENT_TOPIC0.orderFilled]: [
          buildOrderFilledLog({
            marketId: MOCK_MARKETS[0].marketId,
            orderId: 1n,
            maker: '0x1000000000000000000000000000000000000000',
            taker: MOCK_ADDRESS,
            side: 0,
            priceCents: 40,
            qty: 3n,
          }),
        ],
      },
    });

    await page.goto('/portfolio');
    await connectWallet(page);

    const aaplRow = page.getByRole('row', { name: /AAPL/i }).first();
    await expect(aaplRow).toContainText('40¢');
    await expect(aaplRow).toContainText('$3.00');
    await expect(aaplRow).toContainText('+$1.80');
  });

  test('shows settled outcomes and lets winners redeem', async ({ page }) => {
    await injectMockWallet(page);
    await mockPythHermes(page);
    await mockBlockchainRpc(page, {
      yesBalance: ENCODED_ZERO,
      noBalance: ENCODED_YES_BALANCE,
    });

    await page.goto('/portfolio');
    await connectWallet(page);

    const msftRow = page.getByRole('row', { name: /MSFT/i }).first();
    await expect(msftRow).toContainText(/Settled/i);
    await expect(msftRow).toContainText(/NO wins/i);

    const redeemButton = msftRow.getByRole('button', { name: /redeem/i });
    await expect(redeemButton).toBeEnabled();
    await redeemButton.click();

    await expect(
      msftRow.getByRole('button', { name: /redeemed/i }),
    ).toBeVisible({ timeout: 8000 });
  });
});
