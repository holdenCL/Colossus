/**
 * basket-analysis — CRE Workflow for AI-powered basket portfolio analysis.
 *
 * Demonstrates CRE integrating four heterogeneous data sources:
 *   1. Blockchain — EVMClient reads on Sepolia (getBasketInfo + getComponents)
 *   2. External data source — Space and Time (SXT) Managed DB REST API
 *   3. External market data — CoinGecko API (market cap, 24h volume, 24h change)
 *   4. LLM / AI agent — Claude API for portfolio analysis
 *
 * Flow:
 *   1. HTTP trigger receives { basketId }
 *   2. Fetch secrets (SXT_API_KEY, LLM_API_KEY) via runtime.getSecret()
 *   3. EVMClient reads basket info + components (2 EVM reads of 10 quota)
 *   4. runtime.runInNodeMode() executes:
 *      a. Single HTTP POST → SXT for all components' mainnet analytics
 *      b. HTTP GET → CoinGecko for market cap, 24h volume, 24h price change
 *      c. HTTP POST → Claude API with composition + analytics + market data
 *      d. Return combined analysis result via consensus
 *   5. Return JSON: basket details + token analytics + market data + AI analysis
 *
 * SDK type notes (v1.1.1):
 *   - getSecret() lives on Runtime (DON-level), NOT NodeRuntime
 *   - CacheSettingsJson: { store?: boolean, maxAge?: DurationJson }
 *   - DurationJson: string like "10s", "30s"
 *   - POST body: base64-encoded via Buffer.from(TextEncoder.encode(json))
 *   - Response body: Uint8Array, decode via new TextDecoder().decode()
 *
 * SXT note:
 *   SXT indexes only mainnets (not Sepolia). We map testnet token addresses
 *   to Ethereum mainnet equivalents for analytics queries.
 */

import {
  EVMClient,
  HTTPClient,
  HTTPCapability,
  getNetwork,
  encodeCallMsg,
  bytesToHex,
  LAST_FINALIZED_BLOCK_NUMBER,
  decodeJson,
  handler,
  ok,
  consensusIdenticalAggregation,
  Runner,
  type Runtime,
  type NodeRuntime,
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
  chainSelectorName: z.string(), // e.g. "ethereum-testnet-sepolia"
})

type Config = z.infer<typeof configSchema>

// ─── Types ───────────────────────────────────────────────────────

type AnalysisRequest = {
  basketId: string | number // CLI sends string, direct calls may send number
}

// Data passed from DON-level callback into runInNodeMode via closure
type NodeModeInput = {
  basketName: string
  creator: string
  chainName: string     // chain selector name for prompt context
  sxtApiKey: string   // fetched at DON level, passed in
  llmApiKey: string   // fetched at DON level, passed in
  components: {
    token: string
    symbol: string
    decimals: number
    humanAmount: number
    rawAmount: string
    mainnetAddress: string | null
  }[]
}

// Result returned from runInNodeMode (must be consensus-able)
type AnalysisResult = {
  tokenAnalytics: string // JSON-stringified SXT analytics map
  marketData: string     // JSON-stringified CoinGecko market data map
  aiAnalysis: string
}

// ─── ABIs ────────────────────────────────────────────────────────
// Only the two functions we call. 2 EVM reads total.

const basketFactoryAbi = parseAbi([
"function getBasketInfo(uint256 basketId) view returns (string name, address creator, uint256 componentCount, bool hasNFT)",
"function getComponents(uint256 basketId) view returns ((address token, uint8 standard, uint256 tokenId, uint256 amount)[])",
])

// ─── Contract Addresses ──────────────────────────────────────────

const BASKET_FACTORIES: Record<string, Address> = {
  "ethereum-testnet-sepolia": "0x885eC430c471a74078C7461Fd9F44D32cB019d3D",
  "ethereum-testnet-sepolia-base-1":     "0xcf26e052aa417cEb1641e8B7eA806F388Cc9a022",
}

// ─── Mainnet Token Mapping ───────────────────────────────────────
// SXT only indexes mainnets, so we map testnet tokens → mainnet equivalents.

