/**
 * ccc-basket-nav — CCC-enhanced NAV calculation with confidential market cross-check.
 *
 * This extends basket-nav by adding a CoinGecko market price cross-reference
 * via ConfidentialHTTPClient. The enclave ensures which tokens are being priced
 * is never revealed to observers.
 *
 * Data sources:
 *   1. Blockchain — EVMClient reads (getComponents, price feeds) [unchanged from basket-nav]
 *   2. Market data — CoinGecko via ConfidentialHTTPClient [NEW]
 *
 * Flow:
 *   1. HTTP trigger receives { basketId, chainSelectorName? }
 *   2. Read basket components from BasketFactory.getComponents()
 *   3. For each component: read Chainlink price feed (on-chain oracle price)
 *   4. CoinGecko cross-check via ConfidentialHTTPClient (off-chain market price)
 *   5. Sum USD values → basket NAV (using oracle prices as authoritative)
 *   6. Calculate 0.1% fee in LINK
 *   7. Return JSON with both oracle and market prices per component
 *
 * What's different from basket-nav:
 *   - Adds ConfidentialHTTPClient for CoinGecko market price cross-reference
 *   - Response includes both oraclePrice and marketPrice per component
 *   - confidential: true flag in response
 */

import {
  EVMClient,
  HTTPCapability,
  ConfidentialHTTPClient,
  getNetwork,
  encodeCallMsg,
  bytesToHex,
  LAST_FINALIZED_BLOCK_NUMBER,
  decodeJson,
  handler,
  ok,
  Runner,
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

const configSchema = z.object({
  chainSelectorName: z.string(),
})

type Config = z.infer<typeof configSchema>

// ─── Types ───────────────────────────────────────────────────────

type NavRequest = {
  basketId: number
}

// ─── ABIs ────────────────────────────────────────────────────────

const basketFactoryAbi = parseAbi([
  "function getComponents(uint256 basketId) view returns ((address token, uint8 standard, uint256 tokenId, uint256 amount)[])",
  "function getBasketInfo(uint256 basketId) view returns (string name, address creator, uint256 componentCount, bool hasNFT)",
])

const erc20Abi = parseAbi([
  "function decimals() view returns (uint8)",
])

const aggregatorV3Abi = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
])

// ─── Contract Addresses ──────────────────────────────────────────

const BASKET_FACTORIES: Record<string, Address> = {
  "ethereum-testnet-sepolia": "0x885eC430c471a74078C7461Fd9F44D32cB019d3D",
  "ethereum-testnet-sepolia-base-1": "0xcf26e052aa417cEb1641e8B7eA806F388Cc9a022",
}

// ─── Price Feed Registry ─────────────────────────────────────────

type DirectFeed = { type: "direct"; feed: Address }
type DerivedFeed = { type: "derived"; feedA: Address; feedB: Address }
type FeedConfig = DirectFeed | DerivedFeed

const FEED_REGISTRY: Record<string, Record<string, FeedConfig>> = {
  "ethereum-testnet-sepolia": {
    "0x779877a7b0d9e8603169ddbd7836e478b4624789": {
      type: "direct",
      feed: "0xc59E3633BAAC79493d908e63626716e204A45EdF",
    },
    "0xfff9976782d46cc05630d1f6ebab18b2324d6b14": {
      type: "direct",
      feed: "0x694AA1769357215DE4FAC081bf1f309aDC325306",
    },
  },
  "ethereum-testnet-sepolia-base-1": {
    "0xe4ab69c077896252fafbd49efd26b5d171a32410": {
      type: "direct",
      feed: "0xb113F5A928BCfF189C998ab20d753a47F9dE5A61",
    },
  },
  "polygon-amoy-testnet": {
    "0x0fd9e8d3af1aaee056eb9e802c3a762a667b1904": {
      type: "direct",
      feed: "0xc2e2848e28B9fE430Ab44F55a8437a33802a219C",
    },
    "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee": {
      type: "derived",
      feedA: "0x408D97c89c141e60872C0835e18Dd1E670CD8781",
      feedB: "0xc2e2848e28B9fE430Ab44F55a8437a33802a219C",
    },
  },
}

const LINK_ADDRESS: Record<string, string> = {
  "ethereum-testnet-sepolia": "0x779877a7b0d9e8603169ddbd7836e478b4624789",
  "ethereum-testnet-sepolia-base-1": "0xe4ab69c077896252fafbd49efd26b5d171a32410",
  "polygon-amoy-testnet": "0x0fd9e8d3af1aaee056eb9e802c3a762a667b1904",
}

