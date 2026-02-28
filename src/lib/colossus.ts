import {
  formatUnits,
  parseUnits,
  maxUint256,
  type Address,
  type Hash,
} from "viem";
import { getPublicClient, getWalletClient, getWalletChainId } from "./wallet";
import { BasketFactoryABI, ERC20ABI, CCIPBasketBridgeABI } from "./abis";
import { CHAINS, type ChainContracts } from "./contracts";

// ─── Helpers: resolve chain contracts from connected wallet ───

function getChainContracts(): ChainContracts {
  const pub = getPublicClient();
  if (!pub?.chain?.id) throw new Error("Not connected");
  const c = CHAINS[pub.chain.id];
  if (!c) throw new Error(`Unsupported chain: ${pub.chain.id}`);
  return c;
}

// --- Read Functions ---

export async function getNextBasketId(): Promise<number> {
  const pub = getPublicClient();
  if (!pub) throw new Error("Not connected");
  const cc = getChainContracts();

  const id = await pub.readContract({
    address: cc.basketFactory,
    abi: BasketFactoryABI,
    functionName: "nextBasketId",
  });
  return Number(id);
}

// ─── V2 CHANGE: returns 4 values (name, creator, componentCount, hasNFT) ───
export async function getBasketInfo(basketId: bigint) {
  const pub = getPublicClient();
  if (!pub) throw new Error("Not connected");
  const cc = getChainContracts();

  const [name, creator, componentCount, hasNFT] = await pub.readContract({
    address: cc.basketFactory,
    abi: BasketFactoryABI,
    functionName: "getBasketInfo",
    args: [basketId],
  });
  return { name, creator, componentCount: Number(componentCount), hasNFT };
}

// ─── V2 CHANGE: components now include standard + tokenId ───
export async function getComponents(basketId: bigint) {
  const pub = getPublicClient();
  if (!pub) throw new Error("Not connected");
  const cc = getChainContracts();

  return await pub.readContract({
    address: cc.basketFactory,
    abi: BasketFactoryABI,
    functionName: "getComponents",
    args: [basketId],
  });
}

export async function getBasketBalance(
  account: Address,
  basketId: bigint
): Promise<bigint> {
  const pub = getPublicClient();
  if (!pub) throw new Error("Not connected");
  const cc = getChainContracts();

  return await pub.readContract({
    address: cc.basketFactory,
    abi: BasketFactoryABI,
    functionName: "balanceOf",
    args: [account, basketId],
  });
}

export async function getTokenBalance(
  token: Address,
  account: Address
): Promise<bigint> {
  const pub = getPublicClient();
  if (!pub) throw new Error("Not connected");

  return await pub.readContract({
    address: token,
    abi: ERC20ABI,
    functionName: "balanceOf",
    args: [account],
  });
}

export async function getTokenSymbol(token: Address): Promise<string> {
  const pub = getPublicClient();
  if (!pub) throw new Error("Not connected");

  return await pub.readContract({
    address: token,
    abi: ERC20ABI,
    functionName: "symbol",
  });
}

export async function getTokenDecimals(token: Address): Promise<number> {
  const pub = getPublicClient();
  if (!pub) throw new Error("Not connected");

  return await pub.readContract({
    address: token,
    abi: ERC20ABI,
    functionName: "decimals",
  });
}

export async function getAllowance(
  token: Address,
  owner: Address,
  spender: Address
): Promise<bigint> {
  const pub = getPublicClient();
  if (!pub) throw new Error("Not connected");

  return await pub.readContract({
    address: token,
    abi: ERC20ABI,
    functionName: "allowance",
    args: [owner, spender],
  });
}

// --- Write Functions ---

export async function approveToken(
  token: Address,
  spender: Address
): Promise<Hash> {
  const wallet = getWalletClient();
  const pub = getPublicClient();
  if (!wallet || !pub) throw new Error("Not connected");

  const [account] = await wallet.getAddresses();

  const hash = await wallet.writeContract({
    address: token,
    abi: ERC20ABI,
    functionName: "approve",
    args: [spender, maxUint256],
    account,
    chain: wallet.chain,
  });

  await pub.waitForTransactionReceipt({ hash });
  return hash;
}

// ─── V2 CHANGE: createBasket now takes standards[] and tokenIds[] ───
export async function createBasket(
  name: string,
  tokens: Address[],
  standards: number[],      // V2: 0=ERC20 for all (hackathon)
  tokenIds: bigint[],       // V2: 0n for all ERC-20
  amounts: bigint[]
): Promise<Hash> {
  const wallet = getWalletClient();
  const pub = getPublicClient();
  if (!wallet || !pub) throw new Error("Not connected");
  const cc = getChainContracts();

  const [account] = await wallet.getAddresses();

  const hash = await wallet.writeContract({
    address: cc.basketFactory,
    abi: BasketFactoryABI,
    functionName: "createBasket",
    args: [name, tokens, standards, tokenIds, amounts],
    account,
    chain: wallet.chain,
  });

  await pub.waitForTransactionReceipt({ hash });
  return hash;
}