const MAINNET_TOKEN_MAP: Record<string, { address: string; symbol: string; coingeckoId: string }> = {
  // Sepolia LINK → Mainnet LINK
  "0x779877a7b0d9e8603169ddbd7836e478b4624789": {
    address: "0x514910771af9ca656af840dff83e8264ecf986ca",
    symbol: "LINK",
    coingeckoId: "chainlink",
  },
  // Sepolia WETH → Mainnet WETH
  "0xfff9976782d46cc05630d1f6ebab18b2324d6b14": {
    address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    symbol: "WETH",
    coingeckoId: "weth",
  },
  // Base Sepolia LINK → Mainnet LINK
  "0xe4ab69c077896252fafbd49efd26b5d171a32410": {
    address: "0x514910771af9ca656af840dff83e8264ecf986ca",
    symbol: "LINK",
    coingeckoId: "chainlink",
  },
  // Base Sepolia WETH → Mainnet WETH
  "0x4200000000000000000000000000000000000006": {
    address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    symbol: "WETH",
    coingeckoId: "weth",
  },
}

// Known token decimals (avoids extra EVM reads)
const KNOWN_TOKEN_DECIMALS: Record<string, number> = {
  "0x779877a7b0d9e8603169ddbd7836e478b4624789": 18, // Sepolia LINK
  "0xfff9976782d46cc05630d1f6ebab18b2324d6b14": 18, // Sepolia WETH
  "0xe4ab69c077896252fafbd49efd26b5d171a32410": 18, // Base Sepolia LINK
  "0x4200000000000000000000000000000000000006": 18, // Base Sepolia WETH
}

// ─── Constants ───────────────────────────────────────────────────

const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

const SXT_API_URL = "https://proxy.api.makeinfinite.dev/v1/sql"
const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages"

// ─── Helper: EVM Read ────────────────────────────────────────────
// Same callView pattern as basket-nav.

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

// ─── Helper: Encode POST body ────────────────────────────────────
// CRE requires HTTP request bodies as base64-encoded strings.
// Pattern: JSON object → JSON string → UTF-8 bytes → base64 string

function encodeBody(jsonObj: any): string {
  const bodyBytes = new TextEncoder().encode(JSON.stringify(jsonObj))
  return Buffer.from(bodyBytes).toString("base64")
}

// ─── Helper: Build SXT SQL ───────────────────────────────────────
// Combines all token addresses into a single query with GROUP BY.
// One HTTP call instead of N — cuts SXT wait time roughly in half
// since the API takes 30-45s per call.

function buildCombinedAnalyticsQuery(mainnetAddresses: string[]): string {
  const quoted = mainnetAddresses
    .map((a) => `'${a.toLowerCase()}'`)
    .join(", ")
  return [
    "SELECT",
    "CONTRACT_ADDRESS,",
    "COUNT(*) as TRANSFER_COUNT,",
    "MIN(TIME_STAMP) as FIRST_SEEN,",
    "MAX(TIME_STAMP) as LAST_ACTIVE",
    "FROM ETHEREUM.LOGS",
    `WHERE CONTRACT_ADDRESS IN (${quoted})`,
    `AND TOPIC_0 = '${TRANSFER_TOPIC}'`,
    "GROUP BY CONTRACT_ADDRESS",
  ].join(" ")
}

// ─── Helper: Build Claude prompt ─────────────────────────────────

function buildAnalysisPrompt(
  basketName: string,
  creator: string,
  chainName: string,
  components: {
    symbol: string
    humanAmount: number
    token: string
    analytics: any
    market: any
  }[]
): string {
  const composition = components
    .map((c) => {
      let statsLine: string
      if (c.analytics?.error) {
        statsLine = `  Analytics: unavailable (${c.analytics.error})`
      } else {
        statsLine = [
          `  Mainnet analytics:`,
          `${c.analytics?.TRANSFER_COUNT ?? "?"} transfers,`,
          `first seen ${c.analytics?.FIRST_SEEN ?? "?"},`,
          `last active ${c.analytics?.LAST_ACTIVE ?? "?"}`,
        ].join(" ")
      }

      let marketLine: string
      if (c.market?.error) {
        marketLine = `  Market data: unavailable (${c.market.error})`
      } else if (c.market) {
        marketLine = [
          `  Market data:`,
          `price $${c.market.usd ?? "?"},`,
          `market cap $${c.market.usd_market_cap ? (c.market.usd_market_cap / 1e9).toFixed(2) + "B" : "?"},`,
          `24h vol $${c.market.usd_24h_vol ? (c.market.usd_24h_vol / 1e6).toFixed(1) + "M" : "?"},`,
          `24h change ${c.market.usd_24h_change != null ? c.market.usd_24h_change.toFixed(2) + "%" : "?"}`,
        ].join(" ")
      } else {
        marketLine = `  Market data: not available`
      }

      return `- ${c.symbol}: ${c.humanAmount} tokens (${c.token})\n${statsLine}\n${marketLine}`
    })
    .join("\n")

  return [
    "You are a DeFi portfolio analyst. Analyze this on-chain token basket.",
    "",
    `Basket: "${basketName}"`,
    `Creator: ${creator}`,
    `Chain: ${chainName} (testnet)`,
    `Components:`,
    composition,
    "",
    "Provide a concise analysis (3-5 sentences) covering:",
    "1. Portfolio composition and diversification",
    "2. Token activity levels based on the mainnet analytics data",
    "3. Current market context (price momentum, volume, market cap)",
    "4. Any notable observations or recommendations",
    "",
    "Note: This is a testnet basket. Analytics and market data are from",
    "Ethereum mainnet equivalents. Keep the analysis practical and brief.",
  ].join("\n")
}

