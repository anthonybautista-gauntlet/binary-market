import { Page, expect } from '@playwright/test';

/**
 * Performs the real wallet connection flow via RainbowKit's UI.
 *
 * Prerequisites (must be done BEFORE calling this):
 *   - injectMockWallet(page)   — sets window.ethereum
 *   - page.goto(someUrl)       — page must be loaded
 *
 * Flow:
 *   1. Click "Connect Wallet" in the Navbar
 *   2. RainbowKit modal opens
 *   3. Click a non-extension injected wallet option
 *   4. The mock provider returns MOCK_ADDRESS for eth_requestAccounts
 *   5. Wait for the "Connect Wallet" button to disappear (replaced by address chip)
 *
 * This is the correct way to test wallet connection: it exercises the same path
 * a real user takes, verifying the Connect Wallet button, RainbowKit modal, and
 * the wagmi connection state machine all work end-to-end.
 */
export async function connectWallet(page: Page) {
  // If already connected, do nothing.
  const connectBtn = page.getByRole('button', { name: /connect wallet/i }).first();
  const connectVisibleInitially = await connectBtn.isVisible().catch(() => false);
  if (!connectVisibleInitially) return;

  // Click can race with hydration/re-renders in RainbowKit; retry by re-querying.
  let modalOpened = false;
  for (let i = 0; i < 4; i++) {
    const btn = page.getByRole('button', { name: /connect wallet/i }).first();
    if (!(await btn.isVisible().catch(() => false))) {
      // May already be connected due to fast reconnect.
      return;
    }
    await btn.click({ trial: true }).catch(() => {});
    await btn.click({ force: true });
    const modal = page.getByRole('dialog').first();
    if (await modal.isVisible().catch(() => false)) {
      modalOpened = true;
      break;
    }
    await page.waitForTimeout(150);
  }

  const modal = page.getByRole('dialog').first();
  if (!modalOpened) {
    await modal.waitFor({ state: 'visible', timeout: 7000 });
  }

  // In E2E we must avoid extension-specific flows (MetaMask/WalletConnect).
  // Prefer generic injected entries exposed by RainbowKit in this order.
  const candidates = [
    // deterministic first choice for our mock provider
    modal.locator('button[data-testid^="rk-wallet-option-io.playwright.mockwallet"]'),
    modal.getByRole('button', { name: /mock wallet/i }),
    modal.getByRole('button', { name: /browser wallet/i }),
    modal.getByRole('button', { name: /^injected$/i }),
    modal.getByRole('button', { name: /^wallet$/i }),
    // Fallback: only click MetaMask if it is enabled
    modal.locator('button:not([disabled]):has-text("MetaMask")'),
  ];

  let clicked = false;
  for (let attempt = 0; attempt < 4 && !clicked; attempt++) {
    for (const candidate of candidates) {
      const btn = candidate.first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click({ force: true }).catch(() => {});
        clicked = true;
        break;
      }
    }
    if (!clicked) await page.waitForTimeout(200);
  }

  if (!clicked) {
    throw new Error('No enabled injected wallet option found in RainbowKit modal');
  }

  // After the user approves, wagmi resolves eth_requestAccounts, sets connection
  // state, and RainbowKit swaps the "Connect Wallet" button for the address chip.
  // Waiting for the button to vanish confirms the connection completed.
  await expect(
    page.getByRole('button', { name: /connect wallet/i }).first(),
  ).not.toBeVisible({ timeout: 12000 });
}