export async function weave(
  basketId: bigint,
  units: bigint,
  linkFee: bigint
): Promise<Hash> {
  const wallet = getWalletClient();
  const pub = getPublicClient();
  if (!wallet || !pub) throw new Error("Not connected");
  const cc = getChainContracts();

  const [account] = await wallet.getAddresses();

  const hash = await wallet.writeContract({
    address: cc.basketFactory,
    abi: BasketFactoryABI,
    functionName: "weave",
    args: [basketId, units, linkFee],
    account,
    chain: wallet.chain,
    gas: 500_000n,
  });

  await pub.waitForTransactionReceipt({ hash });
  return hash;
}

export async function unweave(
  basketId: bigint,
  units: bigint
): Promise<Hash> {
  const wallet = getWalletClient();
  const pub = getPublicClient();
  if (!wallet || !pub) throw new Error("Not connected");
  const cc = getChainContracts();

  const [account] = await wallet.getAddresses();

  const hash = await wallet.writeContract({
    address: cc.basketFactory,
    abi: BasketFactoryABI,
    functionName: "unweave",
    args: [basketId, units],
    account,
    chain: wallet.chain,
  });

  await pub.waitForTransactionReceipt({ hash });
  return hash;
}

/** Send ERC-1155 basket tokens via safeTransferFrom */
export async function sendBasketToken(
  from: Address,
  to: Address,
  basketId: bigint,
  units: bigint
): Promise<Hash> {
  const wallet = getWalletClient();
  const pub = getPublicClient();
  if (!wallet || !pub) throw new Error("Not connected");
  const cc = getChainContracts();

  const hash = await wallet.writeContract({
    address: cc.basketFactory,
    abi: BasketFactoryABI,
    functionName: "safeTransferFrom",
    args: [from, to, basketId, units, "0x"],
    account: from,
    chain: wallet.chain,
  });

  await pub.waitForTransactionReceipt({ hash });
  return hash;
}

// --- Helpers ---

/** Check & approve both component tokens to Escrow and LINK to Factory */
export async function ensureApprovals(
  account: Address,
  tokens: Address[],
  amounts: bigint[],
  units: bigint,
  onStatus: (msg: string) => void
): Promise<void> {
  const cc = getChainContracts();

  // Approve component tokens to Escrow
  for (let i = 0; i < tokens.length; i++) {
    const needed = amounts[i] * units;
    const allowance = await getAllowance(tokens[i], account, cc.escrow);
    const symbol = await getTokenSymbol(tokens[i]);

    if (allowance < needed) {
      onStatus(`Approving ${symbol} for Escrow...`);
      await approveToken(tokens[i], cc.escrow);
      onStatus(`${symbol} approved ✓`);
    }
  }

  // Approve LINK to Factory (for fee)
  const linkAllowance = await getAllowance(
    cc.link,
    account,
    cc.basketFactory
  );

  if (linkAllowance === 0n) {
    onStatus("Approving LINK for fees...");
    await approveToken(cc.link, cc.basketFactory);
    onStatus("LINK approved ✓");
  }
}

/** Get the LINK token address for the current chain */
export function getChainLinkAddress(): Address {
  return getChainContracts().link;
}

/** Get the current connected chain ID */
export function getConnectedChainId(): 11155111 | 84532 | 80002 {
  const pub = getPublicClient();
  if (!pub?.chain?.id) throw new Error("Not connected");
  return pub.chain.id as 11155111 | 84532 | 80002;
}

// ═══════════════════════════════════════════════════════════════════
// ─── CCIP Bridge Functions (Phase 6) ─────────────────────────────
// ═══════════════════════════════════════════════════════════════════

/** Check if the bridge contract is approved to transfer user's ERC-1155 baskets */
export async function isBridgeApproved(owner: Address): Promise<boolean> {
  const pub = getPublicClient();
  if (!pub) throw new Error("Not connected");
  const cc = getChainContracts();

  return await pub.readContract({
    address: cc.basketFactory,
    abi: BasketFactoryABI,
    functionName: "isApprovedForAll",
    args: [owner, cc.bridge],
  });
}