// ─── Node-Level Function: SXT + CoinGecko + Claude HTTP calls ───
// Runs inside runtime.runInNodeMode() for HTTP POST calls.
//
// Key SDK facts (v1.1.1):
//   - getSecret() is on Runtime, NOT NodeRuntime. So we fetch secrets
//     at DON level and pass them in via closure.
//   - HTTPClient.sendRequest(nodeRuntime, req) makes outbound HTTP.
//   - CacheSettingsJson: { store: true, maxAge: "120s" }
//     (NOT { readFromCache, maxAgeMs } as some docs show)
//   - timeout: DurationJson string like "10s"
//   - POST body: must be base64-encoded
//   - Response body: Uint8Array, decode with TextDecoder

function makeFetchAnalysis(input: NodeModeInput) {
  return (nodeRuntime: NodeRuntime<Config>): AnalysisResult => {
    const httpClient = new HTTPClient()

    // Secrets were fetched at DON level and passed in via closure
    const { sxtApiKey, llmApiKey } = input

    // ── SXT query: single combined call for all components ──
    const tokenAnalytics: Record<string, any> = {}

    // Build mapping: mainnet address → testnet token address(es)
    const mainnetToTestnet: Record<string, string[]> = {}
    const queryableAddresses: string[] = []

    for (const comp of input.components) {
      if (!comp.mainnetAddress) {
        tokenAnalytics[comp.token] = {
          error: "No mainnet mapping for this testnet token",
        }
        continue
      }
      const mainLower = comp.mainnetAddress.toLowerCase()
      queryableAddresses.push(mainLower)
      if (!mainnetToTestnet[mainLower]) mainnetToTestnet[mainLower] = []
      mainnetToTestnet[mainLower].push(comp.token)
    }

    if (queryableAddresses.length > 0) {
      const sql = buildCombinedAnalyticsQuery(queryableAddresses)

      try {
        const sxtReq = {
          url: SXT_API_URL,
          method: "POST" as const,
          body: encodeBody({ sqlText: sql }),
          headers: {
            "Content-Type": "application/json",
            apiKey: sxtApiKey,
          },
          timeout: "60s",
          cacheSettings: {
            store: true,
            maxAge: "120s",
          },
        }

        const resp = httpClient.sendRequest(nodeRuntime, sxtReq).result()

        if (!ok(resp)) {
          // Mark all queryable tokens as failed
          for (const addr of queryableAddresses) {
            for (const testnetToken of mainnetToTestnet[addr]) {
              tokenAnalytics[testnetToken] = {
                error: `SXT returned status ${resp.statusCode}`,
              }
            }
          }
        } else {
          const bodyText = new TextDecoder().decode(resp.body)
          const sxtData = JSON.parse(bodyText)

          // Build lookup: lowercase mainnet address → row data
          const rowMap: Record<string, any> = {}
          if (Array.isArray(sxtData)) {
            for (const row of sxtData) {
              const addr = (row.CONTRACT_ADDRESS || "").toLowerCase()
              rowMap[addr] = row
            }
          }

          // Map results back to testnet token addresses
          for (const mainAddr of queryableAddresses) {
            const row = rowMap[mainAddr]
            for (const testnetToken of mainnetToTestnet[mainAddr]) {
              tokenAnalytics[testnetToken] = row
                ? row
                : { error: "No data returned from SXT for this token" }
            }
          }
        }
      } catch (e: any) {
        // Mark all queryable tokens as failed
        for (const addr of queryableAddresses) {
          for (const testnetToken of mainnetToTestnet[addr]) {
            tokenAnalytics[testnetToken] = { error: e.message }
          }
        }
      }
    }

    // ── CoinGecko market data: single GET for all components ──
    const marketData: Record<string, any> = {}

    // Build mapping: coingeckoId → testnet token address(es)
    const cgIdToTestnet: Record<string, string[]> = {}
    const cgIds: string[] = []

    for (const comp of input.components) {
      if (!comp.mainnetAddress) continue
      const addrLower = comp.token.toLowerCase()
      const mapping = MAINNET_TOKEN_MAP[addrLower]
      if (mapping?.coingeckoId) {
        const cgId = mapping.coingeckoId
        if (!cgIdToTestnet[cgId]) {
          cgIdToTestnet[cgId] = []
          cgIds.push(cgId)
        }
        cgIdToTestnet[cgId].push(comp.token)
      }
    }

    if (cgIds.length > 0) {
      try {
        const cgUrl = `https://api.coingecko.com/api/v3/simple/price?ids=${cgIds.join(",")}&vs_currencies=usd&include_market_cap=true&include_24hr_vol=true&include_24hr_change=true`

        const cgReq = {
          url: cgUrl,
          method: "GET" as const,
          headers: {
            "Accept": "application/json",
          },
          timeout: "15s",
          cacheSettings: {
            store: true,
            maxAge: "120s",
          },
        }

        const cgResp = httpClient.sendRequest(nodeRuntime, cgReq).result()

        if (!ok(cgResp)) {
          for (const cgId of cgIds) {
            for (const testnetToken of cgIdToTestnet[cgId]) {
              marketData[testnetToken] = {
                error: `CoinGecko returned status ${cgResp.statusCode}`,
              }
            }
          }
        } else {
          const cgText = new TextDecoder().decode(cgResp.body)
          const cgData = JSON.parse(cgText)

          // CoinGecko response keyed by coin ID: { "chainlink": { usd: 9.34, ... } }
          for (const cgId of cgIds) {
            const data = cgData[cgId]
            for (const testnetToken of cgIdToTestnet[cgId]) {
              marketData[testnetToken] = data
                ? data
                : { error: "No CoinGecko data for this token" }
            }
          }
        }
      } catch (e: any) {
        for (const cgId of cgIds) {
          for (const testnetToken of cgIdToTestnet[cgId]) {
            marketData[testnetToken] = { error: e.message }
          }
        }
      }
    }

    // ── Claude API call ──
    const promptComponents = input.components.map((c) => ({
      token: c.token,
      symbol: c.symbol,
      humanAmount: c.humanAmount,
      analytics: tokenAnalytics[c.token],
      market: marketData[c.token],
    }))

    const prompt = buildAnalysisPrompt(
      input.basketName,
      input.creator,
      input.chainName,
      promptComponents
    )

    let aiAnalysis = ""

    try {
      const claudeReq = {
        url: CLAUDE_API_URL,
        method: "POST" as const,
        body: encodeBody({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1024,
          messages: [{ role: "user", content: prompt }],
        }),
        headers: {
          "Content-Type": "application/json",
          "x-api-key": llmApiKey,
          "anthropic-version": "2023-06-01",
        },
        timeout: "30s",
        cacheSettings: {
          store: true,
          maxAge: "60s",
        },
      }

      const resp = httpClient.sendRequest(nodeRuntime, claudeReq).result()

      if (!ok(resp)) {
        aiAnalysis = `Claude API returned status ${resp.statusCode}`
      } else {
        const bodyText = new TextDecoder().decode(resp.body)
        const claudeData = JSON.parse(bodyText)

        // Claude API response: { content: [{ type: "text", text: "..." }] }
        aiAnalysis =
          claudeData.content
            ?.filter((block: any) => block.type === "text")
            .map((block: any) => block.text)
            .join("\n") ?? "No analysis generated"
      }
    } catch (e: any) {
      aiAnalysis = `Analysis unavailable: ${e.message}`
    }

    return {
      tokenAnalytics: JSON.stringify(tokenAnalytics),
      marketData: JSON.stringify(marketData),
      aiAnalysis,
    }
  }
}

