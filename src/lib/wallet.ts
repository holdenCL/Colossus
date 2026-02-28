import {
  createWalletClient,
  createPublicClient,
  custom,
  http,
  formatEther,
  type WalletClient,
  type PublicClient,
  type Address,
  type Chain,
} from "viem";
import { sepolia, baseSepolia } from "viem/chains";
import EthereumProvider from "@walletconnect/ethereum-provider";
import QRCode from "qrcode";

export interface WalletState {
  address: Address | null;
  balance: string;
  chainId: number | null;
  connected: boolean;
  connecting: boolean;
  error: string;
}

export const defaultState: WalletState = {
  address: null,
  balance: "0",
  chainId: null,
  connected: false,
  connecting: false,
  error: "",
};

// ─── Chain lookup: chainId → viem Chain object ───
const SUPPORTED_CHAINS: Record<number, Chain> = {
  [sepolia.id]: sepolia,
  [baseSepolia.id]: baseSepolia,
};

export const CHAIN_NAMES: Record<number, string> = {
  [sepolia.id]: "Sepolia",
  [baseSepolia.id]: "Base Sepolia",
};

const CHAIN_RPCS: Record<number, string> = {
  [sepolia.id]: "https://ethereum-sepolia-rpc.publicnode.com",
  [baseSepolia.id]: "https://sepolia.base.org",
};

const WC_PROJECT_ID = "aae48e689425edf12baf0166bad326cb";

let walletClient: WalletClient | null = null;
let publicClient: PublicClient | null = null;
let wcProvider: InstanceType<typeof EthereumProvider> | null = null;
let currentUri: string = "";
let isConnecting: boolean = false;
let walletChainId: number | null = null;

// ─── Track which connection method is active ───
// "injected" = browser extension (MetaMask, etc.)
// "walletconnect" = QR code / mobile wallet (OneKey, etc.)
// null = not connected
let connectionMode: "injected" | "walletconnect" | null = null;

// ─── Chain-change callback ───
let chainChangeHandler: ((chainId: number) => void) | null = null;

export function onChainChanged(handler: (chainId: number) => void) {
  chainChangeHandler = handler;
}

// ═══════════════════════════════════════════════════════════════════
// ─── Environment Detection ───────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════

/**
 * Check if a browser wallet extension (MetaMask, etc.) is available.
 *
 * How this works:
 * - Browser wallet extensions inject a global `window.ethereum` object
 *   into every page. This is the EIP-1193 "injected provider" standard.
 * - In Tauri (desktop app), there's no browser extension environment,
 *   so window.ethereum will be undefined.
 * - We also check window.__TAURI__ to be extra safe — if we're inside
 *   Tauri, we always use WalletConnect even if something weird is on window.
 */
export function hasInjectedProvider(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as any).ethereum !== "undefined" &&
    typeof (window as any).__TAURI__ === "undefined"
  );
}

/**
 * Recreate viem clients for the given chain.
 * Called on initial connect AND on wallet-side chain switches.
 */
function rebuildClients(chainId: number) {
  const chain = SUPPORTED_CHAINS[chainId];
  if (!chain) {
    console.warn(`[Colossus] Unsupported chain: ${chainId}`);
    return;
  }

  console.log(`[Colossus] Building clients for ${CHAIN_NAMES[chainId]} (${chainId}) [${connectionMode}]`);

  // Pick the right transport based on connection mode
  const writeTransport =
    connectionMode === "injected"
      ? custom((window as any).ethereum)
      : wcProvider
        ? custom(wcProvider)
        : http(CHAIN_RPCS[chainId]); // fallback, shouldn't happen

  walletClient = createWalletClient({
    chain,
    transport: writeTransport,
  });

  // Reads always use HTTP — more reliable than routing through the wallet
  publicClient = createPublicClient({
    chain,
    transport: http(CHAIN_RPCS[chainId]),
  });
}

// ═══════════════════════════════════════════════════════════════════
// ─── Injected Provider Connection (MetaMask in browser) ──────────
// ═══════════════════════════════════════════════════════════════════

/**
 * Connect via browser extension (MetaMask, Rabby, Coinbase Wallet, etc.)
 *
 * This is the standard EIP-1193 flow:
 * 1. Call ethereum.request({ method: 'eth_requestAccounts' })
 *    → MetaMask popup appears asking user to approve
 * 2. On approval, we get the user's address
 * 3. Build viem clients using window.ethereum as transport
 *
 * No QR codes, no WalletConnect relay servers, no deep links.
 * The extension IS the wallet — it lives right in the browser.
 */