/** Approve the bridge to transfer user's ERC-1155 baskets (setApprovalForAll) */
export async function approveBridge(): Promise<Hash> {
  const wallet = getWalletClient();
  const pub = getPublicClient();
  if (!wallet || !pub) throw new Error("Not connected");
  const cc = getChainContracts();
  const [account] = await wallet.getAddresses();

  const hash = await wallet.writeContract({
    address: cc.basketFactory,
    abi: BasketFactoryABI,
    functionName: "setApprovalForAll",
    args: [cc.bridge, true],
    account,
    chain: wallet.chain,
  });

  await pub.waitForTransactionReceipt({ hash });
  return hash;
}

/** Estimate CCIP fee in LINK for bridging a basket */
export async function getBridgeFee(
  basketId: bigint,
  units: bigint,
  destChainSelector: bigint
): Promise<bigint> {
  const pub = getPublicClient();
  if (!pub) throw new Error("Not connected");
  const cc = getChainContracts();

  return await pub.readContract({
    address: cc.bridge,
    abi: CCIPBasketBridgeABI,
    functionName: "getFee",
    args: [basketId, units, destChainSelector],
  });
}

/**
 * Bridge basket tokens cross-chain via CCIP.
 *
 * Flow:
 * 1. Check & set ERC-1155 approval for bridge (setApprovalForAll)
 * 2. Check & approve LINK to bridge for CCIP fees
 * 3. Call bridge.sendBasket() → burns basket on source, sends CCIP message
 *
 * The destination bridge receives the message and mints basket tokens to recipient.
 */
export async function sendBasketCrossChain(
  basketId: bigint,
  units: bigint,
  destChainSelector: bigint,
  recipient: Address,
  onStatus: (msg: string) => void
): Promise<Hash> {
  const wallet = getWalletClient();
  const pub = getPublicClient();
  if (!wallet || !pub) throw new Error("Not connected");
  const cc = getChainContracts();
  const [account] = await wallet.getAddresses();

  // 1. ERC-1155 approval for bridge
  const approved = await isBridgeApproved(account);
  if (!approved) {
    onStatus("Approving bridge for basket transfers...");
    await approveBridge();
    onStatus("Bridge approved ✓");
  }

  // 2. LINK approval for bridge (CCIP fees)
  const fee = await getBridgeFee(basketId, units, destChainSelector);
  const linkAllowance = await getAllowance(cc.link, account, cc.bridge);
  if (linkAllowance < fee) {
    onStatus("Approving LINK for CCIP fees...");
    await approveToken(cc.link, cc.bridge);
    onStatus("LINK approved ✓");
  }

  // 3. Send cross-chain
  onStatus("Sending basket cross-chain via CCIP...");
  const hash = await wallet.writeContract({
    address: cc.bridge,
    abi: CCIPBasketBridgeABI,
    functionName: "sendBasket",
    args: [basketId, units, destChainSelector, recipient],
    account,
    chain: wallet.chain,
  });

  await pub.waitForTransactionReceipt({ hash });
  return hash;
}
/**
 * Unweave a bridged basket on a remote chain.
 * Burns basket tokens here, sends CCIP message to home chain to release from escrow.
 * ERC-20 components are forwarded back via CCIP second-hop.
 */
export async function unweaveRemote(
  basketId: bigint,
  units: bigint,
  homeChainSelector: bigint,
  releaseRecipient: Address,
  onStatus: (msg: string) => void
): Promise<Hash> {
  const wallet = getWalletClient();
  const pub = getPublicClient();
  if (!wallet || !pub) throw new Error("Not connected");
  const cc = getChainContracts();
  const [account] = await wallet.getAddresses();

  // 1. ERC-1155 approval for bridge (needs to burn basket tokens)
  const approved = await isBridgeApproved(account);
  if (!approved) {
    onStatus("Approving bridge for basket transfers...");
    await approveBridge();
    onStatus("Bridge approved ✓");
  }

  // 2. LINK approval for bridge (CCIP fees for unweave message)
  const fee = await getBridgeFee(basketId, units, homeChainSelector);
  const linkAllowance = await getAllowance(cc.link, account, cc.bridge);
  if (linkAllowance < fee) {
    onStatus("Approving LINK for CCIP fees...");
    await approveToken(cc.link, cc.bridge);
    onStatus("LINK approved ✓");
  }

  // 3. Send unweave request to home chain
  onStatus("Sending cross-chain unweave request via CCIP...");
  const hash = await wallet.writeContract({
    address: cc.bridge,
    abi: CCIPBasketBridgeABI,
    functionName: "unweaveRemote",
    args: [basketId, units, homeChainSelector, releaseRecipient],
    account,
    chain: wallet.chain,
    gas: 500_000n
  });

  await pub.waitForTransactionReceipt({ hash });
  return hash;
}