// ─── CoinGecko Mapping ──────────────────────────────────────────
// Maps testnet token addresses → CoinGecko IDs for market cross-check

const COINGECKO_MAP: Record<string, string> = {
  "0x779877a7b0d9e8603169ddbd7836e478b4624789": "chainlink",   // Sepolia LINK
  "0xfff9976782d46cc05630d1f6ebab18b2324d6b14": "weth",        // Sepolia WETH
  "0xe4ab69c077896252fafbd49efd26b5d171a32410": "chainlink",   // Base Sepolia LINK
  "0x4200000000000000000000000000000000000006": "weth",        // Base Sepolia WETH
}

// ─── Hardcoded Decimals ──────────────────────────────────────────

const FEED_DECIMALS = 8

const KNOWN_TOKEN_DECIMALS: Record<string, number> = {
  "0x779877a7b0d9e8603169ddbd7836e478b4624789": 18,
  "0xfff9976782d46cc05630d1f6ebab18b2324d6b14": 18,
  "0xe4ab69c077896252fafbd49efd26b5d171a32410": 18,
  "0x0fd9e8d3af1aaee056eb9e802c3a762a667b1904": 18,
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee": 18,
}

// ─── Helper: EVM Read ────────────────────────────────────────────

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

  if (result.data.length === 0) {
    throw new Error(`Empty response from ${functionName} on ${to}`)
  }

  return decodeFunctionResult({
    abi,
    functionName,
    data: bytesToHex(result.data),
  })
}

// ─── Helper: Read Chainlink Price Feed ───────────────────────────

function readFeed(
  evmClient: EVMClient,
  runtime: Runtime<Config>,
  feedAddress: Address
): { answer: bigint; decimals: number } {
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

// ─── Helper: Get USD Price from Chainlink Oracle ─────────────────

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

  const feedA = readFeed(evmClient, runtime, config.feedA)
  const feedB = readFeed(evmClient, runtime, config.feedB)

  const product = feedA.answer * feedB.answer
  const totalDecimals = feedA.decimals + feedB.decimals
  return Number(product) / 10 ** totalDecimals
}

// ─── Helper: Fetch CoinGecko Market Prices via Enclave ───────────

function fetchMarketPrices(
  runtime: Runtime<Config>,
  confClient: ConfidentialHTTPClient,
  tokenAddresses: string[]
): Record<string, { usd: number; usd_24h_change?: number } | { error: string }> {
  const marketData: Record<string, any> = {}

  // Build CoinGecko ID → testnet address mapping
  const cgIdToTokens: Record<string, string[]> = {}
  const cgIds: string[] = []

  for (const addr of tokenAddresses) {
    const addrLower = addr.toLowerCase()
    const cgId = COINGECKO_MAP[addrLower]
    if (cgId) {
      if (!cgIdToTokens[cgId]) {
        cgIdToTokens[cgId] = []
        cgIds.push(cgId)
      }
      cgIdToTokens[cgId].push(addr)
    }
  }

  if (cgIds.length === 0) return marketData

  try {
    const cgUrl = `https://api.coingecko.com/api/v3/simple/price?ids=${cgIds.join(",")}&vs_currencies=usd&include_24hr_change=true`

    const cgResp = confClient
      .sendRequest(runtime, {
        vaultDonSecrets: [],
        request: {
          url: cgUrl,
          method: "GET",
          multiHeaders: {
            "Accept": { values: ["application/json"] },
          },
          timeout: "15s",
        },
      })
      .result()

    if (!ok(cgResp)) {
      for (const cgId of cgIds) {
        for (const token of cgIdToTokens[cgId]) {
          marketData[token] = { error: `CoinGecko returned status ${cgResp.statusCode}` }
        }
      }
    } else {
      const cgText = new TextDecoder().decode(cgResp.body)
      const cgData = JSON.parse(cgText)

      for (const cgId of cgIds) {
        const data = cgData[cgId]
        for (const token of cgIdToTokens[cgId]) {
          marketData[token] = data
            ? { usd: data.usd, usd_24h_change: data.usd_24h_change }
            : { error: "No CoinGecko data" }
        }
      }
    }
  } catch (e: any) {
    for (const cgId of cgIds) {
      for (const token of cgIdToTokens[cgId]) {
        marketData[token] = { error: e.message }
      }
    }
  }

  return marketData
}

// ─── Main Callback ───────────────────────────────────────────────