export async function connectInjected(): Promise<WalletState> {
  try {
    const ethereum = (window as any).ethereum;
    if (!ethereum) {
      return { ...defaultState, error: "No wallet extension detected" };
    }

    console.log("[Colossus] Connecting via injected provider (MetaMask)...");
    connectionMode = "injected";

    // This triggers the MetaMask popup — user sees "Connect to localhost:5173?"
    const accounts: Address[] = await ethereum.request({
      method: "eth_requestAccounts",
    });

    if (!accounts || accounts.length === 0) {
      connectionMode = null;
      return { ...defaultState, error: "No accounts returned" };
    }

    // Get current chain from MetaMask
    const rawChainId: string = await ethereum.request({ method: "eth_chainId" });
    const chainId = parseInt(rawChainId, 16); // MetaMask returns hex like "0xaa36a7"

    if (!SUPPORTED_CHAINS[chainId]) {
      // User is on the wrong network — ask MetaMask to switch to Sepolia
      console.log(`[Colossus] Wrong chain (${chainId}), requesting switch to Sepolia...`);
      try {
        await ethereum.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: "0xaa36a7" }], // Sepolia = 11155111 = 0xaa36a7
        });
      } catch (switchErr: any) {
        connectionMode = null;
        return {
          ...defaultState,
          error: `Please switch MetaMask to Sepolia (chain switch failed: ${switchErr.message})`,
        };
      }
    }

    // Re-read chain after potential switch
    const finalRawChainId: string = await ethereum.request({ method: "eth_chainId" });
    const finalChainId = parseInt(finalRawChainId, 16);
    walletChainId = finalChainId;

    rebuildClients(finalChainId);

    const address = accounts[0];
    const balanceWei = await publicClient!.getBalance({ address });
    const balance = formatEther(balanceWei);

    console.log("[Colossus] Connected via MetaMask:", address, "on chain", finalChainId);

    // ─── Listen for MetaMask events ───

    // Chain changes (user switches network in MetaMask)
    ethereum.on("chainChanged", (hexChainId: string) => {
      const newChainId = parseInt(hexChainId, 16);
      console.log(`[Colossus] MetaMask chain changed → ${newChainId} (${CHAIN_NAMES[newChainId] || "unknown"})`);

      if (!SUPPORTED_CHAINS[newChainId]) {
        console.warn(`[Colossus] Unsupported chain ${newChainId} — ignoring`);
        return;
      }

      walletChainId = newChainId;
      rebuildClients(newChainId);

      if (chainChangeHandler) {
        chainChangeHandler(newChainId);
      }
    });

    // Account changes (user switches account in MetaMask)
    ethereum.on("accountsChanged", (newAccounts: Address[]) => {
      console.log("[Colossus] MetaMask account changed:", newAccounts[0] || "disconnected");
      if (!newAccounts || newAccounts.length === 0) {
        // User disconnected from MetaMask side
        disconnectWallet();
      }
      // For a full implementation you'd update the wallet state here,
      // but for the hackathon demo, a page refresh handles this fine.
    });

    return {
      address,
      balance,
      chainId: finalChainId,
      connected: true,
      connecting: false,
      error: "",
    };
  } catch (err: any) {
    console.error("[Colossus] Injected connection error:", err);
    connectionMode = null;
    return {
      ...defaultState,
      error: err.message || "MetaMask connection failed",
    };
  }
}

// ═══════════════════════════════════════════════════════════════════
// ─── WalletConnect Connection (Tauri / Mobile Wallets) ───────────
// ═══════════════════════════════════════════════════════════════════

/**
 * Connect via WalletConnect (QR code flow).
 * This is the existing flow — unchanged from the working Tauri version.
 */
