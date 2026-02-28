<script lang="ts">
  import {
    connectWallet,
    connectInjected,
    hasInjectedProvider,
    disconnectWallet,
    openInWallet,
    copyUri,
    defaultState,
    type WalletState,
  } from "./lib/wallet";
  import {
    onChainChanged,
    getChainName,
    switchChain,
  } from "./lib/wallet";
  import {
    createBasket,
    weave,
    unweave,
    sendBasketToken,
    ensureApprovals,
    getNextBasketId,
    getBasketInfo,
    getComponents,
    getBasketBalance,
    getTokenBalance,
    getTokenSymbol,
    getTokenDecimals,
    sendBasketCrossChain,
    getBridgeFee,
    getChainLinkAddress,
    unweaveRemote,
    getConnectedChainId,
  } from "./lib/colossus";
  import { parseUnits, formatUnits, createPublicClient, createWalletClient, custom, http, formatEther, type Address } from "viem";
  import { sepolia, baseSepolia } from "viem/chains";
  import { getTokenUsdPrice, calculateFeeInLink } from "./lib/priceFeed";
  import { fetchCccBalances, type CccBalance } from "./lib/ccc";
  import { open } from "@tauri-apps/plugin-shell";
  import { DEFAULTS, BRIDGE_DESTINATIONS, CHAIN_IDS, CHAIN_SELECTORS } from "./lib/contracts";

  // --- Wallet State ---
  let wallet: WalletState = $state({ ...defaultState });
  let qrCodeUrl: string = $state("");
  let copied: boolean = $state(false);

  // --- UI State ---
  let activeTab: "weave" | "splice" | "unweave" | "send" | "bridge" | "portfolio" = $state("weave");
  let status: string = $state("");
  let busy: boolean = $state(false);

  // --- Weave Basket (Create + First Deposit) ---
  type WeaveComponent = { address: string; amount: string; symbol: string };
  let weaveName: string = $state("");
  let weaveComponents: WeaveComponent[] = $state([
    { address: DEFAULTS.link, amount: "1", symbol: "LINK" }
  ]);
  let weaveInitialUnits: string = $state("1");
  let weaveFeeEstimate: string = $state("0");

  function addWeaveComponent() {
    weaveComponents = [...weaveComponents, { address: "", amount: "1", symbol: "" }];
  }

  function removeWeaveComponent(index: number) {
    weaveComponents = weaveComponents.filter((_, i) => i !== index);
    recalcWeaveFee();
  }

  async function resolveTokenSymbol(index: number) {
    const addr = weaveComponents[index].address;
    if (!addr || addr.length < 42) {
      weaveComponents[index].symbol = "";
      return;
    }
    try {
      const symbol = await getTokenSymbol(addr as Address);
      weaveComponents[index].symbol = symbol;
      weaveComponents = [...weaveComponents]; // trigger reactivity
    } catch {
      weaveComponents[index].symbol = "???";
    }
    recalcWeaveFee();
  }
  
  // --- Splice Basket (Subsequent Deposits) ---
  let spliceBasketId: string = $state("1");
  let spliceUnits: string = $state("1");
  let spliceLinkFee: string = $state("0");

  // --- Unweave ---
  let unweaveBasketId: string = $state("1");
  let unweaveUnits: string = $state("1");

  // --- Send ---
  let sendBasketId: string = $state("1");
  let sendRecipient: string = $state("");
  let sendUnits: string = $state("1");

  // --- Bridge (CCIP Cross-Chain) ---
  let bridgeBasketId: string = $state("1");
  let bridgeUnits: string = $state("1");
  let bridgeRecipient: string = $state("");
  let bridgeDestIndex: number = $state(0);
  let bridgeFeeEstimate: string = $state("—");
  let bridgeFeeLoading: boolean = $state(false);
  let bridgeTxHash: string = $state("");
  let bridgeSuccessLink: string = $state("");

  // --- Basket Info (shared by Splice + Unweave) ---
  let basketInfo: { name: string; creator: string; componentCount: number; hasNFT: boolean } | null = $state(null);
  let basketComponents: readonly { token: Address; standard: number; tokenId: bigint; amount: bigint }[] | null = $state(null);
  let basketBalance: string = $state("0");
  let linkBalance: string = $state("0");

  // --- NAV Display ---
  let basketNavPerUnit: number = $state(0);
  let basketNavTotal: number = $state(0);
  let componentBreakdown: { token: Address; symbol: string; amount: string; usdValue: number }[] = $state([]);
  let navLoading: boolean = $state(false);

  // --- CRE Verification ---
  let creVerifyResult: {
    verified: boolean;
    address: string;
    units: string;
    balances: { token: string; balance: string; required: string; sufficient: boolean }[];
  } | null = $state(null);
  let creVerifyError: string = $state("");
  let creVerifyLoading: boolean = $state(false);
  let creVerifyRaw: string = $state("");

  // --- CRE Analysis ---
  let creAnalysisResult: {
    basketId: number;
    basketName: string;
    creator: string;
    chain: string;
    componentCount: number;
    components: {
      token: string;
      symbol: string;
      decimals: number;
      amount: number;
      rawAmount: string;
      mainnetEquivalent: string | null;
      analytics: any;
    }[];
    aiAnalysis: string;
  } | null = $state(null);
  let creAnalysisError: string = $state("");
  let creAnalysisLoading: boolean = $state(false);
  let creAnalysisBasketId: number | null = $state(null); // tracks which basket is being analyzed

  // --- CRE NAV Verification ---
  let creNavResults: { basketId: number; basketName: string; data: any; error?: string }[] = $state([]);
  let creNavLoading: boolean = $state(false);

  // --- Portfolio ---
  type PortfolioEntry = {
    basketId: bigint;
    name: string;
    balance: number;
    navPerUnit: number;
    totalValue: number;
    components: { symbol: string; amount: string; usdPrice: number }[];
  };
  let portfolio: PortfolioEntry[] = $state([]);
  let portfolioTotal: number = $state(0);
  let portfolioLoading: boolean = $state(false);

  // --- CCC (Chainlink Confidential Compute) ---
  let cccBalances: CccBalance[] = $state([]);
  let cccLoading: boolean = $state(false);
  let cccError: string = $state("");
  let cccSupported: boolean = $state(false); // true only on Sepolia (vault is Sepolia-only)

  // CCC — CRE workflow results (scoped to Private Holdings card)
  let cccBasketId: string = $state("5"); // default to CRE demo basket
  let cccNavLoading: boolean = $state(false);
  let cccNavResult: any = $state(null);
  let cccNavError: string = $state("");
  let cccAnalysisLoading: boolean = $state(false);
  let cccAnalysisResult: any = $state(null);
  let cccAnalysisError: string = $state("");

  /** Clear all CRE result state (called on tab switch) */
  function clearCreResults() {
    creVerifyResult = null;
    creVerifyError = "";
    creAnalysisResult = null;
    creAnalysisError = "";
    creAnalysisBasketId = null;
    creNavResults = [];
  }

  // --- Wallet Handlers ---
  async function handleConnect() {
    wallet = { ...wallet, connecting: true, error: "" };
    qrCodeUrl = "";
     copied = false;

     // Dual-path: if a browser extension wallet exists, use it directly.
     // Otherwise fall back to WalletConnect (QR code for Tauri/mobile).
     if (hasInjectedProvider()) {
       console.log("[Colossus] Browser wallet detected — using injected provider");
       wallet = await connectInjected();
     } else {
       console.log("[Colossus] No browser wallet — using WalletConnect");
       wallet = await connectWallet((dataUrl: string) => {
         qrCodeUrl = dataUrl;
       });
     }

     if (wallet.connected) {
       qrCodeUrl = "";
       onChainChanged(async (chainId: number) => {
         wallet = { ...wallet, chainId };
         basketInfo = null;
         basketComponents = null;
         basketBalance = "0";
         componentBreakdown = [];
         updateCccSupported(chainId);
         status = `Switched to ${getChainName(chainId)}`;
         try {
           const linkAddr = getChainLinkAddress();
           weaveComponents = [{ address: linkAddr, amount: "1", symbol: "LINK" }];
         } catch {}
         await refreshBalances();
       });
       updateCccSupported(wallet.chainId || 11155111);
       await refreshBalances();
     }
   }

  async function handleDisconnect() {
    await disconnectWallet();
    wallet = { ...defaultState };
    qrCodeUrl = "";
    basketInfo = null;
    basketComponents = null;
    componentBreakdown = [];
    linkBalance = "0";
    weaveComponents = [{ address: DEFAULTS.link, amount: "1", symbol: "LINK" }];
  }

  function handleCancelConnect() {
    disconnectWallet();
    wallet = { ...defaultState };
    qrCodeUrl = "";
  }

  async function handleCopy() {
    const ok = await copyUri();
    if (ok) {
      copied = true;
      setTimeout(() => (copied = false), 2000);
    }
  }

  function shortenAddress(addr: string): string {
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  }

  // --- Refresh ---
  async function refreshBalances() {
    if (!wallet.address) return;

    // Native ETH balance
    try {
      const chainId = getConnectedChainId();
      const chain = chainId === CHAIN_IDS.sepolia ? sepolia : baseSepolia;
      const client = createPublicClient({ chain, transport: http() });
      const ethBal = await client.getBalance({ address: wallet.address as Address });
      wallet = { ...wallet, balance: formatEther(ethBal) };
    } catch (err) {
      console.error("[Colossus] ETH balance error:", err);
    }

    // LINK balance
    try {
      const linkAddr = getChainLinkAddress();
      if (!wallet.address) throw new Error("No wallet connected");
      const bal = await getTokenBalance(linkAddr, wallet.address);
      linkBalance = formatUnits(bal, 18);
    } catch (err) {
      console.error("[Colossus] LINK balance error:", err);
      linkBalance = "?";
    }
  }

  // --- Fee Calculations ---

  // --- CCC Helpers ---
  function updateCccSupported(chainId: number) {
    cccSupported = chainId === 11155111;
    if (!cccSupported) {
      cccBalances = [];
      cccError = "";
    }
  }

  async function loadCccBalances() {
    if (!wallet.address || !cccSupported) return;
    cccLoading = true;
    cccError = "";
    try {
      const provider = (window as any).ethereum;
      if (!provider) throw new Error("No wallet provider found");
      const wc = createWalletClient({
        chain: sepolia,
        transport: custom(provider),
      });
      cccBalances = await fetchCccBalances(wc, wallet.address as `0x${string}`);
    } catch (e: any) {
      cccError = e.message || "Failed to fetch private balances";
      cccBalances = [];
    } finally {
      cccLoading = false;
    }
  }

  /** CCC card: Verify NAV via CRE bridge (confidential /nav-ccc endpoint, Sepolia-only) */
  async function handleCccNav() {
    if (!cccBasketId) return;
    cccNavLoading = true;
    cccNavResult = null;
    cccNavError = "";
    try {
      const resp = await fetch(`${CRE_BRIDGE_URL}/nav-ccc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ basketId: Number(cccBasketId), chainId: 11155111 }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        cccNavError = data.error || `Bridge returned ${resp.status}`;
      } else if (data.error) {
        cccNavError = data.error;
      } else {
        cccNavResult = data;
      }
    } catch (err: any) {
      cccNavError = err.message?.includes("Failed to fetch")
        ? "CRE Bridge not running. Start it with: bun run cre-bridge.ts"
        : err.message || "Unknown error";
    }
    cccNavLoading = false;
  }

  /** CCC card: Analyze via CRE bridge (confidential /analyze-ccc endpoint, Sepolia-only) */
  async function handleCccAnalyze() {
    if (!cccBasketId) return;
    cccAnalysisLoading = true;
    cccAnalysisResult = null;
    cccAnalysisError = "";
    try {
      const resp = await fetch(`${CRE_BRIDGE_URL}/analyze-ccc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ basketId: Number(cccBasketId), chainId: 11155111 }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        cccAnalysisError = data.error || `Bridge returned ${resp.status}`;
      } else if (data.error) {
        cccAnalysisError = data.error;
      } else {
        cccAnalysisResult = data;
      }
    } catch (err: any) {
      cccAnalysisError = err.message?.includes("Failed to fetch")
        ? "CRE Bridge not running. Start it with: bun run cre-bridge.ts"
        : err.message || "Unknown error";
    }
    cccAnalysisLoading = false;
  }