const initWorkflow = (config: Config) => {
  const http = new HTTPCapability()

  const onHttpTrigger = (runtime: Runtime<Config>, payload: HTTPPayload): string => {
    const request = decodeJson(payload.input) as NavRequest
    const chainName = (request as any).chainSelectorName || runtime.config.chainSelectorName

    runtime.log(`ccc-basket-nav: basketId=${request.basketId}, chain=${chainName}`)

    if (!request.basketId || request.basketId < 1) {
      return JSON.stringify({ error: "Invalid basketId" })
    }

    // ── Network + EVM client ──
    const network = getNetwork({
      chainFamily: "evm",
      chainSelectorName: chainName,
      isTestnet: true,
    })

    if (!network) {
      return JSON.stringify({ error: `Network not found: ${chainName}` })
    }

    const evmClient = new EVMClient(network.chainSelector.selector)

    const BASKET_FACTORY = BASKET_FACTORIES[chainName]
    if (!BASKET_FACTORY) {
      return JSON.stringify({ error: `No factory configured for chain: ${chainName}` })
    }

    // ── Step 1: Read basket components ──
    runtime.log("Step 1: Reading basket components...")

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

    runtime.log(`  ${components.length} component(s)`)

    // Read basket name
    let basketName = ""
    try {
      const info = callView(
        evmClient, runtime, BASKET_FACTORY,
        basketFactoryAbi, "getBasketInfo",
        [BigInt(request.basketId)]
      ) as readonly [string, Address, bigint, boolean]
      basketName = info[0]
    } catch {
      basketName = `Basket #${request.basketId}`
    }

    // ── Step 2: Price each component via Chainlink oracles ──
    runtime.log("Step 2: Pricing via Chainlink oracles...")

    const priceCache: Record<string, number> = {}

    const breakdown: {
      token: string
      decimals: number
      amount: string
      usdPrice: number
      usdValue: number
      marketPrice?: number
      marketDelta24h?: number
    }[] = []

    let totalNavUsd = 0

    for (const comp of components) {
      const addrLower = comp.token.toLowerCase()
      let tokenDecimals = KNOWN_TOKEN_DECIMALS[addrLower]
      if (tokenDecimals === undefined) {
        runtime.log(`  Unknown token ${comp.token}, reading decimals on-chain`)
        tokenDecimals = callView(
          evmClient, runtime, comp.token,
          erc20Abi, "decimals"
        ) as number
      }

      let usdPrice = priceCache[addrLower]
      if (usdPrice === undefined) {
        usdPrice = getTokenUsdPrice(evmClient, runtime, comp.token, chainName)
        priceCache[addrLower] = usdPrice
      }

      const humanAmount = Number(comp.amount) / 10 ** tokenDecimals
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

    // ── Step 3: CoinGecko cross-check via ConfidentialHTTPClient ──
    runtime.log("Step 3: Market cross-check via ConfidentialHTTPClient...")

    const confClient = new ConfidentialHTTPClient()
    const tokenAddresses = components.map((c) => c.token)
    const marketPrices = fetchMarketPrices(runtime, confClient, tokenAddresses as string[])

    // Merge market prices into breakdown
    for (const entry of breakdown) {
      const market = marketPrices[entry.token]
      if (market && !("error" in market)) {
        entry.marketPrice = market.usd
        entry.marketDelta24h = market.usd_24h_change
        runtime.log(
          `  ${entry.token}: oracle $${entry.usdPrice.toFixed(4)} vs market $${market.usd.toFixed(4)} (${market.usd_24h_change?.toFixed(2) ?? "?"}% 24h)`
        )
      } else if (market && "error" in market) {
        runtime.log(`  ${entry.token}: market data unavailable (${market.error})`)
      }
    }

    // ── Step 4: Calculate fee in LINK ──
    const feeUsd = totalNavUsd * 0.001

    const linkAddr = LINK_ADDRESS[chainName]
    let feeInLink = 0
    let linkPrice = 0

    if (linkAddr) {
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

    // ── Step 5: Return result ──
    const response = JSON.stringify({
      basketId: request.basketId,
      basketName,
      chain: chainName,
      navUsd: totalNavUsd,
      feeUsd,
      feeInLink,
      linkPriceUsd: linkPrice,
      confidential: true,
      components: breakdown,
    })

    runtime.log(`Result: ${response}`)
    return response
  }

  return [handler(http.trigger({}), onHttpTrigger)]
}

// ─── Entry Point ─────────────────────────────────────────────────

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema })
  await runner.run(initWorkflow)
}