// ─── Main Callback (DON-level) ───────────────────────────────────

const initWorkflow = (config: Config) => {
  const http = new HTTPCapability()

  const onHttpTrigger = (
    runtime: Runtime<Config>,
    payload: HTTPPayload
  ): string => {
    const request = decodeJson(payload.input) as AnalysisRequest
    const basketId = Number(request.basketId) // CLI sends string "2", not number 2
    const chainName = (request as any).chainSelectorName || runtime.config.chainSelectorName

    runtime.log(
      `basket-analysis: basketId=${basketId}, chain=${chainName}`
    )

    if (!basketId || basketId < 1 || isNaN(basketId)) {
      return JSON.stringify({ error: "Invalid basketId" })
    }

    // ── Fetch secrets at DON level ──
    // getSecret() is on Runtime (DON-level), NOT NodeRuntime.
    // We fetch here and pass values into runInNodeMode via closure.
    // Must be sequential — WASM host doesn't support parallel getSecret().
    runtime.log("Fetching API keys...")

    const sxtApiKey = runtime.getSecret({ id: "SXT_API_KEY" }).result()
    const llmApiKey = runtime.getSecret({ id: "LLM_API_KEY" }).result()

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

    // ── Resolve factory for this chain ──
    const BASKET_FACTORY = BASKET_FACTORIES[chainName]
    if (!BASKET_FACTORY) {
      return JSON.stringify({ error: `No factory configured for chain: ${chainName}` })
    }

    // ── Step 1: Read basket info (EVM read #1 of 10) ──
    runtime.log("Step 1: Reading basket info...")

    let basketName: string
    let basketCreator: string
    let componentCount: number

    try {
      const info = callView(
        evmClient,
        runtime,
        BASKET_FACTORY,
        basketFactoryAbi,
        "getBasketInfo",
        [BigInt(basketId)]
      ) as readonly [string, string, bigint, boolean]

      basketName = info[0]
      basketCreator = info[1]
      componentCount = Number(info[2])
    } catch (e: any) {
      return JSON.stringify({
        error: `Failed to read basket info: ${e.message}`,
      })
    }

    runtime.log(
      `  "${basketName}" by ${basketCreator}, ${componentCount} component(s)`
    )

    // ── Step 2: Read basket components (EVM read #2 of 10) ──
    runtime.log("Step 2: Reading basket components...")

    let components: readonly { token: Address; standard: number; tokenId: bigint; amount: bigint }[]

    try {
      components = callView(
        evmClient,
        runtime,
        BASKET_FACTORY,
        basketFactoryAbi,
        "getComponents",
        [BigInt(basketId)]
      ) as readonly { token: Address; standard: number; tokenId: bigint; amount: bigint }[]
    } catch (e: any) {
      return JSON.stringify({
        error: `Failed to read components: ${e.message}`,
      })
    }

    runtime.log(`  ${components.length} component(s) loaded`)

    // ── Parse component details ──
    const componentDetails = components.map((comp) => {
      const addrLower = comp.token.toLowerCase()
      const decimals = KNOWN_TOKEN_DECIMALS[addrLower] ?? 18
      const humanAmount = Number(comp.amount) / 10 ** decimals
      const mainnetInfo = MAINNET_TOKEN_MAP[addrLower]

      return {
        token: comp.token,
        decimals,
        rawAmount: comp.amount.toString(),
        humanAmount,
        symbol: mainnetInfo?.symbol ?? "UNKNOWN",
        mainnetAddress: mainnetInfo?.address ?? null,
      }
    })

    // ── Step 3+4+5: SXT + CoinGecko + Claude via runInNodeMode ──
    // HTTP calls happen inside runInNodeMode (needs NodeRuntime for HTTPClient).
    // Secrets were fetched above at DON level and are passed in via closure.
    runtime.log("Step 3: Querying SXT + CoinGecko + Claude via runInNodeMode...")

    const nodeModeInput: NodeModeInput = {
      basketName,
      creator: basketCreator,
      chainName,
      sxtApiKey: sxtApiKey.value,
      llmApiKey: llmApiKey.value,
      components: componentDetails,
    }

    const analysisResult = runtime
      .runInNodeMode(
        makeFetchAnalysis(nodeModeInput),
        consensusIdenticalAggregation<AnalysisResult>()
      )()
      .result()

    // ── Step 6: Assemble final response ──
    const parsedAnalytics = JSON.parse(analysisResult.tokenAnalytics)
    const parsedMarket = JSON.parse(analysisResult.marketData)

    const response = JSON.stringify({
      basketId,
      basketName,
      creator: basketCreator,
      chain: chainName,
      componentCount,
      components: componentDetails.map((c) => ({
        token: c.token,
        symbol: c.symbol,
        decimals: c.decimals,
        amount: c.humanAmount,
        rawAmount: c.rawAmount,
        mainnetEquivalent: c.mainnetAddress,
        analytics: parsedAnalytics[c.token] ?? null,
        market: parsedMarket[c.token] ?? null,
      })),
      aiAnalysis: analysisResult.aiAnalysis,
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