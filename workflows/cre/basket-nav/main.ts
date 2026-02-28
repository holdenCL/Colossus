/**
 * basket-nav — CRE Workflow for on-DON basket NAV calculation.
 *
 * This is the Convergence showcase piece. It replicates
 * the same NAV logic that priceFeed.ts runs in the browser, but
 * executed across Chainlink's Decentralized Oracle Network (DON).
 *
 * Flow:
 *   1. HTTP trigger receives { basketId }
 *   2. Read basket components from BasketFactory.getComponents()
 *   3. For each component token:
 *      a. Read token decimals via ERC-20 decimals()
 *      b. Look up the Chainlink price feed address
 *      c. Read latestRoundData() + feed decimals()
 *      d. Handle derived pairs (e.g. Amoy POL/USD = POL/LINK × LINK/USD)
 *   4. Sum USD values → basket NAV
 *   5. Calculate 0.1% fee in LINK
 *   6. Return JSON result
 *
 * Architecture note:
 *   Frontend priceFeed.ts provides snappy UI pricing.
 *   This CRE workflow provides the verified/official NAV on-DON.
 *   Same feeds, same math, different execution environments.
 */

import {
  EVMClient,
  getNetwork,
  encodeCallMsg,
  bytesToHex,
  LAST_FINALIZED_BLOCK_NUMBER,
  decodeJson,
  handler,
  Runner,
  HTTPCapability,
  type Runtime,
  type HTTPPayload,
} from "@chainlink/cre-sdk"
import {
  encodeFunctionData,
  decodeFunctionResult,
  parseAbi,
  zeroAddress,
  type Address,
} from "viem"
import { z } from "zod"

// ─── Config ──────────────────────────────────────────────────────
// Validated at startup via Zod. Values come from config.staging.json.

const configSchema = z.object({
  chainSelectorName: z.string(),  // e.g. "ethereum-testnet-sepolia"
})

type Config = z.infer<typeof configSchema>

// ─── Request Type ────────────────────────────────────────────────
// The JSON body sent to the HTTP trigger.

type NavRequest = {
  basketId: number
}

// ─── ABIs ────────────────────────────────────────────────────────
// Minimal ABIs — only the functions we actually call.
// parseAbi gives us type-safe encoding/decoding via viem.

const basketFactoryAbi = parseAbi([
  "function getComponents(uint256 basketId) view returns ((address token, uint8 standard, uint256 tokenId, uint256 amount)[])",
])

const erc20Abi = parseAbi([
  "function decimals() view returns (uint8)",
])

const aggregatorV3Abi = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
])

// ─── Contract Addresses ──────────────────────────────────────────
// New deployment (Feb 18 2026) with fee recipient 0xA5adDe...

const BASKET_FACTORIES: Record<string, Address> = {
  "ethereum-testnet-sepolia": "0x885eC430c471a74078C7461Fd9F44D32cB019d3D",
  "ethereum-testnet-sepolia-base-1":     "0xcf26e052aa417cEb1641e8B7eA806F388Cc9a022",
}

// ─── Price Feed Registry ─────────────────────────────────────────
// Mirrors the FEED_REGISTRY from frontend priceFeed.ts.
// Maps: chainSelectorName → tokenAddress → feed config.
//
// "direct" feeds: one feed gives token/USD directly.
// "derived" feeds: multiply two feeds (e.g. POL/LINK × LINK/USD).

type DirectFeed = { type: "direct"; feed: Address }
type DerivedFeed = { type: "derived"; feedA: Address; feedB: Address }
type FeedConfig = DirectFeed | DerivedFeed

const FEED_REGISTRY: Record<string, Record<string, FeedConfig>> = {
  "ethereum-testnet-sepolia": {
    // LINK → LINK/USD
    "0x779877a7b0d9e8603169ddbd7836e478b4624789": {
      type: "direct",
      feed: "0xc59E3633BAAC79493d908e63626716e204A45EdF",
    },
    // WETH → ETH/USD
    "0xfff9976782d46cc05630d1f6ebab18b2324d6b14": {
      type: "direct",
      feed: "0x694AA1769357215DE4FAC081bf1f309aDC325306",
    },
  },
  "ethereum-testnet-sepolia-base-1": {
    // LINK → LINK/USD
    "0xe4ab69c077896252fafbd49efd26b5d171a32410": {
      type: "direct",
      feed: "0xb113F5A928BCfF189C998ab20d753a47F9dE5A61",
    },
  },
  "polygon-amoy-testnet": {
    // LINK → LINK/USD
    "0x0fd9e8d3af1aaee056eb9e802c3a762a667b1904": {
      type: "direct",
      feed: "0xc2e2848e28B9fE430Ab44F55a8437a33802a219C",
    },
    // POL → derived: POL/LINK × LINK/USD
    "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee": {
      type: "derived",
      feedA: "0x408D97c89c141e60872C0835e18Dd1E670CD8781",  // POL/LINK
      feedB: "0xc2e2848e28B9fE430Ab44F55a8437a33802a219C",  // LINK/USD
    },
  },
}

