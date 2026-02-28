// CCC (Chainlink Confidential Compute) — Private balance reader
// Uses the Compliant Private Token Demo vault API on Sepolia
// Proxied through cre-bridge.ts to avoid browser CORS restrictions

import type { WalletClient } from 'viem';

const CRE_BRIDGE_URL = 'http://localhost:3456';

const CCC_VAULT = '0xE588a6c73933BFD66Af9b4A07d48bcE59c0D2d13' as const;

const CCC_DOMAIN = {
  name: 'CompliantPrivateTokenDemo',
  version: '0.0.1',
  chainId: 11155111,
  verifyingContract: CCC_VAULT,
} as const;

const BALANCE_TYPES = {
  'Retrieve Balances': [
    { name: 'account', type: 'address' },
    { name: 'timestamp', type: 'uint256' },
  ],
} as const;

// Known token symbols for display
const CCC_TOKEN_SYMBOLS: Record<string, string> = {
  '0x779877a7b0d9e8603169ddbd7836e478b4624789': 'LINK',
  '0xfff9976782d46cc05630d1f6ebab18b2324d6b14': 'WETH',
};

export interface CccBalance {
  token: string;
  symbol: string;
  amount: string;       // raw wei
  formatted: string;    // human-readable (18 decimals)
}

/**
 * Fetch private balances from the CCC vault API (proxied via cre-bridge).
 * Requires the user to sign an EIP-712 message.
 * Only works on Sepolia (chainId 11155111).
 */
export async function fetchCccBalances(
  walletClient: WalletClient,
  address: `0x${string}`
): Promise<CccBalance[]> {
  const timestamp = Math.floor(Date.now() / 1000);

  // Sign EIP-712 typed data
  const auth = await walletClient.signTypedData({
    account: address,
    domain: CCC_DOMAIN,
    types: BALANCE_TYPES,
    primaryType: 'Retrieve Balances',
    message: {
      account: address,
      timestamp: BigInt(timestamp),
    },
  });

  // POST to CRE bridge proxy (avoids CORS)
  const res = await fetch(`${CRE_BRIDGE_URL}/ccc-balances`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      account: address,
      timestamp,
      auth,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error_details || (err as any).error || `CCC API error: ${res.status}`);
  }

  const data = await res.json() as { balances?: { token: string; amount: string }[] };

  return (data.balances || []).map((b) => {
    const tokenLower = b.token.toLowerCase();
    const symbol = CCC_TOKEN_SYMBOLS[tokenLower] || 'UNKNOWN';
    const raw = BigInt(b.amount);
    const whole = raw / 10n ** 18n;
    const frac = raw % 10n ** 18n;
    const formatted = `${whole}.${frac.toString().padStart(18, '0').slice(0, 4)}`;
    return {
      token: b.token,
      symbol,
      amount: b.amount,
      formatted,
    };
  });
}
