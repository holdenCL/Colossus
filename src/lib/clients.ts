/**
 * clients.ts — Multi-chain public clients for read-only RPC calls.
 *
 * These are standalone viem clients (no wallet connection needed).
 * Used by priceFeed.ts for Chainlink reads and any future module
 * that needs to query across Sepolia, Base Sepolia, or Amoy.
 *
 * colossus.ts continues using getPublicClient() from wallet.ts
 * for wallet-connected operations (write txs).
 */

import { createPublicClient, http } from "viem";
import { sepolia, baseSepolia, polygonAmoy } from "viem/chains";

// --- Public Clients (read-only, no wallet needed) ---

export const sepoliaClient = createPublicClient({
  chain: sepolia,
  transport: http(),
});

export const baseSepoliaClient = createPublicClient({
  chain: baseSepolia,
  transport: http(),
});

export const amoyClient = createPublicClient({
  chain: polygonAmoy,
  transport: http(),
});

// --- Lookup by chain ID ---

export function getClientByChainId(chainId: number) {
  switch (chainId) {
    case 11155111: return sepoliaClient;
    case 84532:    return baseSepoliaClient;
    case 80002:    return amoyClient;
    default: throw new Error(`Unsupported chain ID: ${chainId}`);
  }
}

/** All supported chain IDs */
export const SUPPORTED_CHAINS = [11155111, 84532, 80002] as const;
export type SupportedChainId = (typeof SUPPORTED_CHAINS)[number];