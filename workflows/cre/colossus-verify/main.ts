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

const configSchema = z.object({
  chainSelectorName: z.string(),
})

type Config = z.infer<typeof configSchema>

type VerifyRequest = {
  userAddress: string
  tokenAddresses: string[]
  amounts: string[]      // per-unit amounts in wei (same order as tokenAddresses)
  units: number          // number of basket units to mint
}

const erc20Abi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
])

const onHttpTrigger = (runtime: Runtime<Config>, payload: HTTPPayload): string => {
  const request = decodeJson(payload.input) as VerifyRequest

  if (!request.userAddress || !request.tokenAddresses || request.tokenAddresses.length === 0) {
    return JSON.stringify({ error: "Missing userAddress or tokenAddresses" })
  }

  // Default to balance-only mode if amounts/units not provided (backward compatible)
  const hasAmounts = request.amounts && request.amounts.length === request.tokenAddresses.length
  const units = request.units && request.units > 0 ? BigInt(request.units) : 1n

  const chainName = (request as any).chainSelectorName || runtime.config.chainSelectorName

  const network = getNetwork({
    chainFamily: "evm",
    chainSelectorName: chainName,
    isTestnet: true,
  })

  if (!network) {
    throw new Error(`Network not found: ${chainName}`)
  }

  const evmClient = new EVMClient(network.chainSelector.selector)
  const userAddr = request.userAddress as Address

  const balances: { token: string; balance: string; required: string; sufficient: boolean }[] = []
  let allSufficient = true

  for (let i = 0; i < request.tokenAddresses.length; i++) {
    const tokenAddr = request.tokenAddresses[i]

    const callData = encodeFunctionData({
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [userAddr],
    })

    const result = evmClient
      .callContract(runtime, {
        call: encodeCallMsg({
          from: zeroAddress,
          to: tokenAddr as Address,
          data: callData,
        }),
        blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
      })
      .result()

    if (result.data.length === 0) {
      const required = hasAmounts ? (BigInt(request.amounts[i]) * units).toString() : "0"
      balances.push({ token: tokenAddr, balance: "0", required, sufficient: false })
      allSufficient = false
      continue
    }

    const decoded = decodeFunctionResult({
      abi: erc20Abi,
      functionName: "balanceOf",
      data: bytesToHex(result.data),
    }) as bigint

    const balance = decoded
    // Calculate required: amountPerUnit * units
    const required = hasAmounts ? BigInt(request.amounts[i]) * units : 0n
    const sufficient = hasAmounts ? balance >= required : balance > 0n

    balances.push({
      token: tokenAddr,
      balance: balance.toString(),
      required: required.toString(),
      sufficient,
    })

    runtime.log(`Token ${tokenAddr}: balance=${balance}, required=${required}, sufficient=${sufficient}`)

    if (!sufficient) {
      allSufficient = false
    }
  }

  const response = JSON.stringify({
    verified: allSufficient,
    address: userAddr,
    units: units.toString(),
    balances,
  })

  runtime.log(`Verification result: ${response}`)
  return response
}

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