// LINK token address per chain (for fee conversion)
const LINK_ADDRESS: Record<string, string> = {
  "ethereum-testnet-sepolia": "0x779877a7b0d9e8603169ddbd7836e478b4624789",
  "ethereum-testnet-sepolia-base-1":     "0xe4ab69c077896252fafbd49efd26b5d171a32410",
  "polygon-amoy-testnet":     "0x0fd9e8d3af1aaee056eb9e802c3a762a667b1904",
}

// ─── Hardcoded Decimals (read optimization) ──────────────────────
// Chainlink USD feeds always use 8 decimals. ERC-20 token decimals
// are immutable. Hardcoding these saves 2N+2 EVM reads per execution,
// keeping us well under the 10-read quota for deployed workflows.
//
// CRE quota: max 10 EVM reads per workflow execution.
// Before optimization: 3N+3 reads (N=3 → 12, over limit)
// After optimization:  N+1 reads  (N=3 → 4, safe up to 9 components)

const FEED_DECIMALS = 8  // All Chainlink USD and cross-pair feeds use 8

// Known token decimals (lowercase address → decimals)
const KNOWN_TOKEN_DECIMALS: Record<string, number> = {
  "0x779877a7b0d9e8603169ddbd7836e478b4624789": 18,  // Sepolia LINK
  "0xfff9976782d46cc05630d1f6ebab18b2324d6b14": 18,  // Sepolia WETH
  "0xe4ab69c077896252fafbd49efd26b5d171a32410": 18,  // Base Sepolia LINK
  "0x0fd9e8d3af1aaee056eb9e802c3a762a667b1904": 18,  // Amoy LINK
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee": 18,  // Native token placeholder
}

// ─── Helper: Read a single contract call ─────────────────────────
// Wraps the encode → call → decode pattern into one function.
// This keeps the main logic readable.

function callView(
  evmClient: EVMClient,
  runtime: Runtime<Config>,
  to: Address,
  abi: readonly any[],
  functionName: string,
  args: any[] = []
): any {
  const data = encodeFunctionData({ abi, functionName, args })

  const result = evmClient
    .callContract(runtime, {
      call: encodeCallMsg({
        from: zeroAddress,
        to,
        data,
      }),
      blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
    })
    .result()

  // Empty response means the call reverted or returned nothing
  if (result.data.length === 0) {
    throw new Error(`Empty response from ${functionName} on ${to}`)
  }

  return decodeFunctionResult({
    abi,
    functionName,
    data: bytesToHex(result.data),
  })
}

// ─── Helper: Read a Chainlink price feed ─────────────────────────
// Returns { answer: bigint, decimals: number }
// Uses hardcoded FEED_DECIMALS (always 8 for Chainlink feeds) to save reads.

function readFeed(
  evmClient: EVMClient,
  runtime: Runtime<Config>,
  feedAddress: Address
): { answer: bigint; decimals: number } {
  // latestRoundData returns [roundId, answer, startedAt, updatedAt, answeredInRound]
  // This is the ONLY EVM read per feed (decimals is hardcoded)
  const roundData = callView(
    evmClient, runtime, feedAddress,
    aggregatorV3Abi, "latestRoundData"
  ) as readonly [bigint, bigint, bigint, bigint, bigint]

  const answer = roundData[1]
  if (answer <= 0n) {
    throw new Error(`Stale or invalid feed: ${feedAddress}`)
  }

  return { answer, decimals: FEED_DECIMALS }
}

// ─── Helper: Get USD price for a token ───────────────────────────
// Handles both direct feeds and derived pairs.
// Returns a float (e.g. 15.23 = $15.23).

function getTokenUsdPrice(
  evmClient: EVMClient,
  runtime: Runtime<Config>,
  tokenAddress: string,
  chainName: string
): number {
  const chainFeeds = FEED_REGISTRY[chainName]
  if (!chainFeeds) {
    runtime.log(`No feeds configured for chain ${chainName}`)
    return 0
  }

  // Case-insensitive lookup (addresses may differ in casing)
  const key = Object.keys(chainFeeds).find(
    (k) => k.toLowerCase() === tokenAddress.toLowerCase()
  )
  if (!key) {
    runtime.log(`No price feed for token ${tokenAddress} on ${chainName}`)
    return 0
  }

  const config = chainFeeds[key]

  if (config.type === "direct") {
    const { answer, decimals } = readFeed(evmClient, runtime, config.feed)
    return Number(answer) / 10 ** decimals
  }

  // Derived pair: price = answerA × answerB / 10^decimalsA
  // Example: POL/USD = POL/LINK × LINK/USD
  const feedA = readFeed(evmClient, runtime, config.feedA)
  const feedB = readFeed(evmClient, runtime, config.feedB)

  const product = feedA.answer * feedB.answer
  const totalDecimals = feedA.decimals + feedB.decimals
  return Number(product) / 10 ** totalDecimals
}

// ─── Main Callback ───────────────────────────────────────────────

