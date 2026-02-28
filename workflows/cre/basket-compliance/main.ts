import {
  HTTPCapability,
  EVMClient,
  getNetwork,
  encodeCallMsg,
  bytesToHex,
  LAST_FINALIZED_BLOCK_NUMBER,
  decodeJson,
  handler,
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

// ─── Config ──────────────────────────────────────────────────────────
const configSchema = z.object({
  chainSelectorName: z.string(),
  factoryAddress: z.string(),
})

type Config = z.infer<typeof configSchema>

// ─── Input ───────────────────────────────────────────────────────────
type ComplianceRequest = {
  userAddress: string
  basketId: string
}

// ─── ABIs (view functions only) ──────────────────────────────────────
const factoryAbi = parseAbi([
  "function getPolicyEngine() view returns (address)",
  "function getBasketInfo(uint256 basketId) view returns (string name, address creator, uint256 componentCount, bool hasNFT)",
])

const policyEngineAbi = parseAbi([
  "function getPolicies(address target, bytes4 selector) view returns (address[])",
])

const allowPolicyAbi = parseAbi([
  "function isAllowed(address account) view returns (bool)",
])

// weave() selector — the primary gated function
const WEAVE_SELECTOR = "0x5b48e677" as `0x${string}`

// ─── Helpers ─────────────────────────────────────────────────────────

/** Read a contract and return raw bytes, or null on empty result */
function contractRead(
  evmClient: EVMClient,
  runtime: Runtime<Config>,
  to: Address,
  callData: `0x${string}`
): `0x${string}` | null {
  const result = evmClient
    .callContract(runtime, {
      call: encodeCallMsg({
        from: zeroAddress,
        to,
        data: callData,
      }),
      blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
    })
    .result()

  if (result.data.length === 0) return null
  return bytesToHex(result.data)
}

// ─── Workflow Handler ────────────────────────────────────────────────

const onHttpTrigger = (runtime: Runtime<Config>, payload: HTTPPayload): string => {
  const request = decodeJson(payload.input) as ComplianceRequest

  if (!request.userAddress || !request.basketId) {
    return JSON.stringify({ error: "Missing userAddress or basketId" })
  }

  const network = getNetwork({
    chainFamily: "evm",
    chainSelectorName: runtime.config.chainSelectorName,
    isTestnet: true,
  })

  if (!network) {
    throw new Error(`Network not found: ${runtime.config.chainSelectorName}`)
  }

  const evmClient = new EVMClient(network.chainSelector.selector)
  const factory = runtime.config.factoryAddress as Address
  const userAddr = request.userAddress as Address
  const basketId = BigInt(request.basketId)

  // ── 1. Verify basket exists ────────────────────────────────────────
  const basketInfoData = encodeFunctionData({
    abi: factoryAbi,
    functionName: "getBasketInfo",
    args: [basketId],
  })

  const basketInfoRaw = contractRead(evmClient, runtime, factory, basketInfoData)
  if (!basketInfoRaw) {
    return JSON.stringify({
      compliant: false,
      error: `Basket ${request.basketId} not found`,
      userAddress: userAddr,
      basketId: request.basketId,
    })
  }

  const [basketName, creator, componentCount, hasNFT] = decodeFunctionResult({
    abi: factoryAbi,
    functionName: "getBasketInfo",
    data: basketInfoRaw,
  }) as [string, Address, bigint, boolean]

  runtime.log(`Basket ${request.basketId}: "${basketName}", ${componentCount} components, hasNFT=${hasNFT}`)

  // ── 2. Get PolicyEngine address from factory ───────────────────────
  const getPEData = encodeFunctionData({
    abi: factoryAbi,
    functionName: "getPolicyEngine",
  })

  const peRaw = contractRead(evmClient, runtime, factory, getPEData)
  if (!peRaw) {
    return JSON.stringify({
      compliant: true,
      reason: "No PolicyEngine configured — all operations allowed",
      userAddress: userAddr,
      basketId: request.basketId,
      basketName,
    })
  }

  const policyEngineAddr = decodeFunctionResult({
    abi: factoryAbi,
    functionName: "getPolicyEngine",
    data: peRaw,
  }) as Address

  runtime.log(`PolicyEngine: ${policyEngineAddr}`)

  // ── 3. Get policies attached to weave() ────────────────────────────
  const getPoliciesData = encodeFunctionData({
    abi: policyEngineAbi,
    functionName: "getPolicies",
    args: [factory, WEAVE_SELECTOR],
  })

  const policiesRaw = contractRead(evmClient, runtime, policyEngineAddr, getPoliciesData)

  let policies: Address[] = []
  if (policiesRaw) {
    policies = decodeFunctionResult({
      abi: policyEngineAbi,
      functionName: "getPolicies",
      data: policiesRaw,
    }) as Address[]
  }

  runtime.log(`Policies on weave(): ${policies.length > 0 ? policies.join(", ") : "none"}`)

  // ── 4. Check each policy's allowlist for the user ──────────────────
  // For each attached policy, call isAllowed(userAddress).
  // A policy that doesn't support isAllowed returns null → treat as "no opinion".
  const policyResults: { policy: string; isAllowed: boolean | null }[] = []

  for (const policyAddr of policies) {
    const isAllowedData = encodeFunctionData({
      abi: allowPolicyAbi,
      functionName: "isAllowed",
      args: [userAddr],
    })

    const allowedRaw = contractRead(evmClient, runtime, policyAddr, isAllowedData)

    if (allowedRaw) {
      const allowed = decodeFunctionResult({
        abi: allowPolicyAbi,
        functionName: "isAllowed",
        data: allowedRaw,
      }) as boolean

      policyResults.push({ policy: policyAddr, isAllowed: allowed })
      runtime.log(`Policy ${policyAddr}: isAllowed(${userAddr}) = ${allowed}`)
    } else {
      // Policy doesn't expose isAllowed — might be a different policy type
      policyResults.push({ policy: policyAddr, isAllowed: null })
      runtime.log(`Policy ${policyAddr}: isAllowed not available`)
    }
  }

  // ── 5. Determine compliance ────────────────────────────────────────
  // Compliant if:
  //   - No policies attached (defaultAllow governs, which we can't read but assume true)
  //   - At least one policy explicitly allows the user
  //   - All policies return null (no opinion → defers to defaultAllow)
  let compliant: boolean
  let reason: string

  if (policies.length === 0) {
    compliant = true
    reason = "No policies attached to weave() — defaultAllow governs"
  } else {
    const explicitAllow = policyResults.some((p) => p.isAllowed === true)
    const explicitDeny = policyResults.some((p) => p.isAllowed === false)

    if (explicitAllow) {
      compliant = true
      reason = "User is explicitly allowlisted by at least one policy"
    } else if (explicitDeny) {
      compliant = false
      reason = "User is not on any policy allowlist — would defer to defaultAllow (may be denied)"
    } else {
      // All null — no policy has an opinion
      compliant = true
      reason = "No policy has an opinion on this user — defers to defaultAllow"
    }
  }

  const response = JSON.stringify({
    compliant,
    reason,
    userAddress: userAddr,
    basketId: request.basketId,
    basketName,
    componentCount: componentCount.toString(),
    hasNFT,
    policyEngine: policyEngineAddr,
    policies: policyResults,
  })

  runtime.log(`Compliance result: ${response}`)
  return response
}

// ─── Workflow Setup ──────────────────────────────────────────────────

const initWorkflow = (config: Config) => {
  const http = new HTTPCapability()
  return [
    handler(http.trigger({}), onHttpTrigger),
  ]
}

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema })
  await runner.run(initWorkflow)
}
