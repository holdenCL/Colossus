/**
 * ccc-basket-analysis — CCC-enhanced CRE Workflow for privacy-preserving basket analysis.
 *
 * This is the Confidential HTTP version of basket-analysis. All external API calls
 * (SXT, CoinGecko, Claude) execute inside a secure enclave via ConfidentialHTTPClient.
 *
 * Data sources (same 4 as basket-analysis):
 *   1. Blockchain — EVMClient reads (getBasketInfo + getComponents) [unchanged]
 *   2. External data — Space and Time (SXT) via ConfidentialHTTPClient
 *   3. Market data — CoinGecko via ConfidentialHTTPClient
 *   4. LLM / AI — Claude API via ConfidentialHTTPClient
 *
 * What's different from basket-analysis:
 *   - HTTPClient + runInNodeMode() → ConfidentialHTTPClient.sendRequest() (direct calls)
 *   - runtime.getSecret() → vaultDonSecrets with {{.template}} injection in enclave
 *   - headers → multiHeaders format ({ values: string[] })
 *   - body → bodyString (JSON string, not base64)
 *   - API credentials never leave the secure enclave
 *
 * SDK API (from actual type definitions):
 *   confClient.sendRequest(runtime, {
 *     vaultDonSecrets: [{ key, namespace, owner? }],
 *     request: { url, method, bodyString?, multiHeaders?, timeout? }
 *   }).result() → HTTPResponse
 *
 * Note: ConfidentialHTTPClient is experimental (simulation-only as of CRE v1.2).
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

type AnalysisRequest = {
  basketId: string | number
}

// ─── ABIs ────────────────────────────────────────────────────────

const basketFactoryAbi = parseAbi([
"function getBasketInfo(uint256 basketId) view returns (string name, address creator, uint256 componentCount, bool hasNFT)",
"function getComponents(uint256 basketId) view returns ((address token, uint8 standard, uint256 tokenId, uint256 amount)[])",
])

// ─── Contract Addresses ──────────────────────────────────────────

const BASKET_FACTORIES: Record<string, Address> = {
  "ethereum-testnet-sepolia": "0x885eC430c471a74078C7461Fd9F44D32cB019d3D",
  "ethereum-testnet-sepolia-base-1": "0xcf26e052aa417cEb1641e8B7eA806F388Cc9a022",
}

// ─── Mainnet Token Mapping ───────────────────────────────────────

const MAINNET_TOKEN_MAP: Record<string, { address: string; symbol: string; coingeckoId: string }> = {
  "0x779877a7b0d9e8603169ddbd7836e478b4624789": {
    address: "0x514910771af9ca656af840dff83e8264ecf986ca",
    symbol: "LINK",
    coingeckoId: "chainlink",
  },
  "0xfff9976782d46cc05630d1f6ebab18b2324d6b14": {
    address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    symbol: "WETH",
    coingeckoId: "weth",
  },
  "0xe4ab69c077896252fafbd49efd26b5d171a32410": {
    address: "0x514910771af9ca656af840dff83e8264ecf986ca",
    symbol: "LINK",
    coingeckoId: "chainlink",
  },
  "0x4200000000000000000000000000000000000006": {
    address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    symbol: "WETH",
    coingeckoId: "weth",
  },
}

const KNOWN_TOKEN_DECIMALS: Record<string, number> = {
  "0x779877a7b0d9e8603169ddbd7836e478b4624789": 18,
  "0xfff9976782d46cc05630d1f6ebab18b2324d6b14": 18,
  "0xe4ab69c077896252fafbd49efd26b5d171a32410": 18,
  "0x4200000000000000000000000000000000000006": 18,
}

// ─── Constants ───────────────────────────────────────────────────

const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

const SXT_API_URL = "https://proxy.api.makeinfinite.dev/v1/sql"
const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages"

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

// ─── Helper: Build SXT SQL ───────────────────────────────────────

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

// ─── Helper: Build Claude Prompt ─────────────────────────────────

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
    "",
    "IMPORTANT: This analysis was computed inside a Chainlink CCC secure enclave.",
    "The basket composition, API queries, and credentials never left the enclave.",
  ].join("\n")
}

// ─── Main Callback (DON-level) ───────────────────────────────────

const initWorkflow = (config: Config) => {
  const http = new HTTPCapability()

  const onHttpTrigger = (
    runtime: Runtime<Config>,
    payload: HTTPPayload
  ): string => {
    const request = decodeJson(payload.input) as AnalysisRequest
    const basketId = Number(request.basketId)
    const chainName = (request as any).chainSelectorName || runtime.config.chainSelectorName

    runtime.log(
      `ccc-basket-analysis: basketId=${basketId}, chain=${chainName}`
    )

    if (!basketId || basketId < 1 || isNaN(basketId)) {
      return JSON.stringify({ error: "Invalid basketId" })
    }

    // ── No getSecret() calls needed! ──
    // Secrets are injected via Vault DON templates inside the enclave.
    // The workflow code never sees actual API key values.

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

    // ── Step 1: Read basket info (EVM read #1) ──
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

    // ── Step 2: Read basket components (EVM read #2) ──
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

    // ── Step 3: SXT via ConfidentialHTTPClient ──
    // All HTTP calls use confClient.sendRequest(runtime, request).result()
    // directly — no runInNodeMode, no callback, no consensus wrapper needed.
    runtime.log("Step 3: Querying SXT via ConfidentialHTTPClient...")

    const confClient = new ConfidentialHTTPClient()
    const tokenAnalytics: Record<string, any> = {}

    const mainnetToTestnet: Record<string, string[]> = {}
    const queryableAddresses: string[] = []

    for (const comp of componentDetails) {
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
        const sxtResp = confClient
          .sendRequest(runtime, {
            vaultDonSecrets: [{ key: "sxtApiKey", namespace: "", owner: "" }],
            request: {
              url: SXT_API_URL,
              method: "POST",
              bodyString: JSON.stringify({ sqlText: sql }),
              multiHeaders: {
                "Content-Type": { values: ["application/json"] },
                "apiKey": { values: ["{{.sxtApiKey}}"] },
              },
              timeout: "90s",
            },
          })
          .result()

        if (!ok(sxtResp)) {
          for (const addr of queryableAddresses) {
            for (const testnetToken of mainnetToTestnet[addr]) {
              tokenAnalytics[testnetToken] = {
                error: `SXT returned status ${sxtResp.statusCode}`,
              }
            }
          }
        } else {
          const bodyText = new TextDecoder().decode(sxtResp.body)
          const sxtData = JSON.parse(bodyText)

          const rowMap: Record<string, any> = {}
          if (Array.isArray(sxtData)) {
            for (const row of sxtData) {
              const addr = (row.CONTRACT_ADDRESS || "").toLowerCase()
              rowMap[addr] = row
            }
          }

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
        for (const addr of queryableAddresses) {
          for (const testnetToken of mainnetToTestnet[addr]) {
            tokenAnalytics[testnetToken] = { error: e.message }
          }
        }
      }
    }

    // ── Step 4: CoinGecko via ConfidentialHTTPClient ──
    // No secret needed, but query executes inside enclave — token IDs stay private.
    runtime.log("Step 4: Querying CoinGecko via ConfidentialHTTPClient...")

    const marketData: Record<string, any> = {}
    const cgIdToTestnet: Record<string, string[]> = {}
    const cgIds: string[] = []

    for (const comp of componentDetails) {
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
            for (const testnetToken of cgIdToTestnet[cgId]) {
              marketData[testnetToken] = {
                error: `CoinGecko returned status ${cgResp.statusCode}`,
              }
            }
          }
        } else {
          const cgText = new TextDecoder().decode(cgResp.body)
          const cgData = JSON.parse(cgText)

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

    // ── Step 5: Claude AI via ConfidentialHTTPClient ──
    runtime.log("Step 5: Querying Claude via ConfidentialHTTPClient...")

    const promptComponents = componentDetails.map((c) => ({
      token: c.token,
      symbol: c.symbol,
      humanAmount: c.humanAmount,
      analytics: tokenAnalytics[c.token],
      market: marketData[c.token],
    }))

    const prompt = buildAnalysisPrompt(
      basketName,
      basketCreator,
      chainName,
      promptComponents
    )

    let aiAnalysis = ""

    try {
      const claudeResp = confClient
        .sendRequest(runtime, {
          vaultDonSecrets: [{ key: "llmApiKey", namespace: "", owner: "" }],
          request: {
            url: CLAUDE_API_URL,
            method: "POST",
            bodyString: JSON.stringify({
              model: "claude-sonnet-4-20250514",
              max_tokens: 1024,
              messages: [{ role: "user", content: prompt }],
            }),
            multiHeaders: {
              "Content-Type": { values: ["application/json"] },
              "x-api-key": { values: ["{{.llmApiKey}}"] },
              "anthropic-version": { values: ["2023-06-01"] },
            },
            timeout: "30s",
          },
        })
        .result()

      if (!ok(claudeResp)) {
        aiAnalysis = `Claude API returned status ${claudeResp.statusCode}`
      } else {
        const bodyText = new TextDecoder().decode(claudeResp.body)
        const claudeData = JSON.parse(bodyText)

        aiAnalysis =
          claudeData.content
            ?.filter((block: any) => block.type === "text")
            .map((block: any) => block.text)
            .join("\n") ?? "No analysis generated"
      }
    } catch (e: any) {
      aiAnalysis = `Analysis unavailable: ${e.message}`
    }

    // ── Step 6: Assemble final response ──
    runtime.log("Step 6: Assembling response...")

    const response = JSON.stringify({
      basketId,
      basketName,
      creator: basketCreator,
      chain: chainName,
      componentCount,
      confidential: true, // Flag: this analysis used ConfidentialHTTPClient
      components: componentDetails.map((c) => ({
        token: c.token,
        symbol: c.symbol,
        decimals: c.decimals,
        amount: c.humanAmount,
        rawAmount: c.rawAmount,
        mainnetEquivalent: c.mainnetAddress,
        analytics: tokenAnalytics[c.token] ?? null,
        market: marketData[c.token] ?? null,
      })),
      aiAnalysis,
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