export async function connectWallet(
  onQrCode: (dataUrl: string) => void
): Promise<WalletState> {
  try {
    console.log("[Colossus] Initializing WalletConnect provider...");
    connectionMode = "walletconnect";

    // Clear any stale WalletConnect sessions
    try {
      const keys = Object.keys(localStorage).filter(k =>
        k.startsWith("wc@") || k.startsWith("wc_") || k.includes("walletconnect")
      );
      keys.forEach(k => localStorage.removeItem(k));
    } catch {}

    wcProvider = await EthereumProvider.init({
      projectId: WC_PROJECT_ID,
      chains: [sepolia.id],
      showQrModal: false,
      metadata: {
        name: "Colossus",
        description: "Cross-chain token basket manager",
        url: "http://localhost:5173",
        icons: [],
      },
    });

    wcProvider.on("display_uri", async (uri: string) => {
      console.log("[Colossus] Got WalletConnect URI");
      currentUri = uri;
      const dataUrl = await QRCode.toDataURL(uri, {
        width: 280,
        margin: 2,
        color: {
          dark: "#e0e0e0",
          light: "#1a1a2e",
        },
      });
      onQrCode(dataUrl);
    });

    wcProvider.on("connect", () => {
      console.log("[Colossus] Session established!");
    });

    // ─── Listen for wallet-side chain switches ───
    wcProvider.on("chainChanged", (rawChainId: string | number) => {
      if (isConnecting) return;

      const chainId = typeof rawChainId === "string"
        ? parseInt(rawChainId, rawChainId.startsWith("0x") ? 16 : 10)
        : rawChainId;

      console.log(`[Colossus] Chain changed → ${chainId} (${CHAIN_NAMES[chainId] || "unknown"})`);

      if (!SUPPORTED_CHAINS[chainId]) {
        console.warn(`[Colossus] Unsupported chain ${chainId} — ignoring`);
        return;
      }

      walletChainId = chainId;
      rebuildClients(chainId);

      if (chainChangeHandler) {
        chainChangeHandler(chainId);
      }
    });

    console.log("[Colossus] Calling provider.enable()...");
    isConnecting = true;
    await wcProvider.enable();
    isConnecting = false;

    const chainId = sepolia.id;
    walletChainId = chainId;
    rebuildClients(chainId);

    const [address] = await walletClient!.getAddresses();
    console.log("[Colossus] Connected:", address, "on chain", chainId);

    const balanceWei = await publicClient!.getBalance({ address });
    const balance = formatEther(balanceWei);

    return {
      address,
      balance,
      chainId,
      connected: true,
      connecting: false,
      error: "",
    };
  } catch (err: any) {
    console.error("[Colossus] Connection error:", err);
    connectionMode = null;
    return {
      ...defaultState,
      error: err.message || "Connection failed",
    };
  }
}

// ═══════════════════════════════════════════════════════════════════
// ─── Shared Functions (work with both connection modes) ──────────
// ═══════════════════════════════════════════════════════════════════

export async function openInWallet(wallet: "onekey" | "metamask") {
  if (!currentUri) {
    console.warn("[Colossus] No WalletConnect URI available yet");
    return;
  }

  const encoded = encodeURIComponent(currentUri);
  let deeplink: string;

  switch (wallet) {
    case "onekey":
      deeplink = `onekey-wallet://wc?uri=${encoded}`;
      break;
    case "metamask":
      deeplink = `metamask://wc?uri=${encoded}`;
      break;
  }

  console.log("[Colossus] Opening deeplink for", wallet);

  const a = document.createElement("a");
  a.href = deeplink;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

export async function copyUri(): Promise<boolean> {
  if (!currentUri) return false;
  await navigator.clipboard.writeText(currentUri);
  return true;
}

export async function disconnectWallet(): Promise<void> {
  if (connectionMode === "walletconnect" && wcProvider) {
    await wcProvider.disconnect();
    wcProvider = null;
  }
  // For injected providers, there's no "disconnect" API —
  // the extension stays connected. We just clear our local state.

  walletClient = null;
  publicClient = null;
  currentUri = "";
  chainChangeHandler = null;
  connectionMode = null;
}

export async function refreshBalance(address: Address): Promise<string> {
  if (!publicClient) return "0";
  const balanceWei = await publicClient.getBalance({ address });
  return formatEther(balanceWei);
}

export function getPublicClient(): PublicClient | null {
  return publicClient;
}

export function getWalletClient(): WalletClient | null {
  return walletClient;
}

export function getChainName(chainId: number | null): string {
  if (!chainId) return "—";
  return CHAIN_NAMES[chainId] || `Chain ${chainId}`;
}

export function getWalletChainId(): number | null {
  return walletChainId;
}

export async function switchChain(chainId: number): Promise<void> {
  if (!SUPPORTED_CHAINS[chainId]) throw new Error(`Unsupported chain: ${chainId}`);

  const chain = SUPPORTED_CHAINS[chainId];

  // If using MetaMask, ask the extension to switch
  // This triggers a MetaMask popup: "Allow this site to switch the network?"
  if (connectionMode === "injected") {
    const ethereum = (window as any).ethereum;
    if (ethereum) {
      await ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: `0x${chainId.toString(16)}` }],
      });
      // The chainChanged listener will handle rebuilding clients
      return;
    }
  }

  // WalletConnect path (existing behavior)
  publicClient = createPublicClient({
    chain,
    transport: http(CHAIN_RPCS[chainId]),
  });

  if (wcProvider) {
    walletClient = createWalletClient({
      chain,
      transport: custom(wcProvider),
    });
    walletChainId = chainId;
  }

  if (chainChangeHandler) {
    chainChangeHandler(chainId);
  }
}