/** Weave tab: real fee via Chainlink price feeds */

  let feeTimeout: ReturnType<typeof setTimeout>;
  function debounceFee() {
    clearTimeout(feeTimeout);
    feeTimeout = setTimeout(() => recalcWeaveFee(), 500);
  }

  async function recalcWeaveFee() {
    if (!weaveInitialUnits || !/^\d+$/.test(weaveInitialUnits) || weaveComponents.length === 0) {
      weaveFeeEstimate = "0";
      return;
    }
    try {
      const chainId = getConnectedChainId();
      const units = parseInt(weaveInitialUnits);
      let totalUsd = 0;

      for (const comp of weaveComponents) {
        if (!comp.address || !comp.amount) continue;
        const amount = parseFloat(comp.amount);
        if (isNaN(amount) || amount <= 0) continue;
        const usdPrice = await getTokenUsdPrice(comp.address, chainId);
        totalUsd += usdPrice * amount * units;
      }

      const feeInLink = await calculateFeeInLink(totalUsd, chainId);
      weaveFeeEstimate = feeInLink.toFixed(6);
    } catch (err) {
      console.error("[Colossus] Fee calc error:", err);
      weaveFeeEstimate = "?";
    }
  }

/** Splice tab: real fee via Chainlink price feeds */
  async function recalcSpliceFee() {
    if (!basketComponents || !spliceUnits || !/^\d+$/.test(spliceUnits)) {
      spliceLinkFee = "0";
      return;
    }
    try {
      const chainId = getConnectedChainId();
      const units = parseInt(spliceUnits);
      let totalUsd = 0;

      for (const comp of basketComponents) {
        const usdPrice = await getTokenUsdPrice(comp.token, chainId);
        const tokenAmount = parseFloat(formatUnits(comp.amount, 18));
        totalUsd += usdPrice * tokenAmount * units;
      }

      const feeInLink = await calculateFeeInLink(totalUsd, chainId);
      spliceLinkFee = feeInLink.toFixed(6);
    } catch (err) {
      console.error("[Colossus] Splice fee calc error:", err);
      spliceLinkFee = "?";
    }
  }

  // --- CRE On-DON Verification ---
  const CRE_BRIDGE_URL = "http://localhost:3456";

  async function handleCreVerify(context: "weave" | "splice") {
    if (!wallet.address) return;

    creVerifyLoading = true;
    creVerifyResult = null;
    creVerifyError = "";
    creVerifyRaw = "";

    // Build the token list, amounts, and units based on which tab triggered the verify
    let tokenAddresses: string[] = [];
    let amounts: string[] = [];
    let units = 1;

    if (context === "weave") {
      tokenAddresses = weaveComponents.map(c => c.address).filter(Boolean);
      // Convert human-readable amounts to wei (18 decimals)
      for (const comp of weaveComponents) {
        if (!comp.address) continue;
        try {
          const decimals = await getTokenDecimals(comp.address as Address);
          amounts.push(parseUnits(comp.amount || "0", decimals).toString());
        } catch {
          amounts.push(parseUnits(comp.amount || "0", 18).toString());
        }
      }
      units = parseInt(weaveInitialUnits) || 1;
    } else if (context === "splice" && basketComponents) {
      tokenAddresses = basketComponents.map(c => c.token);
      amounts = basketComponents.map(c => c.amount.toString());
      units = parseInt(spliceUnits) || 1;
    }

    if (tokenAddresses.length === 0) {
      creVerifyError = "No tokens to verify — add at least one component";
      creVerifyLoading = false;
      return;
    }

    try {
      const resp = await fetch(`${CRE_BRIDGE_URL}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
         userAddress: wallet.address,
         tokenAddresses,
         amounts,
         units,
         chainId: getConnectedChainId(),
        }),
      });

      const data = await resp.json();

      if (!resp.ok) {
        creVerifyError = data.error || `Bridge returned ${resp.status}`;
        if (data.stderr) console.warn("[CRE] STDERR:", data.stderr);
        if (data.stdout) console.warn("[CRE] STDOUT:", data.stdout);
      } else if (data.verified !== undefined) {
        creVerifyResult = data;
      } else if (data.error) {
        creVerifyError = data.error;
      } else {
        creVerifyError = "Unexpected response from CRE bridge";
        console.warn("[CRE] Response:", data);
      }
    } catch (err: any) {
      if (err.message?.includes("Failed to fetch") || err.message?.includes("NetworkError")) {
        creVerifyError = "CRE Bridge not running. Start it with: bun run cre-bridge.ts";
      } else {
        creVerifyError = err.message || "Unknown error";
      }
      console.error("[CRE] Fetch error:", err);
    }

    creVerifyLoading = false;
  }

  /** Format CRE balance entry to human-readable */
  function formatCreBalance(bal: { token: string; balance: string; required: string; sufficient: boolean }): string {
    const comp = weaveComponents.find(c => c.address.toLowerCase() === bal.token.toLowerCase());
    const symbol = comp?.symbol || `${bal.token.slice(0, 6)}…${bal.token.slice(-4)}`;

    function weiToHuman(wei: string): string {
      const num = BigInt(wei);
      const whole = num / BigInt(10 ** 18);
      const frac = num % BigInt(10 ** 18);
      return frac > 0n
        ? `${whole}.${frac.toString().padStart(18, "0").slice(0, 4)}`
        : whole.toString();
    }

    const balStr = weiToHuman(bal.balance);
    const reqStr = weiToHuman(bal.required);
    const icon = bal.sufficient ? "✓" : "✗";
    return `${icon} ${symbol}: ${balStr} held / ${reqStr} required`;
  }

  // --- CRE Basket Analysis ---
  async function handleCreAnalyze(basketId: number) {
    creAnalysisLoading = true;
    creAnalysisResult = null;
    creAnalysisError = "";
    creAnalysisBasketId = basketId;

    try {
      const resp = await fetch(`${CRE_BRIDGE_URL}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ basketId, chainId: getConnectedChainId() }),
      });

      const data = await resp.json();

      if (!resp.ok) {
        creAnalysisError = data.error || `Bridge returned ${resp.status}`;
        if (data.stderr) console.warn("[CRE Analysis] STDERR:", data.stderr);
        if (data.stdout) console.warn("[CRE Analysis] STDOUT:", data.stdout);
      } else if (data.aiAnalysis !== undefined) {
        creAnalysisResult = data;
      } else if (data.error) {
        creAnalysisError = data.error;
      } else {
        creAnalysisError = "Unexpected response from CRE bridge";
        console.warn("[CRE Analysis] Response:", data);
      }
    } catch (err: any) {
      if (err.message?.includes("Failed to fetch") || err.message?.includes("NetworkError")) {
        creAnalysisError = "CRE Bridge not running. Start it with: bun run cre-bridge.ts";
      } else {
        creAnalysisError = err.message || "Unknown error";
      }
      console.error("[CRE Analysis] Fetch error:", err);
    }

    creAnalysisLoading = false;
  }

  // --- CRE NAV Verification ---
  async function handleCreNav() {
    if (portfolio.length === 0) return;

    creNavLoading = true;
    creNavResults = [];

    for (const entry of portfolio) {
      const basketId = Number(entry.basketId);
      try {
        const resp = await fetch(`${CRE_BRIDGE_URL}/nav`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ basketId, chainId: getConnectedChainId() }),
        });

        const data = await resp.json();

        if (!resp.ok) {
          creNavResults = [...creNavResults, { basketId, basketName: entry.name, data: null, error: data.error || `Bridge returned ${resp.status}` }];
        } else if (data.error) {
          creNavResults = [...creNavResults, { basketId, basketName: entry.name, data: null, error: data.error }];
        } else {
          creNavResults = [...creNavResults, { basketId, basketName: entry.name, data }];
        }
      } catch (err: any) {
        const msg = (err.message?.includes("Failed to fetch") || err.message?.includes("NetworkError"))
          ? "CRE Bridge not running. Start it with: bun run cre-bridge.ts"
          : err.message || "Unknown error";
        creNavResults = [...creNavResults, { basketId, basketName: entry.name, data: null, error: msg }];
      }
    }

    creNavLoading = false;
  }

  async function loadBasket(idStr: string) {
    const id = BigInt(idStr);
    try {
      basketInfo = await getBasketInfo(id);
      basketComponents = await getComponents(id);
      if (wallet.address) {
        const bal = await getBasketBalance(wallet.address, id);
        basketBalance = bal.toString();
      }
      recalcSpliceFee();

      // --- NAV Calculation ---
      navLoading = true;
      basketNavPerUnit = 0;
      componentBreakdown = [];

      const chainId = getConnectedChainId();
      const breakdown: typeof componentBreakdown = [];

      for (const comp of basketComponents) {
        let symbol: string;
        let decimals = 18;
        try {
          symbol = await getTokenSymbol(comp.token);
          decimals = await getTokenDecimals(comp.token);
        } catch {
          // Bridged basket — component contracts don't exist on this chain
          symbol = shortenAddress(comp.token);
        }

        const tokenAmount = parseFloat(formatUnits(comp.amount, decimals));

        let usdValue = 0;
        try {
          const usdPrice = await getTokenUsdPrice(comp.token, chainId);
          usdValue = usdPrice;
        } catch {
          // No feed for this token — show 0
          console.warn(`[NAV] No price feed for ${symbol} (${comp.token})`);
        }

        breakdown.push({ token: comp.token, symbol, amount: tokenAmount.toString(), usdValue });
      }

      componentBreakdown = breakdown;
      basketNavPerUnit = breakdown.reduce((sum, c) => sum + (c.usdValue * parseFloat(c.amount)), 0);
      basketNavTotal = basketNavPerUnit * parseInt(basketBalance || "0");
      navLoading = false;
    } catch {
      basketInfo = null;
      basketComponents = null;
      basketBalance = "0";
      basketNavPerUnit = 0;
      basketNavTotal = 0;
      componentBreakdown = [];
      navLoading = false;
    }
  }

  /** Scan all baskets and build portfolio for connected wallet */
  async function loadPortfolio() {
    if (!wallet.address) return;
    portfolioLoading = true;
    portfolio = [];
    portfolioTotal = 0;

    try {
      const chainId = getConnectedChainId();
      const nextId = await getNextBasketId();
      const entries: PortfolioEntry[] = [];

      for (let i = 1; i < nextId; i++) {
        const id = BigInt(i);
        let bal: bigint;
        try {
          bal = await getBasketBalance(wallet.address, id);
        } catch {
          continue;
        }
        if (bal === 0n) continue;

        const info = await getBasketInfo(id);
        const comps = await getComponents(id);
        const components: PortfolioEntry["components"] = [];
        let navPerUnit = 0;

        for (const comp of comps) {
          let symbol = "???";
          let tokenAmount = 0;
          let usdPrice = 0;

          try {
            symbol = await getTokenSymbol(comp.token);
            const decimals = await getTokenDecimals(comp.token);
            tokenAmount = parseFloat(formatUnits(comp.amount, decimals));
          } catch {
            // Bridged basket — component contracts don't exist on this chain
            // Fall back to raw amount assuming 18 decimals
            tokenAmount = parseFloat(formatUnits(comp.amount, 18));
            symbol = `${comp.token.slice(0, 6)}…${comp.token.slice(-4)}`;
          }

          try { usdPrice = await getTokenUsdPrice(comp.token, chainId); } catch {}

          components.push({ symbol, amount: tokenAmount.toString(), usdPrice });
          navPerUnit += usdPrice * tokenAmount;
        }

        const balance = Number(bal);
        entries.push({
          basketId: id,
          name: info.name,
          balance,
          navPerUnit,
          totalValue: navPerUnit * balance,
          components,
        });
      }

      portfolio = entries;
      portfolioTotal = entries.reduce((sum, e) => sum + e.totalValue, 0);
    } catch (err) {
      console.error("[Portfolio] Scan error:", err);
    }
    portfolioLoading = false;
  }

  // --- Actions ---

  /**
   * Weave Basket: create basket definition + approve + weave in one flow.
   * Chains: createBasket → approve(Escrow) → approve(Factory) → weave
   */
  async function handleWeaveBasket() {
    if (!wallet.address || !weaveName || weaveComponents.length === 0) return;
    if (weaveComponents.some(c => !c.address || !c.amount)) {
      status = "Fill in all component fields";
      return;
    }
    if (!/^\d+$/.test(weaveInitialUnits)) { status = "Units must be a whole number"; return; }

    busy = true;
    status = "";

    try {
      const tokens: Address[] = [];
      const amounts: bigint[] = [];
      const standards: number[] = [];    // V2: all ERC-20 = 0
      const tokenIds: bigint[] = [];     // V2: all 0n for ERC-20

      for (const comp of weaveComponents) {
    const decimals = await getTokenDecimals(comp.address as Address);
    tokens.push(comp.address as Address);
    amounts.push(parseUnits(comp.amount, decimals));
    standards.push(0);               // ERC-20
    tokenIds.push(0n);               // Not applicable for ERC-20
  }

  const units = BigInt(weaveInitialUnits);
  const fee = /^\d/.test(weaveFeeEstimate) ? parseUnits(weaveFeeEstimate, 18) : 0n;

  status = "Reading next basket ID...";
  const nextId = BigInt(await getNextBasketId());

  status = "Creating basket (tx 1)...";
  await createBasket(weaveName, tokens, standards, tokenIds, amounts);

      await ensureApprovals(wallet.address, tokens, amounts, units, (msg) => {
        status = msg;
      });

      status = "Weaving basket tokens...";
      await weave(nextId, units, fee);

      status = `Basket "${weaveName}" created & woven ✓  (ID: ${nextId})`;
      weaveName = "";
      weaveComponents = [{ address: getChainLinkAddress(), amount: "1", symbol: "LINK" }];
      await refreshBalances();
    } catch (err: any) {
      const msg = err.shortMessage || err.message;
      status = `Error: ${msg}`;
    }
    busy = false;
  }

  /** Splice: deposit into an existing basket to mint more basket tokens */
  async function handleSplice() {
    if (!wallet.address) return;
    busy = true;
    status = "";
    try {
      if (!/^\d+$/.test(spliceBasketId)) { status = "Basket ID must be a whole number"; busy = false; return; }
      if (!/^\d+$/.test(spliceUnits)) { status = "Units must be a whole number"; busy = false; return; }
      const id = BigInt(spliceBasketId);
      const units = BigInt(spliceUnits);
      const fee = /^\d/.test(weaveFeeEstimate) ? parseUnits(weaveFeeEstimate, 18) : 0n;

      const components = await getComponents(id);
      const tokens = components.map((c) => c.token);
      const amounts = components.map((c) => c.amount);

      await ensureApprovals(wallet.address, tokens, amounts, units, (msg) => {
        status = msg;
      });

      status = "Sending splice transaction...";
      await weave(id, units, fee);
      status = "Splice successful ✓";

      await refreshBalances();
      await loadBasket(spliceBasketId);
    } catch (err: any) {
      const msg = err.shortMessage || err.message;
      status = `Error: ${msg}`;
    }
    busy = false;
  }

  /** Unweave: burn basket tokens, reclaim underlying */
  async function handleUnweave() {
    if (!wallet.address) return;
    busy = true;
    status = "";
    try {
      if (!/^\d+$/.test(unweaveBasketId)) { status = "Basket ID must be a whole number"; busy = false; return; }
      if (!/^\d+$/.test(unweaveUnits)) { status = "Units must be a whole number"; busy = false; return; }
      const id = BigInt(unweaveBasketId);
      const units = BigInt(unweaveUnits);

      const chainId = getConnectedChainId();

      if (chainId !== CHAIN_IDS.sepolia) {
        // Remote chain — cross-chain unweave via CCIP
        await unweaveRemote(
          id,
          units,
          CHAIN_SELECTORS.sepolia,
          wallet.address,
          (msg: string) => { status = msg; }
        );
        status = "Remote unweave requested ✓ — tokens releasing from escrow, will arrive via CCIP (~40 min)";
      } else {
        status = "Sending unweave transaction...";
        await unweave(id, units);
        status = "Unweave successful ✓";
      }

      await refreshBalances();
      await loadBasket(unweaveBasketId);
    } catch (err: any) {
      const msg = err.shortMessage || err.message;
      status = `Error: ${msg}`;
    }
    busy = false;
  }

  /** Send: transfer ERC-1155 basket tokens to another address */
  async function handleSend() {
    if (!wallet.address) return;
    busy = true;
    status = "";
    try {
      if (!/^\d+$/.test(sendBasketId)) { status = "Basket ID must be a whole number"; busy = false; return; }
      if (!/^\d+$/.test(sendUnits)) { status = "Units must be a whole number"; busy = false; return; }
      if (!sendRecipient || sendRecipient.length !== 42 || !sendRecipient.startsWith("0x")) {
        status = "Enter a valid recipient address"; busy = false; return;
      }
      const id = BigInt(sendBasketId);
      const units = BigInt(sendUnits);

      status = "Sending basket tokens...";
      await sendBasketToken(wallet.address, sendRecipient as Address, id, units);
      status = `Sent ${sendUnits} unit${sendUnits === "1" ? "" : "s"} of basket #${sendBasketId} ✓`;

      await refreshBalances();
      await loadBasket(sendBasketId);
    } catch (err: any) {
      const msg = err.shortMessage || err.message;
      status = `Error: ${msg}`;
    }
    busy = false;
  }

  // --- Bridge Helpers ---

  /** Get available destination chains (exclude current chain) */
  function getBridgeDestinations() {
    const currentChainId = wallet.chainId || CHAIN_IDS.sepolia;
    return BRIDGE_DESTINATIONS.filter(d => d.chainId !== currentChainId);
  }

  /** Debounced bridge fee estimation */
  let bridgeFeeTimeout: ReturnType<typeof setTimeout>;
  function debounceBridgeFee() {
    clearTimeout(bridgeFeeTimeout);
    bridgeFeeTimeout = setTimeout(() => recalcBridgeFee(), 600);
  }

  async function recalcBridgeFee() {
    const dests = getBridgeDestinations();
    if (!bridgeBasketId || !/^\d+$/.test(bridgeBasketId) ||
        !bridgeUnits || !/^\d+$/.test(bridgeUnits) ||
        dests.length === 0) {
      bridgeFeeEstimate = "—";
      return;
    }
    bridgeFeeLoading = true;
    try {
      const dest = dests[bridgeDestIndex] || dests[0];
      const fee = await getBridgeFee(
        BigInt(bridgeBasketId),
        BigInt(bridgeUnits),
        dest.selector
      );
      bridgeFeeEstimate = formatUnits(fee, 18);
    } catch (err) {
      console.error("[Bridge] Fee estimate error:", err);
      bridgeFeeEstimate = "?";
    }
    bridgeFeeLoading = false;
  }

  /** Bridge: send basket cross-chain via CCIP */
  async function handleBridge() {
    if (!wallet.address) return;
    busy = true;
    status = "";
    bridgeTxHash = "";
    bridgeSuccessLink = "";

    try {
      if (!/^\d+$/.test(bridgeBasketId)) { status = "Basket ID must be a whole number"; busy = false; return; }
      if (!/^\d+$/.test(bridgeUnits)) { status = "Units must be a whole number"; busy = false; return; }

      const dests = getBridgeDestinations();
      if (dests.length === 0) { status = "No destination chains available"; busy = false; return; }
      const dest = dests[bridgeDestIndex] || dests[0];

      const recipient = (bridgeRecipient && bridgeRecipient.length === 42 && bridgeRecipient.startsWith("0x"))
        ? bridgeRecipient as Address
        : wallet.address;

      const id = BigInt(bridgeBasketId);
      const units = BigInt(bridgeUnits);

      const hash = await sendBasketCrossChain(
        id,
        units,
        dest.selector,
        recipient,
        (msg) => { status = msg; }
      );

      bridgeTxHash = hash;
      bridgeSuccessLink = `https://ccip.chain.link/tx/${hash}`;
      status = `Bridged ${bridgeUnits} unit${bridgeUnits === "1" ? "" : "s"} of basket #${bridgeBasketId} to ${dest.name} ✓`;

      await refreshBalances();
    } catch (err: any) {
      const msg = err.shortMessage || err.message;
      status = `Error: ${msg}`;
    }
    busy = false;
  }
