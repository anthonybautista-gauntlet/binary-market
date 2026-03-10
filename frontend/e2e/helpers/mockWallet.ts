import { Page } from '@playwright/test';
import { MOCK_ADDRESS, CHAIN_ID } from '../fixtures';

/**
 * Inject a minimal EIP-1193 provider into the page before load.
 *
 * This injects a deterministic generic EIP-1193 provider (not a browser extension)
 * with MOCK_ADDRESS on Base Sepolia, so RainbowKit can connect via the injected
 * wallet path during Playwright tests.
 *
 * Call this *before* page.goto() for it to take effect.
 *
 * IMPORTANT: This only works for pages that use client-side wallet detection
 * (i.e., components marked 'use client'). SSR components won't see window.ethereum.
 *
 * The mock also intercepts eth_sendTransaction and eth_signTypedData to
 * return a fixed transaction hash, allowing write flows to be tested without
 * broadcasting to any chain.
 */
export async function injectMockWallet(page: Page, address = MOCK_ADDRESS) {
  const chainIdHex = '0x' + parseInt(CHAIN_ID, 10).toString(16);

  await page.addInitScript(
    ({ addr, chainHex }) => {
      const listeners: Record<string, Set<(...args: any[]) => void>> = {};

      const emit = (event: string, ...args: any[]) => {
        listeners[event]?.forEach(fn => fn(...args));
      };

      const provider = {
        // Keep this as a generic injected wallet in tests. If this is true,
        // RainbowKit prefers the MetaMask extension connector, which is not
        // available in Playwright and causes "Opening MetaMask..." hangs.
        isMetaMask: false,
        selectedAddress: addr,
        chainId: chainHex,
        networkVersion: parseInt(chainHex, 16).toString(),

        isConnected: () => true,

        request: async ({
          method,
          params,
        }: {
          method: string;
          params?: unknown[];
        }): Promise<unknown> => {
          switch (method) {
            case 'eth_requestAccounts':
            case 'eth_accounts':
              return [addr];

            case 'eth_chainId':
              return chainHex;

            case 'net_version':
              return parseInt(chainHex, 16).toString();

            case 'wallet_switchEthereumChain':
            case 'wallet_addEthereumChain':
              return null;

            case 'wallet_getPermissions':
              return [{ parentCapability: 'eth_accounts' }];

            case 'wallet_requestPermissions':
              return [{ parentCapability: 'eth_accounts' }];

            case 'eth_sendTransaction':
              // Return a fake tx hash — no actual broadcast
              return '0x' + 'a'.repeat(64);

            case 'eth_signTypedData_v4':
            case 'personal_sign':
              // Return a fake signature
              return '0x' + 'b'.repeat(130);

            case 'eth_subscribe':
              return '0x1'; // subscription id

            case 'eth_unsubscribe':
              return true;

            default:
              // Let the underlying RPC mock handle everything else
              throw Object.assign(new Error(`Method not supported by mock wallet: ${method}`), {
                code: 4200,
              });
          }
        },

        on: (event: string, listener: (...args: any[]) => void) => {
          if (!listeners[event]) listeners[event] = new Set();
          listeners[event].add(listener);
          return provider;
        },

        removeListener: (event: string, listener: (...args: any[]) => void) => {
          listeners[event]?.delete(listener);
          return provider;
        },

        // Some wagmi versions call this
        enable: async () => [addr],

        // Simulate account available immediately for connector capability checks
        _metamask: { isUnlocked: () => Promise.resolve(true) },
      };

      // Expose as window.ethereum before any scripts run
      Object.defineProperty(window, 'ethereum', {
        value: provider,
        writable: true,
        configurable: true,
      });

      // EIP-6963 provider discovery support (used by modern wallet UIs).
      // RainbowKit/wagmi may rely on this flow instead of reading window.ethereum.
      const providerInfo = {
        uuid: 'playwright-mock-wallet',
        name: 'Browser Wallet',
        icon: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2224%22 height=%2224%22 viewBox=%220 0 24 24%22%3E%3Crect width=%2224%22 height=%2224%22 rx=%224%22 fill=%22%231d4ed8%22/%3E%3Cpath d=%22M6 7h12v10H6z%22 fill=%22%23fff%22/%3E%3C/svg%3E',
        rdns: 'io.playwright.mockwallet',
      };

      const announceProvider = () => {
        window.dispatchEvent(
          new CustomEvent('eip6963:announceProvider', {
            detail: { info: providerInfo, provider },
          }),
        );
      };

      window.addEventListener('eip6963:requestProvider', announceProvider);
      announceProvider();

      // Also expose as window.web3 for legacy compat
      (window as any).web3 = { currentProvider: provider };

    },
    { addr: address, chainHex: chainIdHex },
  );
}
