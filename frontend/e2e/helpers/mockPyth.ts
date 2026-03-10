import { Page } from '@playwright/test';
import { buildHermesResponse, MOCK_PRICES } from '../fixtures';

/**
 * Intercept all Pyth Hermes API requests and return fixture price data.
 *
 * Matches both the latest-price endpoint and the historical timestamp endpoint
 * used by the settleMarkets job. The `ids[]` query params are parsed and used
 * to return the correct subset of mock prices.
 */
export async function mockPythHermes(page: Page) {
  await page.route('**/hermes.pyth.network/**', async route => {
    const url = new URL(route.request().url());

    // Extract requested feed IDs from query string: ?ids[]=<id>&ids[]=<id>
    const feedIds = url.searchParams.getAll('ids[]').map(id =>
      // Strip leading 0x if present
      id.startsWith('0x') ? id.slice(2) : id,
    );

    const body = buildHermesResponse(
      feedIds.length > 0 ? feedIds : Object.keys(MOCK_PRICES),
    );

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
}