</script>

<header>
  <span class="logo colossus-title">COLOSSUS</span>

  {#if wallet.connected && wallet.address}
    <div class="wallet-info">
      <span class="address">{shortenAddress(wallet.address)}</span>
      <span class="balance">{parseFloat(wallet.balance).toFixed(4)} ETH</span>
      <span class="link-bal">{isNaN(parseFloat(linkBalance)) ? "—" : parseFloat(linkBalance).toFixed(2)} LINK</span>
      <select
        class="chain-select"
        value={wallet.chainId}
        onchange={async (e) => {
          const target = e.target as HTMLSelectElement;
          try {
            status = `Switching to ${target.options[target.selectedIndex].text}...`;
            await switchChain(Number(target.value));
          } catch (err: any) {
            status = `Chain switch failed: ${err.shortMessage || err.message}`;
          }
        }}
      >
        <option value={11155111}>Sepolia</option>
        <option value={84532}>Base Sepolia</option>
      </select>
      <button class="disconnect" onclick={handleDisconnect}>✕</button>
    </div>
  {:else if !qrCodeUrl}
    <button onclick={handleConnect} disabled={wallet.connecting}>
      {wallet.connecting ? "Connecting..." : "Connect Wallet"}
    </button>
  {/if}
</header>

<main>
  {#if wallet.error}
    <p class="error">{wallet.error}</p>
  {/if}

  {#if qrCodeUrl}
    <div class="qr-overlay">
      <div class="qr-modal">
        <h3>Connect Wallet</h3>
        <div class="wallet-buttons">
          <button class="wallet-btn" onclick={() => openInWallet("onekey")}>
            <span class="wallet-icon">🔑</span> OneKey
          </button>
          <button class="wallet-btn" onclick={() => openInWallet("metamask")}>
            <span class="wallet-icon">🦊</span> MetaMask
          </button>
          <button class="wallet-btn" onclick={handleCopy}>
            <span class="wallet-icon">📋</span> {copied ? "Copied!" : "Copy URI"}
          </button>
        </div>
        <div class="divider"><span>or scan</span></div>
        <img src={qrCodeUrl} alt="WalletConnect QR Code" class="qr-image" />
        <p class="qr-hint">Any WalletConnect-compatible wallet</p>
        <button class="cancel-btn" onclick={handleCancelConnect}>Cancel</button>
      </div>
    </div>
  {:else if !wallet.connected}
    <div class="center-message">
      <p>Connect your wallet to begin.</p>
    </div>
  {:else}

    <!-- Tab Navigation -->
    <div class="tabs">
      <button
        class="tab"
        class:active={activeTab === "weave"}
        onclick={() => { clearCreResults(); activeTab = "weave"; }}>Weave Basket</button>
      <button
        class="tab"
        class:active={activeTab === "splice"}
        onclick={() => { clearCreResults(); activeTab = "splice"; }}>Splice Basket</button>
      <button
        class="tab"
        class:active={activeTab === "unweave"}
        onclick={() => { clearCreResults(); activeTab = "unweave"; }}>Unweave</button>
      <button
        class="tab"
        class:active={activeTab === "send"}
        onclick={() => { clearCreResults(); activeTab = "send"; }}>Send</button>
      <button
        class="tab"
        class:active={activeTab === "bridge"}
        onclick={() => { clearCreResults(); activeTab = "bridge"; }}>Bridge</button>
      <button
        class="tab"
        class:active={activeTab === "portfolio"}
        onclick={() => { clearCreResults(); activeTab = "portfolio"; loadPortfolio(); }}>Portfolio</button>
    </div>

    <!-- Status Bar -->
    {#if status}
      <div class="status" class:success={status.includes("✓")} class:err={status.includes("Error")}>
        <span>{status}</span>
        <button class="status-dismiss" onclick={() => status = ""}>✕</button>
      </div>
    {/if}

    <!-- ========== WEAVE BASKET TAB (Create + First Deposit) ========== -->
    {#if activeTab === "weave"}
      <div class="panel">
        <h3>Weave a New Basket</h3>
        <p class="panel-desc">Name your basket, define its components, and mint your first basket tokens in one step.</p>
        <label>
          Basket Name
          <input type="text" bind:value={weaveName} placeholder="e.g. LINK Index" />
        </label>
        <div class="components-header">
          <span>Components</span>
          <button class="small" onclick={addWeaveComponent}>+ Add Token</button>
        </div>
        {#each weaveComponents as comp, i}
          <div class="component-input">
            <label>
              Token Address
              <div class="input-row">
                <input type="text" bind:value={comp.address} placeholder="0x..." oninput={() => resolveTokenSymbol(i)} />
                {#if comp.symbol}
                  <span class="token-badge">{comp.symbol}</span>
                {/if}
              </div>
            </label>
            <label class="amount-input">
              Amount Per Unit
              <input type="text" bind:value={comp.amount} placeholder="1" oninput={debounceFee} />
            </label>
            {#if weaveComponents.length > 1}
              <button class="remove-btn" onclick={() => removeWeaveComponent(i)}>✕</button>
            {/if}
          </div>
        {/each}
        <label>
          Units to Mint
          <input type="text" bind:value={weaveInitialUnits} placeholder="1" oninput={debounceFee} />
        </label>

        <!-- CRE On-DON Verification -->
        <button
          class="cre-verify-btn"
          onclick={() => handleCreVerify("weave")}
          disabled={creVerifyLoading || weaveComponents.every(c => !c.address)}
        >
          {creVerifyLoading ? "Verifying on DON..." : "Verify with CRE"}
        </button>
        {#if creVerifyResult}
          <div class="cre-result" class:cre-pass={creVerifyResult.verified} class:cre-fail={!creVerifyResult.verified} style="position: relative;">
            <button class="cre-close-btn" onclick={() => { creVerifyResult = null; }}>✕</button>
            <p class="cre-result-header">
              {creVerifyResult.verified ? "✓ Verified" : "✗ Insufficient Balances"}
              <span class="cre-result-dim"> — {creVerifyResult.balances.length} token{creVerifyResult.balances.length === 1 ? "" : "s"} checked on-DON for {creVerifyResult.units} unit{creVerifyResult.units === "1" ? "" : "s"}</span>
            </p>
            {#each creVerifyResult.balances as bal}
              <p class="cre-result-line">{formatCreBalance(bal)}</p>
            {/each}
          </div>
        {/if}
        {#if creVerifyError}
          <div class="cre-result cre-fail" style="position: relative;">
            <button class="cre-close-btn" onclick={() => { creVerifyError = ""; }}>✕</button>
            <p class="cre-result-header">CRE Error</p>
            <p class="cre-result-line">{creVerifyError}</p>
          </div>
        {/if}

        <label>
          Estimated Fee (LINK)
          <input type="text" value={weaveFeeEstimate} readonly style="opacity: 0.8;" />
        </label>
        <p class="hint">0.1% of bundled value | Transactions: create, approve per token, weave</p>
        <p class="warning-hint">⚠ A basket's components are fixed at creation. Only these tokens can be spliced in later — choose carefully.</p>
        <button onclick={handleWeaveBasket} disabled={busy || !weaveName}>
          {busy ? "Processing..." : "Weave Basket"}
        </button>
      </div>
    {/if}

    <!-- ========== SPLICE BASKET TAB (Add to Existing) ========== -->
    {#if activeTab === "splice"}
      <div class="panel">
        <h3>Splice into Existing Basket</h3>
        <p class="panel-desc">Deposit additional tokens into an existing basket to mint more basket tokens. Components are fixed by the basket definition.</p>
        <label>
          Basket ID
          <div class="input-row">
            <input type="text" bind:value={spliceBasketId} placeholder="1" />
            <button class="small" onclick={() => loadBasket(spliceBasketId)}>Load</button>
          </div>
        </label>

        {#if basketInfo}
          <div class="basket-detail">
            <p><strong>{basketInfo.name}</strong></p>
            <p class="dim">Creator: {shortenAddress(basketInfo.creator)}</p>
            <p class="dim">Your balance: <strong>{basketBalance} unit{basketBalance === "1" ? "" : "s"}</strong></p>

            {#if componentBreakdown.length > 0}
              <div class="components-header"><span>Components (per unit)</span></div>
              {#each componentBreakdown as comp}
                <div class="component-row">
                  <span class="component-name">{comp.symbol}</span>
                  <span class="component-amount">{comp.amount}</span>
                  <span class="component-usd">${comp.usdValue.toFixed(2)}</span>
                </div>
              {/each}
            {:else if basketComponents}
              {#each basketComponents as comp}
                <p class="component">
                  {shortenAddress(comp.token)} — {formatUnits(comp.amount, 18)} per unit
                </p>
              {/each}
            {/if}

            {#if componentBreakdown.length > 0 && spliceUnits && /^\d+$/.test(spliceUnits) && parseInt(spliceUnits) > 0}
              <div class="deposit-impact">
                <p class="dim">You will deposit:</p>
                {#each componentBreakdown as comp}
                  <div class="component-row">
                    <span class="component-name">{comp.symbol}</span>
                    <span class="component-amount">{(parseFloat(comp.amount) * parseInt(spliceUnits)).toFixed(6)}</span>
                    <span class="component-usd">${(comp.usdValue * parseFloat(comp.amount) * parseInt(spliceUnits)).toFixed(2)}</span>
                  </div>
                {/each}
              </div>
            {/if}

            <div class="nav-summary">
              {#if navLoading}
                <p class="dim">Loading prices...</p>
              {:else}
                <p>Basket unit value: <strong>${basketNavPerUnit.toFixed(2)}</strong></p>
              {/if}
            </div>
          </div>
        {/if}

        <label>
          Units to Splice
          <input type="text" bind:value={spliceUnits} placeholder="1" oninput={recalcSpliceFee} />
        </label>

        <!-- CRE On-DON Verification -->
        <button
          class="cre-verify-btn"
          onclick={() => handleCreVerify("splice")}
          disabled={creVerifyLoading || !basketComponents}
        >
          {creVerifyLoading ? "Verifying on DON..." : "Verify with CRE"}
        </button>
        {#if creVerifyResult}
          <div class="cre-result" class:cre-pass={creVerifyResult.verified} class:cre-fail={!creVerifyResult.verified} style="position: relative;">
            <button class="cre-close-btn" onclick={() => { creVerifyResult = null; }}>✕</button>
            <p class="cre-result-header">
              {creVerifyResult.verified ? "✓ Verified" : "✗ Insufficient Balances"}
              <span class="cre-result-dim"> — {creVerifyResult.balances.length} token{creVerifyResult.balances.length === 1 ? "" : "s"} checked on-DON for {creVerifyResult.units} unit{creVerifyResult.units === "1" ? "" : "s"}</span>
            </p>
            {#each creVerifyResult.balances as bal}
              <p class="cre-result-line">{formatCreBalance(bal)}</p>
            {/each}
          </div>
        {/if}
        {#if creVerifyError}
          <div class="cre-result cre-fail" style="position: relative;">
            <button class="cre-close-btn" onclick={() => { creVerifyError = ""; }}>✕</button>
            <p class="cre-result-header">CRE Error</p>
            <p class="cre-result-line">{creVerifyError}</p>
          </div>
        {/if}

        <label>
          Splice Fee (LINK)
          <input type="text" value={spliceLinkFee} readonly style="opacity: 0.8;" />
        </label>
        <p class="hint">0.1% of bundled value, auto-calculated</p>
        <button onclick={handleSplice} disabled={busy}>
          {busy ? "Processing..." : "Approve & Splice"}
        </button>
      </div>
    {/if}

    <!-- ========== UNWEAVE TAB ========== -->
    {#if activeTab === "unweave"}
      <div class="panel">
        <h3>Unweave Basket to Tokens</h3>
        <p class="panel-desc">Burn basket tokens to reclaim the underlying component tokens.</p>
        <label>
          Basket ID
          <div class="input-row">
            <input type="text" bind:value={unweaveBasketId} placeholder="1" />
            <button class="small" onclick={() => loadBasket(unweaveBasketId)}>Load</button>
          </div>
        </label>

        {#if basketInfo}
          <div class="basket-detail">
            <p><strong>{basketInfo.name}</strong></p>
            <p class="dim">Your balance: <strong>{basketBalance} unit{basketBalance === "1" ? "" : "s"}</strong></p>

            {#if componentBreakdown.length > 0}
              <div class="components-header"><span>Components (per unit)</span></div>
              {#each componentBreakdown as comp}
                <div class="component-row">
                  <span class="component-name">{comp.symbol}</span>
                  <span class="component-amount">{comp.amount}</span>
                  <span class="component-usd">${comp.usdValue.toFixed(2)}</span>
                </div>
              {/each}
            {/if}

            {#if componentBreakdown.length > 0 && unweaveUnits && /^\d+$/.test(unweaveUnits) && parseInt(unweaveUnits) > 0 && parseInt(basketBalance) > 0}
              <div class="deposit-impact">
                <p class="dim">You will receive:</p>
                {#each componentBreakdown as comp}
                  <div class="component-row">
                    <span class="component-name">{comp.symbol}</span>
                    <span class="component-amount">{(parseFloat(comp.amount) * parseInt(unweaveUnits)).toFixed(6)}</span>
                    <span class="component-usd">${(comp.usdValue * parseFloat(comp.amount) * parseInt(unweaveUnits)).toFixed(2)}</span>
                  </div>
                {/each}
              </div>
            {/if}

            <div class="nav-summary">
              {#if navLoading}
                <p class="dim">Loading prices...</p>
              {:else}
                <p>Basket unit value: <strong>${basketNavPerUnit.toFixed(2)}</strong></p>
              {/if}
            </div>
          </div>
        {/if}

        <label>
          Units to Unweave
          <input type="text" bind:value={unweaveUnits} placeholder="1" />
        </label>
        {#if basketInfo && parseInt(basketBalance) > 0}
          <p class="hint">Max: {basketBalance} unit{basketBalance === "1" ? "" : "s"}</p>
        {:else if basketInfo && parseInt(basketBalance) === 0}
          <p class="hint" style="color: var(--colossus-text-dim);">You hold 0 units of this basket.</p>
        {/if}
        <button onclick={handleUnweave} disabled={busy || !basketInfo || parseInt(basketBalance) === 0}>
          {busy ? "Processing..." : "Unweave"}
        </button>
      </div>
    {/if}

    <!-- ========== SEND TAB ========== -->
    {#if activeTab === "send"}
      <div class="panel">
        <h3>Send Basket Tokens</h3>
        <p class="panel-desc">Transfer ERC-1155 basket tokens to another address. Works around wallet UIs that don't fully support ERC-1155.</p>
        <label>
          Basket ID
          <div class="input-row">
            <input type="text" bind:value={sendBasketId} placeholder="1" />
            <button class="small" onclick={() => loadBasket(sendBasketId)}>Load</button>
          </div>
        </label>

        {#if basketInfo}
          <div class="basket-detail">
            <p><strong>{basketInfo.name}</strong></p>
            <p class="dim">Your balance: <strong>{basketBalance} unit{basketBalance === "1" ? "" : "s"}</strong></p>

            {#if componentBreakdown.length > 0}
              <div class="components-header"><span>Components (per unit)</span></div>
              {#each componentBreakdown as comp}
                <div class="component-row">
                  <span class="component-name">{comp.symbol}</span>
                  <span class="component-amount">{comp.amount}</span>
                  <span class="component-usd">${comp.usdValue.toFixed(2)}</span>
                </div>
              {/each}
            {/if}

            {#if componentBreakdown.length > 0 && sendUnits && /^\d+$/.test(sendUnits) && parseInt(sendUnits) > 0 && parseInt(basketBalance) > 0}
              <div class="deposit-impact">
                <p class="dim">Recipient will receive:</p>
                {#each componentBreakdown as comp}
                  <div class="component-row">
                    <span class="component-name">{comp.symbol}</span>
                    <span class="component-amount">{(parseFloat(comp.amount) * parseInt(sendUnits)).toFixed(6)}</span>
                    <span class="component-usd">${(comp.usdValue * parseFloat(comp.amount) * parseInt(sendUnits)).toFixed(2)}</span>
                  </div>
                {/each}
              </div>
            {/if}

            <div class="nav-summary">
              {#if navLoading}
                <p class="dim">Loading prices...</p>
              {:else if parseInt(basketBalance) > 0}
                <p>Value being sent: <strong>${(basketNavPerUnit * parseInt(sendUnits || "0")).toFixed(2)}</strong></p>
              {/if}
            </div>
          </div>
        {/if}

        <label>
          Recipient Address
          <input type="text" bind:value={sendRecipient} placeholder="0x..." />
        </label>
        <label>
          Units to Send
          <input type="text" bind:value={sendUnits} placeholder="1" />
        </label>
        {#if basketInfo && parseInt(basketBalance) > 0}
          <p class="hint">Max: {basketBalance} unit{basketBalance === "1" ? "" : "s"}</p>
        {:else if basketInfo && parseInt(basketBalance) === 0}
          <p class="hint" style="color: var(--colossus-text-dim);">You hold 0 units of this basket.</p>
        {/if}
        <button onclick={handleSend} disabled={busy || !sendRecipient || !basketInfo || parseInt(basketBalance) === 0}>
          {busy ? "Processing..." : "Send"}
        </button>
      </div>
    {/if}

    <!-- ========== BRIDGE TAB (CCIP Cross-Chain) ========== -->
    {#if activeTab === "bridge"}
      <div class="panel">
        <h3>Bridge Basket Cross-Chain</h3>
        <p class="panel-desc">Send basket tokens to another chain via Chainlink CCIP. Underlying tokens stay locked in escrow on the home chain.</p>

        <label>
          Basket ID
          <div class="input-row">
            <input type="text" bind:value={bridgeBasketId} placeholder="1" oninput={debounceBridgeFee} />
            <button class="small" onclick={() => { loadBasket(bridgeBasketId); recalcBridgeFee(); }}>Load</button>
          </div>
        </label>

        {#if basketInfo}
          <div class="basket-detail">
            <p><strong>{basketInfo.name}</strong></p>
            <p class="dim">Your balance: <strong>{basketBalance} unit{basketBalance === "1" ? "" : "s"}</strong></p>

            {#if componentBreakdown.length > 0}
              <div class="components-header"><span>Components (per unit)</span></div>
              {#each componentBreakdown as comp}
                <div class="component-row">
                  <span class="component-name">{comp.symbol}</span>
                  <span class="component-amount">{comp.amount}</span>
                  <span class="component-usd">${comp.usdValue.toFixed(2)}</span>
                </div>
              {/each}
            {/if}

            <div class="nav-summary">
              {#if navLoading}
                <p class="dim">Loading prices...</p>
              {:else}
                <p>Basket unit value: <strong>${basketNavPerUnit.toFixed(2)}</strong></p>
              {/if}
            </div>
          </div>
        {/if}

        <label>
          Destination Chain
          <select bind:value={bridgeDestIndex} onchange={debounceBridgeFee}>
            {#each getBridgeDestinations() as dest, i}
              <option value={i}>{dest.name}</option>
            {/each}
          </select>
        </label>

        <label>
          Units to Bridge
          <input type="text" bind:value={bridgeUnits} placeholder="1" oninput={debounceBridgeFee} />
        </label>
        {#if basketInfo && parseInt(basketBalance) > 0}
          <p class="hint">Max: {basketBalance} unit{basketBalance === "1" ? "" : "s"}</p>
        {:else if basketInfo && parseInt(basketBalance) === 0}
          <p class="hint" style="color: var(--colossus-text-dim);">You hold 0 units of this basket.</p>
        {/if}

        <label>
          Recipient Address <span class="hint-inline">(blank = self)</span>
          <input type="text" bind:value={bridgeRecipient} placeholder={wallet.address || "0x..."} />
        </label>

        <label>
          Estimated CCIP Fee (LINK)
          <input type="text" value={bridgeFeeLoading ? "Estimating..." : bridgeFeeEstimate} readonly style="opacity: 0.8;" />
        </label>
        <p class="hint">CCIP fee paid in LINK — covers cross-chain message delivery</p>

        <p class="warning-hint">⚠ Bridging burns basket tokens on this chain and mints them on the destination. Underlying tokens remain locked in escrow on the home chain.</p>

        <button onclick={handleBridge} disabled={busy || !basketInfo || parseInt(basketBalance) === 0}>
          {busy ? "Processing..." : "Bridge via CCIP"}
        </button>

        {#if bridgeSuccessLink}
          <div class="ccip-link">
            <a href={bridgeSuccessLink} onclick={async (e) => { e.preventDefault(); try { await open(bridgeSuccessLink); } catch { window.open(bridgeSuccessLink, '_blank'); } }}>
            Track on CCIP Explorer →
          </a>
            <p class="hint">Cross-chain delivery typically takes 5–20 minutes on testnets.</p>
          </div>
        {/if}
      </div>
    {/if}

    {#if activeTab === "portfolio"}
      <div class="panel">
        <h3>Portfolio Overview</h3>
        <p class="panel-desc">All baskets held by your connected wallet.</p>

        {#if portfolioLoading}
          <p class="dim">Scanning baskets...</p>
        {:else if portfolio.length === 0}
          <p class="dim">No baskets found for this wallet.</p>
        {:else}
          {#each portfolio as entry}
            <div class="portfolio-card">
              <div class="portfolio-header">
                <span class="portfolio-name">{entry.name}</span>
                <span class="portfolio-id">ID: {entry.basketId.toString()}</span>
              </div>

              {#each entry.components as comp}
                <div class="component-row">
                  <span class="component-name">{comp.symbol}: {comp.amount} held</span>
                  <span class="component-usd">value per token: ${comp.usdPrice.toFixed(2)}</span>
                </div>
              {/each}

              <div class="portfolio-summary">
                <span>Basket Units: {entry.balance}</span>
                <span>Unit value: ${entry.navPerUnit.toFixed(2)}</span>
                <span class="portfolio-value">Total: ${entry.totalValue.toFixed(2)}</span>
              </div>

              {#if portfolioTotal > 0}
                <div class="allocation-bar">
                  <div
                    class="allocation-fill"
                    style="width: {((entry.totalValue / portfolioTotal) * 100).toFixed(1)}%"
                  ></div>
                </div>
                <p class="allocation-pct">{((entry.totalValue / portfolioTotal) * 100).toFixed(1)}% of portfolio</p>
              {/if}

              <!-- CRE On-DON Analysis -->
              <button
                class="cre-verify-btn"
                onclick={() => handleCreAnalyze(Number(entry.basketId))}
                disabled={creAnalysisLoading}
                style="margin-top: 8px;"
              >
                {creAnalysisLoading && creAnalysisBasketId === Number(entry.basketId) ? "Analyzing on DON..." : "Analyze with CRE"}
              </button>
              {#if !creAnalysisResult || creAnalysisBasketId !== Number(entry.basketId)}
                {#if !creAnalysisError || creAnalysisBasketId !== Number(entry.basketId)}
                  <p class="hint" style="margin-top: 4px;">Analysis can take ~60 seconds or more, please be patient.</p>
                {/if}
              {/if}
              {#if creAnalysisResult && creAnalysisBasketId === Number(entry.basketId)}
                <div class="cre-result cre-analysis" style="position: relative;">
                  <button class="cre-close-btn" onclick={() => { creAnalysisResult = null; creAnalysisBasketId = null; }}>✕</button>
                  <p class="cre-result-header">
                    AI Portfolio Analysis
                    <span class="cre-result-dim"> — {creAnalysisResult.componentCount} component{creAnalysisResult.componentCount === 1 ? "" : "s"} via SXT + CoinGecko + Claude on-DON</span>
                  </p>
                  {#each creAnalysisResult.components as comp}
                    <p class="cre-result-line">
                      {comp.symbol}: {comp.amount} tokens
                      {#if comp.analytics && !comp.analytics.error}
                        — {comp.analytics.TRANSFER_COUNT?.toLocaleString() ?? "?"} mainnet transfers
                      {:else if comp.analytics?.error}
                        — <span class="cre-result-dim">{comp.analytics.error}</span>
                      {/if}
                    </p>
                  {/each}
                  <div class="cre-analysis-text">{creAnalysisResult.aiAnalysis}</div>
                </div>
              {/if}
              {#if creAnalysisError && creAnalysisBasketId === Number(entry.basketId)}
                <div class="cre-result cre-fail" style="position: relative;">
                  <button class="cre-close-btn" onclick={() => { creAnalysisError = ""; creAnalysisBasketId = null; }}>✕</button>
                  <p class="cre-result-header">CRE Analysis Error</p>
                  <p class="cre-result-line">{creAnalysisError}</p>
                </div>
              {/if}
            </div>
          {/each}

          <div class="portfolio-total">
            Portfolio total: <strong>${portfolioTotal.toFixed(2)}</strong>
          </div>

          <!-- CRE On-DON NAV Verification -->
          <button
            class="cre-verify-btn"
            onclick={handleCreNav}
            disabled={creNavLoading}
            style="margin-top: 10px;"
          >
            {creNavLoading ? "Verifying NAV on DON..." : "Verify Basket(s) NAV"}
          </button>
          {#if creNavLoading}
            <p class="hint" style="margin-top: 4px;">NAV verification can take ~30 seconds per basket, please be patient.</p>
          {/if}
          {#if creNavResults.length > 0}
            <div class="cre-result cre-nav" style="position: relative; margin-top: 8px;">
              <button class="cre-close-btn" onclick={() => { creNavResults = []; }}>✕</button>
              <p class="cre-result-header">
                On-DON NAV Verification
                <span class="cre-result-dim"> — {creNavResults.length} basket{creNavResults.length === 1 ? "" : "s"} verified via Chainlink price feeds</span>
              </p>
              {#each creNavResults as nav}
                {#if nav.error}
                  <p class="cre-result-line">✗ {nav.basketName} (ID {nav.basketId}): {nav.error}</p>
                {:else}
                  {@const knownSymbols = {
                    "0x779877a7b0d9e8603169ddbd7836e478b4624789": "LINK",
                    "0xfff9976782d46cc05630d1f6ebab18b2324d6b14": "WETH",
                    "0xe4ab69c077896252fafbd49efd26b5d171a32410": "LINK",
                    "0x4200000000000000000000000000000000000006": "WETH",
                    "0xfd57b4ddbf88a4e07ff4e34c487b99af2fe82a05": "CCIP-BnM",
                    "0x88a2d74f47a237a62e7a51cdda67270ce381555e": "CCIP-BnM",
                  }}

                  <div class="cre-nav-entry">
                    <p class="cre-result-line" style="font-weight: 600; color: var(--colossus-text);">
                      ✓ {nav.data.basketName || nav.basketName} (ID {nav.basketId})
                    </p>
                    {#if nav.data.components}
                      {#each nav.data.components as comp}
                        {@const sym = comp.symbol || knownSymbols[(comp.token?.toLowerCase() ?? "") as keyof typeof knownSymbols] || `${comp.token?.slice(0, 10)}`}
                        <p class="cre-result-line">
                          {sym}: ${comp.usdValue?.toFixed(2) ?? "?"}/unit, value per token: ${comp.usdPrice?.toFixed(2) ?? "?"}
                        </p>
                      {/each}
                    {/if}
                    <p class="cre-result-line" style="font-weight: 600; margin-top: 2px;">
                      On-DON NAV: ${nav.data.navUsd?.toFixed(2) ?? "?"} / unit
                      {#if portfolio.find(p => Number(p.basketId) === nav.basketId)}
                        {@const local = portfolio.find(p => Number(p.basketId) === nav.basketId)}
                        <span class="cre-result-dim"> — dApp estimate: ${local?.navPerUnit.toFixed(2)}/unit</span>
                      {/if}
                    </p>
                  </div>
                {/if}
              {/each}
            </div>
          {/if}
        {/if}

        <!-- CCC Private Holdings (Sepolia only) -->
        {#if cccSupported}
          <div class="ccc-card">
            <div class="ccc-header">
              <div class="ccc-title-row">
                <span class="ccc-lock">🔒</span>
                <span class="ccc-label">Private Holdings</span>
                <span class="ccc-badge">CCC</span>
              </div>
              <button
                class="ccc-reveal-btn"
                onclick={() => {
                  if (cccBalances.length > 0) {
                    cccBalances = [];
                    cccError = "";
                    cccNavResult = null;
                    cccNavError = "";
                    cccAnalysisResult = null;
                    cccAnalysisError = "";
                  } else {
                    loadCccBalances();
                  }
                }}
                disabled={cccLoading}
              >
                {cccLoading ? "Signing..." : cccBalances.length > 0 ? "Hide Balances" : "Reveal Balances"}
              </button>
            </div>

            {#if cccError}
              <div class="ccc-error">{cccError}</div>
            {:else if cccBalances.length > 0}
              <div class="ccc-balances">
                {#each cccBalances as bal}
                  <div class="ccc-balance-row">
                    <span class="ccc-symbol">{bal.symbol}</span>
                    <span class="ccc-amount">{bal.formatted}</span>
                  </div>
                {/each}
              </div>
              <p class="ccc-footnote">Balances held privately in CCC Vault · Not visible on-chain</p>
            {:else if !cccLoading}
              <p class="ccc-prompt">Click "Reveal Balances" to sign and view private holdings</p>
            {/if}

            <!-- CRE Workflows (on private/shielded baskets) -->
            <div class="ccc-cre-section">
              <div class="ccc-cre-header">
                <span class="ccc-label" style="font-size: 12px;">Confidential Workflows</span>
                <span class="ccc-badge">CCC</span>
              </div>
              <p class="ccc-footnote" style="text-align: left; margin: 0 0 8px 0;">
                These workflows use the ConfidentialHTTPClient and route through TEE enclaves, keeping requests private. Even from DON node operators.
              </p>
              <div class="ccc-cre-input-row">
                <label class="ccc-cre-label">
                  Basket ID
                  <input type="text" bind:value={cccBasketId} class="ccc-cre-input" placeholder="5" />
                </label>
                <button
                  class="ccc-reveal-btn"
                  onclick={handleCccNav}
                  disabled={cccNavLoading || !cccBasketId}
                  style="align-self: flex-end;"
                >
                  {cccNavLoading ? "Verifying..." : "Verify NAV"}
                </button>
                <button
                  class="ccc-reveal-btn"
                  onclick={handleCccAnalyze}
                  disabled={cccAnalysisLoading || !cccBasketId}
                  style="align-self: flex-end;"
                >
                  {cccAnalysisLoading ? "Analyzing..." : "Analyze"}
                </button>
              </div>

              <!-- NAV Result -->
              {#if cccNavResult}
                <div class="ccc-cre-result ccc-cre-nav" style="position: relative;">
                  <button class="cre-close-btn" onclick={() => { cccNavResult = null; }}>✕</button>
                  <p class="cre-result-header" style="margin-bottom: 2px;">
                    ✓ {cccNavResult.basketName || `Basket #${cccBasketId}`} (ID {cccBasketId})
                  </p>
                  {#if cccNavResult.components}
                    {#each cccNavResult.components as comp}
                      {@const knownSymbols: Record<string, string> = {
                        "0x779877a7b0d9e8603169ddbd7836e478b4624789": "LINK",
                        "0xfff9976782d46cc05630d1f6ebab18b2324d6b14": "WETH",
                      }}
                      {@const sym = comp.symbol || knownSymbols[comp.token?.toLowerCase() ?? ""] || `${comp.token?.slice(0, 10)}`}
                      <p class="cre-result-line">
                        {sym}: ${comp.usdValue?.toFixed(2) ?? "?"}/unit, value per token: ${comp.usdPrice?.toFixed(2) ?? "?"}
                      </p>
                    {/each}
                  {/if}
                  <p class="cre-result-line" style="font-weight: 600; margin-top: 2px;">
                    On-DON NAV: ${cccNavResult.navUsd?.toFixed(2) ?? "?"} / unit
                    {#if cccNavResult.confidential}
                      <span class="cre-result-dim"> · confidential</span>
                    {/if}
                  </p>
                </div>
              {/if}
              {#if cccNavError}
                <div class="ccc-cre-result ccc-cre-error-box" style="position: relative;">
                  <button class="cre-close-btn" onclick={() => { cccNavError = ""; }}>✕</button>
                  <p class="cre-result-header">NAV Error</p>
                  <p class="cre-result-line">{cccNavError}</p>
                </div>
              {/if}

              <!-- Analysis Result -->
              {#if cccAnalysisResult}
                <div class="ccc-cre-result ccc-cre-analysis" style="position: relative;">
                  <button class="cre-close-btn" onclick={() => { cccAnalysisResult = null; }}>✕</button>
                  <p class="cre-result-header">
                    AI Portfolio Analysis
                    <span class="cre-result-dim"> — {cccAnalysisResult.componentCount} component{cccAnalysisResult.componentCount === 1 ? "" : "s"} via SXT + CoinGecko + Claude on-DON</span>
                  </p>
                  {#each cccAnalysisResult.components as comp}
                    <p class="cre-result-line">
                      {comp.symbol}: {comp.amount} tokens
                      {#if comp.analytics && !comp.analytics.error}
                        — {comp.analytics.TRANSFER_COUNT?.toLocaleString() ?? "?"} mainnet transfers
                      {:else if comp.analytics?.error}
                        — <span class="cre-result-dim">{comp.analytics.error}</span>
                      {/if}
                    </p>
                  {/each}
                  <div class="cre-analysis-text">{cccAnalysisResult.aiAnalysis}</div>
                </div>
              {/if}
              {#if cccAnalysisError}
                <div class="ccc-cre-result ccc-cre-error-box" style="position: relative;">
                  <button class="cre-close-btn" onclick={() => { cccAnalysisError = ""; }}>✕</button>
                  <p class="cre-result-header">Analysis Error</p>
                  <p class="cre-result-line">{cccAnalysisError}</p>
                </div>
              {/if}

              {#if cccAnalysisLoading || cccNavLoading}
                <p class="ccc-footnote" style="text-align: left;">CRE workflows can take 30-60s. Please be patient.</p>
              {/if}
            </div>
          </div>
        {/if}
      </div>
    {/if}

  {/if}
  <!-- chainlink branding-->
  <div style="display: flex; justify-content: center; align-items: center; gap: 6px; margin-top: 24px; opacity: 0.85;">
    <span style="font-size: 11px; color: #0847F7;">Powered by</span>
    <img src="/Chainlink-Logo-Black.svg" alt="Chainlink" style="height: 17px;" />
  </div>
</main>

<style>
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 20px;
    background-color: var(--colossus-surface);
    border-bottom: 1px solid var(--colossus-border);
  }

  .logo {
    font-size: 16px;
    font-weight: 700;
    letter-spacing: 2px;
    color: var(--colossus-accent);
  }

  .wallet-info {
    display: flex;
    gap: 10px;
    align-items: center;
    font-size: 12px;
  }

  .address { color: var(--colossus-text); font-family: monospace; }
  .balance { color: var(--colossus-accent); }
  .link-bal { color: var(--colossus-accent); opacity: 0.8; }

  .chain-select {
    background-color: var(--colossus-surface);
    border: 1px solid var(--colossus-border);
    color: var(--colossus-text-dim);
    font-size: 11px;
    padding: 2px 6px;
    cursor: pointer;
    font-family: inherit;
  }
  .chain-select:focus { outline: 1px solid var(--colossus-accent); }

  .disconnect {
    background: none;
    border: 1px solid var(--colossus-border);
    color: var(--colossus-text-dim);
    padding: 2px 8px;
    font-size: 12px;
    cursor: pointer;
  }
  .disconnect:hover { color: #a13e33; border-color: #bb493c; }

  main { flex: 1; padding: 20px; max-width: 520px; margin: 0 auto; }

  .center-message {
    display: flex;
    justify-content: center;
    align-items: center;
    height: 60%;
    color: var(--colossus-text-dim);
  }

  .error { color: #a13e33; margin-bottom: 12px; font-size: 13px; }

  /* Tabs */
  .tabs {
    display: flex;
    gap: 4px;
    margin-bottom: 16px;
    border-bottom: 1px solid var(--colossus-border);
    padding-bottom: 8px;
  }

  .tab {
    background: none;
    border: 1px solid var(--colossus-border);
    color: var(--colossus-text-dim);
    padding: 6px 14px;
    font-size: 12px;
    cursor: pointer;
  }
  .tab:hover { color: var(--colossus-text); }
  .tab.active {
    background-color: var(--colossus-accent);
    color: #fff;
    border-color: var(--colossus-accent);
  }

  /* Panel */
  .panel {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .panel h3 {
    font-size: 15px;
    font-weight: 600;
    color: var(--colossus-text);
    margin: 0;
  }

  .panel-desc {
    font-size: 12px;
    color: var(--colossus-text-dim);
    margin: -4px 0 4px 0;
    line-height: 1.4;
  }

  label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: var(--colossus-text-dim);
  }

  input {
    background-color: var(--colossus-surface);
    border: 1px solid var(--colossus-border);
    color: var(--colossus-text);
    padding: 8px 10px;
    font-size: 13px;
    font-family: monospace;
    width: 100%;
    position: relative;
    z-index: 1;
  }
  input:focus { outline: 1px solid #5c2b15e3; }

  .input-row { display: flex; gap: 6px; }
  .input-row input { flex: 1; }

  .small {
    padding: 6px 12px;
    font-size: 11px;
  }

  .hint {
    font-size: 11px;
    color: var(--colossus-text-dim);
    margin: -4px 0 0 0;
  }

  /* Status */
  .status {
    padding: 8px 12px;
    margin-bottom: 12px;
    font-size: 12px;
    font-family: monospace;
    border: 1px solid var(--colossus-border);
    background-color: var(--colossus-surface);
    color: var(--colossus-text);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .status.success { border-color: #30c20b; color: #0b863f; }
  .status.err { border-color: #bb493c; color: #a13e33; }
  .status-dismiss {
    background: none;
    border: none;
    color: var(--colossus-text-dim);
    cursor: pointer;
    padding: 0 4px;
    font-size: 14px;
    line-height: 1;
  }
  .status-dismiss:hover { color: var(--colossus-text); }

  /* Basket Detail */
  .basket-detail {
    padding: 10px;
    border: 1px solid var(--colossus-border);
    background-color: var(--colossus-surface);
    font-size: 12px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .basket-detail .dim { color: var(--colossus-text-dim); }
  .basket-detail .component { font-family: monospace; font-size: 11px; }

  .component-row {
    display: flex;
    justify-content: space-between;
    font-size: 12px;
    font-family: monospace;
    padding: 2px 0;
  }
  .component-name { color: var(--colossus-accent); }
  .component-usd { color: var(--colossus-text); text-align: right; }

  .components-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 12px;
    color: var(--colossus-text-dim);
  }

  .component-input {
    display: flex;
    gap: 8px;
    align-items: flex-end;
    border: 1px solid var(--colossus-border);
    padding: 8px;
    background-color: var(--colossus-surface);
  }
  .component-input label { flex: 1; }
  .component-input .amount-input { max-width: 120px; }

  .remove-btn {
    background: none;
    border: 1px solid var(--colossus-border);
    color: var(--colossus-text-dim);
    padding: 4px 8px;
    font-size: 12px;
    cursor: pointer;
    margin-bottom: 4px;
  }
  .remove-btn:hover { color: #a13e33; border-color: #bb493c; }

  .token-badge {
    font-size: 11px;
    font-weight: 600;
    color: var(--colossus-accent);
    padding: 6px 10px;
    border: 1px solid var(--colossus-accent);
    white-space: nowrap;
    font-family: monospace;
  }

  .warning-hint {
    font-size: 11px;
    color: #c9973a;
    margin: -4px 0 0 0;
    line-height: 1.4;
    padding: 6px 8px;
    border: 1px solid #c9973a33;
    background-color: #c9973a28;
  }

  .deposit-impact {
    border-top: 1px solid var(--colossus-border);
    margin-top: 6px;
    padding-top: 6px;
  }
  .deposit-impact .dim {
    font-size: 11px;
    color: var(--colossus-text-dim);
    margin-bottom: 4px;
  }

  .nav-summary {
    border-top: 1px solid var(--colossus-border);
    margin-top: 6px;
    padding-top: 6px;
    font-size: 12px;
  }

  /* QR Modal */
  .qr-overlay {
    position: fixed; top: 0; left: 0; width: 100%; height: 100%;
    background-color: rgba(0, 0, 0, 0.8);
    display: flex; justify-content: center; align-items: center; z-index: 200;
  }
  .qr-modal {
    background-color: var(--colossus-surface);
    border: 1px solid var(--colossus-border);
    padding: 24px;
    display: flex; flex-direction: column; align-items: center; gap: 12px;
    max-width: 360px; width: 100%;
  }
  .qr-modal h3 { font-size: 15px; font-weight: 600; color: var(--colossus-text); margin: 0; }
  .wallet-buttons { display: flex; gap: 6px; width: 100%; }
  .wallet-btn {
    flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4px;
    background-color: transparent; border: 1px solid var(--colossus-border);
    color: var(--colossus-text); padding: 10px 6px; font-size: 11px; cursor: pointer;
  }
  .wallet-btn:hover {
    background-color: var(--colossus-accent); color: #fff;
    border-color: var(--colossus-accent); opacity: 1;
  }
  .wallet-icon { font-size: 20px; }
  .divider {
    width: 100%; display: flex; align-items: center; gap: 12px;
    color: var(--colossus-text-dim); font-size: 11px;
  }
  .divider::before, .divider::after {
    content: ""; flex: 1; height: 1px; background-color: var(--colossus-border);
  }
  .qr-image { width: 240px; height: 240px; image-rendering: pixelated; }
  .qr-hint { font-size: 10px; color: var(--colossus-text-dim); text-align: center; margin: 0; }
  .cancel-btn {
    background: none; border: 1px solid var(--colossus-border);
    color: var(--colossus-text-dim); padding: 8px 24px; font-size: 12px;
    cursor: pointer; width: 100%;
  }
  .cancel-btn:hover { color: #a13e33; border-color: #bb493c; }

  /* Bridge */
  select {
    background-color: var(--colossus-surface);
    border: 1px solid var(--colossus-border);
    color: var(--colossus-text);
    padding: 8px 10px;
    font-size: 13px;
    font-family: monospace;
    width: 100%;
    cursor: pointer;
  }
  select:focus { outline: 1px solid #5c2b15e3; }

  .hint-inline {
    font-weight: 400;
    opacity: 0.6;
    font-size: 11px;
  }

  .ccip-link {
    padding: 10px;
    border: 1px solid var(--colossus-accent);
    background-color: rgba(55, 91, 210, 0.08);
    text-align: center;
  }
  .ccip-link a {
    color: var(--colossus-accent);
    text-decoration: none;
    font-size: 13px;
    font-weight: 600;
  }
  .ccip-link a:hover { text-decoration: underline; }
  .ccip-link .hint { margin-top: 6px; }

  /* CRE Verification */
  .cre-verify-btn {
    background: none;
    border: 1px solid var(--colossus-accent);
    color: var(--colossus-accent);
    padding: 8px 16px;
    font-size: 12px;
    font-family: monospace;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .cre-verify-btn:hover:not(:disabled) {
    background-color: var(--colossus-accent);
    color: #fff;
  }
  .cre-verify-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .cre-result {
    padding: 10px 12px;
    border: 1px solid var(--colossus-border);
    background-color: var(--colossus-surface);
    font-size: 12px;
    font-family: monospace;
  }
  .cre-result.cre-pass {
    border-color: #30c20b;
    background-color: rgba(48, 194, 11, 0.06);
  }
  .cre-result.cre-fail {
    border-color: #bb493c;
    background-color: rgba(187, 73, 60, 0.06);
  }
  .cre-result-header {
    margin: 0 0 4px 0;
    font-weight: 600;
    color: var(--colossus-text);
  }
  .cre-result-dim {
    font-weight: 400;
    opacity: 0.6;
  }
  .cre-result-line {
    margin: 2px 0;
    color: var(--colossus-text-dim);
    font-size: 11px;
  }
  .cre-result.cre-analysis {
    border-color: var(--colossus-accent);
    background-color: rgba(55, 91, 210, 0.06);
    margin-top: 8px;
  }
  .cre-analysis-text {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--colossus-border);
    color: var(--colossus-text);
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
  }
  .cre-close-btn {
    position: absolute;
    top: 6px;
    right: 8px;
    background: none;
    border: none;
    color: var(--colossus-text-dim);
    font-size: 14px;
    cursor: pointer;
    padding: 2px 6px;
    line-height: 1;
    opacity: 0.6;
    transition: opacity 0.15s ease;
  }
  .cre-close-btn:hover {
    opacity: 1;
    color: var(--colossus-text);
  }
  .cre-result.cre-nav {
    border-color: #30c20b;
    background-color: rgba(48, 194, 11, 0.06);
  }
  .cre-nav-entry {
    padding: 4px 0;
  }
  .cre-nav-entry + .cre-nav-entry {
    border-top: 1px solid var(--colossus-border);
    margin-top: 4px;
  }

  /* CCC Private Holdings */
  .ccc-card {
    background: linear-gradient(135deg, #140935 25%, #4A21C2 75%);
    border: 1px solid rgba(55, 91, 210, 0.3);
    border-radius: 12px;
    padding: 20px;
    margin-top: 16px;
  }
  .ccc-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
  }
  .ccc-title-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .ccc-lock { font-size: 14px; }
  .ccc-label {
    font-size: 14px;
    font-weight: 600;
    color: #bac9dd;
    letter-spacing: 0.5px;
    text-transform: uppercase;
  }
  .ccc-badge {
    font-size: 10px;
    background: rgba(55, 91, 210, 0.2);
    color: var(--colossus-accent);
    padding: 2px 6px;
    border-radius: 4px;
    font-weight: 500;
  }
  .ccc-error {
    color: #e53e3e;
    font-size: 12px;
    padding: 8px 0;
  }
  .ccc-balances {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .ccc-balance-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 12px;
    background: rgba(255, 255, 255, 0.03);
    border-radius: 8px;
  }
  .ccc-symbol {
    color: #e2e8f0;
    font-weight: 500;
  }
  .ccc-amount {
    color: #a0aec0;
    font-family: monospace;
  }
  .ccc-footnote {
    margin-top: 10px;
    font-size: 11px;
    color: #718096;
    text-align: center;
  }
  .ccc-prompt {
    color: #91a6cc;
    font-size: 13px;
    text-align: center;
    padding: 12px 0;
  }
  .ccc-reveal-btn {
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.25);
    color: #e2e8f0;
    padding: 6px 12px;
    border-radius: 6px;
    font-size: 12px;
    font-family: monospace;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .ccc-reveal-btn:hover:not(:disabled) {
    background-color: var(--colossus-accent);
    border-color: var(--colossus-accent);
    color: #fff;
  }
  .ccc-reveal-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  /* CCC — CRE Workflow Section */
  .ccc-cre-section {
    margin-top: 16px;
    padding-top: 14px;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
  }
  .ccc-cre-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
  }
  .ccc-cre-input-row {
    display: flex;
    gap: 8px;
    align-items: flex-end;
    margin-bottom: 10px;
  }
  .ccc-cre-label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: #a0aec0;
    flex: 0 0 80px;
  }
  .ccc-cre-input {
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.15);
    color: #e2e8f0;
    padding: 6px 8px;
    font-size: 13px;
    font-family: monospace;
    border-radius: 4px;
    width: 100%;
  }
  .ccc-cre-input:focus {
    outline: 1px solid var(--colossus-accent);
  }
  .ccc-cre-result {
    padding: 10px 12px;
    border-radius: 8px;
    font-size: 12px;
    font-family: monospace;
    margin-top: 8px;
  }
  .ccc-cre-nav {
    border: 1px solid rgba(48, 194, 11, 0.4);
    background: rgba(48, 194, 11, 0.08);
  }
  .ccc-cre-analysis {
    border: 1px solid rgba(55, 91, 210, 0.4);
    background: rgba(55, 91, 210, 0.08);
  }
  .ccc-cre-error-box {
    border: 1px solid rgba(187, 73, 60, 0.4);
    background: rgba(187, 73, 60, 0.08);
  }
  .ccc-cre-result .cre-result-header { color: #e2e8f0; }
  .ccc-cre-result .cre-result-line { color: #b4c1d1; }
  .ccc-cre-result .cre-result-dim { color: #a9bad4; }
</style>