/**
 * priceFeed.ts — Read token USD prices from Chainlink Data Feeds.
 *
 * How Chainlink feeds work:
 * - Each feed is a contract implementing AggregatorV3Interface
 * - latestRoundData() returns the current price as a scaled integer
 * - decimals() tells you the scaling factor (usually 8 for USD pairs)
 * - Example: answer = 1_500_000_000 with 8 decimals = $15.00
 *
 * Special case — Amoy POL/USD:
 * No direct POL/USD feed exists on Amoy. We derive it:
 *   POL/USD = POL/LINK × LINK/USD
 * Read both feeds, multiply answers, adjust for decimals.
 */

import { type Address } from "viem";
import { getClientByChainId, type SupportedChainId } from "./clients";

// --- Minimal ABI (only what we need) ---

const AggregatorV3ABI = [
  {
    name: "latestRoundData",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;

// --- Feed Registry ---
// Maps: chainId → tokenAddress → feed config

type DirectFeed = {
  type: "direct";
  feed: Address;   // e.g. LINK/USD
};

type DerivedFeed = {
  type: "derived";
  feedA: Address;   // e.g. POL/LINK
  feedB: Address;   // e.g. LINK/USD
  // USD price = answerA × answerB (adjusted for decimals)
};

type FeedConfig = DirectFeed | DerivedFeed;

const FEED_REGISTRY: Record<number, Record<string, FeedConfig>> = {
  // --- Sepolia ---
  11155111: {
    // LINK
    "0x779877A7B0D9E8603169DdbD7836e478b4624789": {
      type: "direct",
      feed: "0xc59E3633BAAC79493d908e63626716e204A45EdF",
    },
    // WETH
    "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14": {
      type: "direct",
      feed: "0x694AA1769357215DE4FAC081bf1f309aDC325306",
    },
    // ETH (wrapped/native placeholder — use for gas cost display later)
    "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE": {
      type: "direct",
      feed: "0x694AA1769357215DE4FAC081bf1f309aDC325306",
    },
  },

  // --- Base Sepolia ---
  84532: {
    // LINK
    "0xE4aB69C077896252FAFBD49EFD26B5D171A32410": {
      type: "direct",
      feed: "0xb113F5A928BCfF189C998ab20d753a47F9dE5A61",
    },
    // ETH
    "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE": {
      type: "direct",
      feed: "0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1",
    },
  },

  // --- Amoy ---
  80002: {
    // LINK
    "0x0Fd9e8d3aF1aaee056EB9e802c3A762a667b1904": {
      type: "direct",
      feed: "0xc2e2848e28B9fE430Ab44F55a8437a33802a219C",
    },
    // POL (derived: POL/LINK × LINK/USD)
    "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE": {
      type: "derived",
      feedA: "0x408D97c89c141e60872C0835e18Dd1E670CD8781",  // POL/LINK
      feedB: "0xc2e2848e28B9fE430Ab44F55a8437a33802a219C",  // LINK/USD
    },
  },
};

// --- Core Functions ---

/** Read a single feed's latest answer + decimals */
async function readFeed(
  chainId: SupportedChainId,
  feedAddress: Address
): Promise<{ answer: bigint; decimals: number }> {
  const client = getClientByChainId(chainId);

  const [roundData, feedDecimals] = await Promise.all([
    client.readContract({
      address: feedAddress,
      abi: AggregatorV3ABI,
      functionName: "latestRoundData",
    }),
    client.readContract({
      address: feedAddress,
      abi: AggregatorV3ABI,
      functionName: "decimals",
    }),
  ]);

  // roundData is [roundId, answer, startedAt, updatedAt, answeredInRound]
  const answer = roundData[1];
  if (answer <= 0n) throw new Error(`Stale or invalid feed: ${feedAddress}`);

  return { answer, decimals: feedDecimals };
}

/**
 * Get the USD price of a token on a given chain.
 *
 * Returns price as a float (e.g. 15.23 means $15.23).
 * Handles both direct feeds and derived pairs.
 *
 * @param tokenAddress - The ERC-20 token contract address
 * @param chainId - The chain to read from (11155111, 84532, 80002)
 */
export async function getTokenUsdPrice(
  tokenAddress: string,
  chainId: SupportedChainId
): Promise<number> {
  const chainFeeds = FEED_REGISTRY[chainId];
  if (!chainFeeds) throw new Error(`No feeds configured for chain ${chainId}`);

  // Normalize to checksummed format isn't needed — lowercase compare
  const key = Object.keys(chainFeeds).find(
    (k) => k.toLowerCase() === tokenAddress.toLowerCase()
  );
  if (!key) throw new Error(`No price feed for token ${tokenAddress} on chain ${chainId}`);

  const config = chainFeeds[key];

  if (config.type === "direct") {
    const { answer, decimals } = await readFeed(chainId, config.feed);
    return Number(answer) / 10 ** decimals;
  }

  // Derived pair: price = answerA × answerB / 10^decimalsA
  // Example: POL/USD = (POL/LINK) × (LINK/USD)
  // If both are 8 decimals: (answerA * answerB) / 10^8 gives a value in 8-decimal USD
  const [feedA, feedB] = await Promise.all([
    readFeed(chainId, config.feedA),
    readFeed(chainId, config.feedB),
  ]);

  // answerA is in feedA.decimals, answerB is in feedB.decimals
  // Product has (feedA.decimals + feedB.decimals) total decimals
  // We want a float USD value
  const product = feedA.answer * feedB.answer;
  const totalDecimals = feedA.decimals + feedB.decimals;
  return Number(product) / 10 ** totalDecimals;
}

/**
 * Get the LINK/USD price on a given chain.
 * Convenience function for fee conversion (USD → LINK).
 */
export async function getLinkUsdPrice(chainId: SupportedChainId): Promise<number> {
  const linkAddresses: Record<number, string> = {
    11155111: "0x779877A7B0D9E8603169DdbD7836e478b4624789",
    84532: "0xE4aB69C077896252FAFBD49EFD26B5D171A32410",
    80002: "0x0Fd9e8d3aF1aaee056EB9e802c3A762a667b1904",
  };
  const addr = linkAddresses[chainId];
  if (!addr) throw new Error(`No LINK address for chain ${chainId}`);
  return getTokenUsdPrice(addr, chainId);
}

/**
 * Calculate the 0.1% fee in LINK for a basket operation.
 *
 * @param totalUsdValue - Total USD value of all component tokens
 * @param chainId - Chain to read LINK price from
 * @returns Fee amount in LINK (as a float, e.g. 0.0023)
 */
export async function calculateFeeInLink(
  totalUsdValue: number,
  chainId: SupportedChainId
): Promise<number> {
  const feeUsd = totalUsdValue * 0.001; // 0.1%
  const linkPrice = await getLinkUsdPrice(chainId);
  if (linkPrice <= 0) throw new Error("Invalid LINK price");
  return feeUsd / linkPrice;
}

/**
 * Check if a token has a price feed configured on a chain.
 */
export function hasPriceFeed(tokenAddress: string, chainId: number): boolean {
  const chainFeeds = FEED_REGISTRY[chainId];
  if (!chainFeeds) return false;
  return Object.keys(chainFeeds).some(
    (k) => k.toLowerCase() === tokenAddress.toLowerCase()
  );
}