const onHttpTrigger = (runtime: Runtime<Config>, payload: HTTPPayload): string => {
  const request = decodeJson(payload.input) as NavRequest
  const chainName = (request as any).chainSelectorName || runtime.config.chainSelectorName

  runtime.log(`basket-nav: basketId=${request.basketId}, chain=${chainName}`)

  // Validate input
  if (!request.basketId || request.basketId < 1) {
    return JSON.stringify({ error: "Invalid basketId" })
  }

  // ── Get network + EVM client ──
  const network = getNetwork({
    chainFamily: "evm",
    chainSelectorName: chainName,
    isTestnet: true,
  })

  if (!network) {
    return JSON.stringify({ error: `Network not found: ${chainName}` })
  }

  const evmClient = new EVMClient(network.chainSelector.selector)

  // ── Step 1: Read basket components ──
  const BASKET_FACTORY = BASKET_FACTORIES[chainName]
    if (!BASKET_FACTORY) {
    return JSON.stringify({ error: `No factory configured for chain: ${chainName}` })
  }
  runtime.log("Reading basket components...")

  let components: readonly { token: Address; standard: number; tokenId: bigint; amount: bigint }[]
  try {
    components = callView(
      evmClient, runtime, BASKET_FACTORY,
      basketFactoryAbi, "getComponents",
      [BigInt(request.basketId)]
    ) as readonly { token: Address; standard: number; tokenId: bigint; amount: bigint }[]
  } catch (e: any) {
    return JSON.stringify({ error: `Failed to read basket: ${e.message}` })
  }

  runtime.log(`Basket has ${components.length} component(s)`)

  // ── Step 2: Price each component ──
  // Track prices we've already fetched to avoid duplicate reads.
  // Key optimization: if LINK is a basket component, reuse its price for fee calc.
  const priceCache: Record<string, number> = {}

  const breakdown: {
    token: string
    decimals: number
    amount: string
    usdPrice: number
    usdValue: number
  }[] = []

  let totalNavUsd = 0

  for (const comp of components) {
    // Use hardcoded decimals if known, otherwise fall back to on-chain read
    const addrLower = comp.token.toLowerCase()
    let tokenDecimals = KNOWN_TOKEN_DECIMALS[addrLower]
    if (tokenDecimals === undefined) {
      runtime.log(`  Unknown token ${comp.token}, reading decimals on-chain`)
      tokenDecimals = callView(
        evmClient, runtime, comp.token,
        erc20Abi, "decimals"
      ) as number
    }

    // Get USD price (may reuse cached price if same token appears twice)
    let usdPrice = priceCache[addrLower]
    if (usdPrice === undefined) {
      usdPrice = getTokenUsdPrice(evmClient, runtime, comp.token, chainName)
      priceCache[addrLower] = usdPrice
    }

    // Human-readable amount = raw amount / 10^decimals
    const humanAmount = Number(comp.amount) / 10 ** tokenDecimals

    // USD value of this component (per 1 basket unit)
    const usdValue = humanAmount * usdPrice

    totalNavUsd += usdValue

    breakdown.push({
      token: comp.token,
      decimals: tokenDecimals,
      amount: comp.amount.toString(),
      usdPrice,
      usdValue,
    })

    runtime.log(
      `  ${comp.token}: ${humanAmount} tokens @ $${usdPrice.toFixed(4)} = $${usdValue.toFixed(4)}`
    )
  }

  // ── Step 3: Calculate fee in LINK ──
  const feeUsd = totalNavUsd * 0.001  // 0.1%

  const linkAddr = LINK_ADDRESS[chainName]
  let feeInLink = 0
  let linkPrice = 0

  if (linkAddr) {
    // Reuse LINK price if we already read it as a basket component
    const cachedLinkPrice = priceCache[linkAddr.toLowerCase()]
    if (cachedLinkPrice !== undefined && cachedLinkPrice > 0) {
      linkPrice = cachedLinkPrice
    } else {
      linkPrice = getTokenUsdPrice(evmClient, runtime, linkAddr, chainName)
    }
    if (linkPrice > 0) {
      feeInLink = feeUsd / linkPrice
    }
  }

  runtime.log(`NAV: $${totalNavUsd.toFixed(4)} | Fee: ${feeInLink.toFixed(6)} LINK ($${feeUsd.toFixed(4)})`)

  // ── Step 4: Return result ──
  const response = JSON.stringify({
    basketId: request.basketId,
    chain: chainName,
    navUsd: totalNavUsd,
    feeUsd,
    feeInLink,
    linkPriceUsd: linkPrice,
    components: breakdown,
  })

  runtime.log(`Result: ${response}`)
  return response
}

// ─── Workflow Registration ───────────────────────────────────────

const initWorkflow = (config: Config) => {
  const http = new HTTPCapability()

  return [
    handler(http.trigger({}), onHttpTrigger),
  ]
}

// ─── Entry Point ─────────────────────────────────────────────────

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema })
  await runner.run(initWorkflow)
}