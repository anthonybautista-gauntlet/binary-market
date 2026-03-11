import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { http } from 'wagmi';
import { baseSepolia } from 'wagmi/chains';

// In E2E test mode (detected via the dummy WC project ID set in playwright.config.ts),
// disable wagmi's multicall3 batching so each useReadContracts call produces individual
// eth_call requests. This lets the Playwright route mock handle them without needing to
// implement multicall3 ABI decoding/encoding.
const isTestMode = process.env.NEXT_PUBLIC_WC_PROJECT_ID === 'test-project-id';
const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL;

export const config = getDefaultConfig({
  appName: 'Meridian Market',
  projectId: process.env.NEXT_PUBLIC_WC_PROJECT_ID || 'YOUR_PROJECT_ID',
  chains: [baseSepolia],
  ssr: true,
  ...(rpcUrl
    ? {
        transports: {
          [baseSepolia.id]: http(rpcUrl),
        },
      }
    : {}),
  ...(isTestMode && { batch: { multicall: false } }),
});
