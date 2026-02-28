# Colossus: Universal Asset Baskets — On-Chain Securitization Powered by Chainlink CRE

Weave any combination of ERC-20, ERC-721, and ERC-1155 tokens into a single, transferable, cross-chain basket token — then bridge, trade, verify, or redeem anywhere.

***Anything that can be tokenized can be put in the basket.***

---

## The Vision: On-Chain Securitization

Securitization is how Wall Street packages mortgages, CDOs, receivables, and other assets into standardized tradeable units. Rating agencies verify. Intermediaries distribute. Settlement takes days.

Colossus does the same thing on-chain — with Chainlink DONs replacing rating agencies, CCIP replacing intermediaries, ACE enforcing compliance, CCC preserving privacy, and settlement in minutes:

- **Weave** = package any tokenized assets into a basket (securitize)
- **Unweave** = redeem underlying tokens (full transparency, instant settlement)
- **Splice** = update basket composition, schedule DCA/cron-based basket rebalancing (planned — see Splice section below)
- **NAV** = verified per-unit value computed on Chainlink's DON (not a black box)
- **CCIP** = basket tokens move cross-chain while underlying assets stay in escrow on the home chain
- **ACE** = automated compliance enforcement — policy-gated basket creation and weaving
- **CCC** = confidential compute — private holdings, private NAV, private compliance (see CCC section below)

### Why "Universal Asset Baskets"?

The mental model is not "ETFs for crypto tokens." The model is: **anything that can be tokenized can be put in the basket.**

This is fundamentally different from stocks or fund shares where new issuance can dilute. Here, every unit is **fully backed 1:1** by escrowed tokens. The escrow always holds exactly `totalSupply × amountPerUnit` for each component. No fractional reserve, no manager discretion — pure on-chain custody.

This is why Colossus supports all three ERC standards:

- **ERC-20**: fungible tokens — currencies, stablecoins, payment streams
- **ERC-721**: non-fungible tokens — deeds, titles, unique certificates
- **ERC-1155**: semi-fungible tokens — fractional ownership, batched assets, tickets

A basket can hold all three at once. This makes Colossus a general-purpose securitization layer, not just a DeFi index fund.

### Why Does This Need to Exist?

Traditional securitization is slow, opaque, and intermediary-heavy. The 2008 financial crisis showed what happens when rating agencies can't or won't verify what's actually in the package. Colossus fixes this at the infrastructure level:

1. **Trustless**: No intermediary handles your assets. Smart contract escrow holds everything; DONs verify composition and value independently. A spoofed frontend cannot trick the protocol.
2. **Transparent yet private**: Every basket's composition is verifiable on-chain, but with CCC, institutional portfolios can be computed confidentially — DONs rate what they can't see.
3. **User-friendly complexity**: Weaving a multi-asset, multi-standard, cross-chain basket — something that would require lawyers, custodians, and rating agencies in TradFi — is a single transaction.
4. **Deterministic redemption**: Unlike fund shares subject to NAV calculations and redemption windows, every basket unit unweaves to *exactly* the underlying tokens. Always. Instantly.

### Market Context

The tokenized RWA market grew from $1.2B (Jan 2023) to ~$25B (Jan 2026) — a 20x increase in three years. Projections range from $100B by end of 2026 (Centrifuge, Bitfinex) to $18.9T by 2033 (BCG/Ripple). BlackRock, JPMorgan, UBS, and Goldman Sachs are actively deploying tokenized products.

As more diverse asset types come on-chain — not just Treasuries but real estate deeds, private credit, carbon credits, art certificates, supply chain receivables — the need for a general-purpose *packaging layer* becomes critical. Tokenization platforms create individual assets. **Colossus packages them.**

### Example: Real Estate Securitization

An enterprise client — call them "Blacktower Capital" — holds 50 property deeds as ERC-721 tokens on their private chain. They:

1. **Weave** all 50 deeds into a single basket — creating 10 units (5 deeds per unit)
2. **Verify** the basket's value on-DON via basket-nav before listing
3. **Bridge** 10 basket units via CCIP to Ethereum's public chain for auction
4. Buyers can **verify** basket contents on-DON (colossus-verify) and **monitor value** via NAV (basket-nav) — no trust required
5. **ACE compliance** ensures only KYC-verified wallets can participate
6. Any holder can **unweave** their units to claim the underlying deeds — trustless redemption

Replace "deeds" with mortgages, CDOs, carbon credits, supply chain receivables, art certificates, concert tickets — the framework is the same. As long as the proper Chainlink infrastructure exists on both chains, the full cycle works: package → verify → bridge → trade → redeem.

---

## Splice — Scheduled Basket Updates (Planned)

The Splice tab in the dApp is designed to let basket owners update their baskets over time:

- **Add/remove components**: Rebalance a basket by adding new tokens or removing existing ones
- **DCA (Dollar-Cost Averaging)**: Schedule periodic weaves — e.g., weave 10 LINK into the basket every week
- **Cron-based rebalancing**: Automated basket updates on a schedule, powered by Chainlink Automation (Keepers)
- **Description updates**: Attach metadata or notes to a basket

This turns baskets from static snapshots into living portfolios. The on-chain infrastructure (Escrow, BasketFactory) already supports component modifications — Splice is the user-facing orchestration layer.

**Status**: UI tab exists with CRE verification integration. Core scheduling logic is a post-hackathon feature. The dApp currently supports manual splice operations (adding units/components to existing baskets).

---

## Six CRE Workflows — DONs Replace Rating Agencies

In traditional securitization, you trust rating agencies (Moody's, S&P) to verify and value packaged assets. In Colossus, Chainlink DONs provide the same functions — trustlessly. Four standard workflows use CRE's HTTPClient; two confidential workflows use CRE's ConfidentialHTTPClient for privacy-preserving external API calls:

### 1. colossus-verify — Pre-Weave Fund Verification

- **What**: Given a wallet address and token list, the DON independently reads on-chain ERC-20 balances and confirms the user holds sufficient tokens for the requested weave (balance ≥ amountPerUnit × units)
- **Why**: This is the trust boundary. Before a user weaves tokens into a basket, Colossus doesn't trust the browser's balance display — the DON reads the blockchain directly and verifies the wallet actually holds what it claims. A compromised or spoofed frontend cannot trick the protocol into weaving tokens the user doesn't have
- **Multi-chain**: Works on both Sepolia and Base Sepolia — the dApp passes chainId and the workflow executes on the appropriate chain
- **Production vision**: Integrated directly into the weave flow as a required pre-check. The dApp calls the CRE workflow, receives the verification result, and only proceeds to weave if the DON confirms sufficient balances. No single point of trust in the entire pipeline

### 2. basket-nav — Per-Unit NAV Calculation

- **What**: Reads basket components from BasketFactory, prices each via Chainlink price feeds, sums to per-unit NAV in USD
- **Why**: The verified, on-DON valuation of one basket unit — like a prospectus price, but computed trustlessly. The dApp multiplies units × NAV for total portfolio value. Basket definition lives on the home chain, so NAV reads the home chain even after units are bridged cross-chain via CCIP
- **Multi-chain**: Chain-aware with per-chain price feed addresses and LINK token addresses
- **Production vision**: This becomes an on-DON price feed itself. Other protocols can consume basket NAV as a Chainlink data feed — enabling secondary markets, collateralized lending against basket units, etc.

### 3. basket-analysis — AI-Powered Portfolio Analysis

- **What**: Reads basket composition on-chain, queries Space and Time (SXT) for mainnet token analytics (transfer counts, activity dates), fetches live market data from CoinGecko (market cap, 24h volume, 24h price change), sends everything to Claude for portfolio analysis
- **Why**: Demonstrates CRE orchestrating four heterogeneous data sources in a single workflow — blockchain reads, external database, external market data API, and LLM inference. This is the kind of complex multi-source orchestration that CRE was built for
- **Multi-chain**: Chain-aware with per-chain factory addresses and token mappings
- **Execution**: ~42 seconds (SXT + CoinGecko + Claude), Sonnet primary with Haiku fallback for 529 overload

### 4. basket-compliance — On-DON Policy Verification

- **What**: Reads PolicyEngine state on-chain — checks whether a wallet is allowed to weave a given basket under current ACE policies. Four sequential reads: basket existence → PolicyEngine address → attached policies → per-wallet authorization
- **Why**: Compliance verification on-DON. Before weaving, the DON can independently confirm that the caller passes all attached policies (allowlists, volume caps, identity checks). This is the decentralized equivalent of a compliance officer reviewing a trade before execution
- **How it complements ACE**: The on-chain PolicyEngine enforces policies at transaction time (revert if non-compliant). The basket-compliance workflow provides a *pre-flight check* — the DON reads the same state and tells you whether the transaction would succeed, without spending gas on a revert

### 5. ccc-basket-nav — Confidential NAV Calculation

- **What**: Same per-unit NAV computation as basket-nav, but external API calls (CoinGecko price cross-check) route through CRE's `ConfidentialHTTPClient` — secrets never leave the TEE enclave
- **Why**: Demonstrates the CRE → CCC upgrade path. The workflow reads basket composition on-chain (standard EVM reads), then fetches market prices via confidential HTTP with secret template injection (`{{.secretName}}` in headers). The DON computes NAV without exposing API credentials or request patterns to other nodes
- **SDK reality**: The ConfidentialHTTPClient API discovered in the TypeScript SDK differs significantly from the CRE documentation — `confClient.sendRequest(runtime, request).result()` rather than the callback/consensus pattern shown in docs. This is documented in the project as a reference for other CRE developers

### 6. ccc-basket-analysis — Confidential AI Analysis

- **What**: Same multi-source portfolio analysis as basket-analysis, but CoinGecko and Claude API calls route through `ConfidentialHTTPClient`. Blockchain reads remain standard EVM calls. SXT is excluded due to the ConfidentialHTTPClient's ~30s hard timeout (SXT queries exceed this)
- **Why**: Demonstrates confidential LLM inference on-DON — the Claude API key and the portfolio data sent to the LLM are both shielded inside the enclave. The workflow gracefully degrades from 4 to 3 data sources (blockchain + CoinGecko + Claude), which we frame as resilient design: the system produces useful output even when a data source is unavailable
- **Execution**: Faster than standard basket-analysis (~30s vs ~42s) because SXT is skipped. CoinGecko and Claude both complete well within the 30s confidential HTTP cap

---

## Chainlink Confidential Compute (CCC) — Private Portfolios

### The Privacy Problem

Today's CRE workflows run in plaintext — acceptable for testnet demos, but institutional portfolios require confidentiality. A fund manager publishing basket NAV reveals their holdings. A compliance check exposes identity data. A cross-chain transfer leaks trading strategy. Privacy is the barrier between DeFi infrastructure and institutional adoption.

### What Colossus Has Today

Colossus integrates Chainlink's CCC infrastructure at two levels — **private token storage** and **confidential workflow execution**:

**CCC Vault (Private Holdings):**
- 5 LINK deposited in CCC vault on Sepolia — genuinely shielded, invisible on-chain
- EIP-712 authenticated balance retrieval (private balance reveal on user's request only)
- "Private Holdings" card in Portfolio tab showing CCC vault balances alongside on-chain baskets

**ConfidentialHTTPClient Workflows (CRE + CCC Convergence):**
- Two CRE workflows (`ccc-basket-nav`, `ccc-basket-analysis`) use CRE's `ConfidentialHTTPClient` instead of the standard `HTTPClient`
- External API calls (CoinGecko, Claude AI) route through confidential channels — API keys injected via secret templates (`{{.keyName}}`), never exposed to other DON nodes
- Both workflows are verified, wired into the dApp, and callable from the CCC card's "Verify NAV" and "Analyze" buttons
- This is not theoretical — it runs today in CRE simulation, demonstrating the same execution model that production CCC will use

This demonstrates the converged UX: private holdings, confidential computation, and DON-verified analysis in one interface.

### What CCC Enables in Production

Chainlink Confidential Compute (Early Access 2026) enables CRE workflows to execute inside TEE enclaves — DON nodes process data without observing it. Because CCC is native to CRE, existing Colossus workflows upgrade to confidential execution with minimal code changes — the same workflow definitions, just a confidential runtime flag.

**Colossus + CCC unlocks:**

- **Private NAV computation**: Fund managers publish verified NAV without revealing holdings. DONs compute basket value inside TEE, never observing composition. This is how "DONs replace rating agencies" reaches full strength — rating agencies that can't see the portfolio they're rating means zero information leakage.
- **Confidential compliance checks**: Prove KYC/AML compliance without exposing identity data to the network. The DON verifies a wallet passes policy requirements inside the enclave and returns only a boolean.
- **Private cross-chain transfers**: CCIP basket movements without revealing strategy, amounts, or destination chain to on-chain observers.

### Honest Framing

Today Colossus demonstrates CCC at two levels: private token storage (vault) and confidential external API calls (ConfidentialHTTPClient workflows). What we don't yet have is the full TEE-enclave execution where the DON processes *on-chain data* confidentially — that requires CCC Early Access (2026). The ConfidentialHTTPClient is the first piece of that architecture: outbound HTTP requests are already confidential; inbound EVM reads will follow when CCC matures.

The progression is real and demonstrable: standard CRE workflows → ConfidentialHTTPClient workflows (today) → full TEE-enclave execution (CCC Early Access). Colossus is already one step along that path, not just planning for it.

This aligns with institutional demand. The CCC whitepaper (Breidenbach et al.) cites use cases from UBS and J.P. Morgan — organizations that need exactly this: verified computation on data they can't allow third parties to observe.

---

## ACE PolicyEngine — Automated Compliance

V4 contracts integrate Chainlink's Automated Compliance Engine (ACE), adding policy-gated access control to basket operations:

- **PolicyProtected**: BasketFactory inherits `PolicyProtected` from `chainlink-ace`. The `runPolicy` modifier on `weave()` and `createBasket()` delegates to the PolicyEngine before execution
- **Pluggable policies**: CallerAllowPolicy (allowlist-based access control) is deployed and attached. ACE supports composable policies — multiple policies per function selector, VolumePolicy (caps), custom Solidity policies with parameter extraction, and CCID (Chainlink Compliance Identity)
- **Bridge ungated by design**: `bridgeRelease()` and `registerBasketFromBridge()` have no policy modifier — compliance is enforced at the entry point (weave/create), not at the infrastructure layer. Bridge addresses would need whitelisting otherwise, adding complexity without security benefit
- **defaultAllow toggle**: `defaultAllow=true` means everything passes unless restricted. Toggle to `false` to enforce deny-by-default with explicit policy allowances
- **Fully configured on both chains**: Sepolia and Base Sepolia both have PolicyEngine proxy, CallerAllowPolicy attached to weave + createBasket selectors, test address allowlisted

### Why ACE Matters for Securitization

Real-world securitization is heavily regulated. ACE makes Colossus enterprise-ready:

- **KYC/AML gating**: Only verified wallets can create or invest in baskets
- **Jurisdictional compliance**: Different policies per chain or per basket type
- **Volume caps**: Limit exposure per wallet or per basket (VolumePolicy)
- **Composable rules**: Stack multiple policies — e.g., allowlisted AND under volume cap AND CCID-verified

This is the bridge between DeFi composability and TradFi compliance requirements. No other basket/index protocol has on-chain compliance enforcement.

### Production Vision: Compliance Management

In production, compliance management moves to a dedicated admin dashboard — role-separated from the end-user dApp. Policy updates, allowlist management, and audit logs would be surfaced to Compliance Officers through a purpose-built interface, while end users simply experience seamless policy enforcement. The basket-compliance CRE workflow demonstrates the on-DON verification layer that underpins this: four sequential on-chain reads confirming basket existence, PolicyEngine attachment, active policies, and per-wallet authorization — all executed trustlessly by the DON.

---

## Competitive Positioning

The on-chain structured products space is fragmented. Here's where Colossus sits:

### vs. Index Protocols (Index Coop, SoSoValue)
They package fungible tokens into curated index products. Colossus packages *any* tokenized asset — deeds, invoices, carbon credits, stablecoins — into permissionless, cross-chain baskets with DON verification and compliance enforcement. Index Coop TVL has declined from $500M (2021) to ~$25M (2026). The market needs something broader than ERC-20 index funds.

### vs. Asset Management (Enzyme Finance)
Enzyme is the closest competitor — they also integrated Chainlink CRE for NAV reporting. But Enzyme is a fund management platform: you trust a manager to make good decisions. Colossus baskets are trustlessly verifiable — no manager, no trust assumption. The DON confirms what's in the basket and what it's worth. Different trust models for different use cases.

### vs. Liquidity Protocols (Balancer)
Balancer pools have impermanent loss and slippage. Every Colossus basket unit redeems for *exactly* the underlying tokens. Deterministic, not probabilistic.

### vs. RWA Tokenization (Ondo, Centrifuge, Securitize)
These platforms *create* individual tokenized assets. Colossus *packages* them. Complementary, not competitive. Ondo tokenizes a Treasury bond; Centrifuge tokenizes an invoice as an NFT; Colossus weaves both into a single diversified basket and bridges it cross-chain. Colossus is the packaging layer between tokenization and distribution.

### The Gap Nobody Fills

No single project combines: multi-standard baskets (ERC-20/721/1155) + cross-chain CCIP bridging + DON-verified NAV + DON-verified compliance + AI-powered analysis + ACE policy enforcement + confidential compute workflows (ConfidentialHTTPClient). That combination is uniquely Colossus.

---

## Key Technical Highlights

### Multi-Standard Baskets — The Core Differentiator

- ERC-20, ERC-721, and ERC-1155 tokens can be bundled together in a single basket
- This is not a DeFi feature — it's a **securitization primitive**. Real-world asset portfolios are heterogeneous: a basket might contain fungible payment tokens (ERC-20), unique deeds (ERC-721), and fractional ownership certificates (ERC-1155) simultaneously
- NFT rule: baskets containing ERC-721 enforce units = 1 (can't fractionalize unique assets)
- Enterprise use case: 1,000 RWAs → 4 baskets of 250 → each basket is 1 auctionable unit

### Cross-Chain via CCIP

- Basket ERC-1155 tokens bridge between Sepolia ↔ Base Sepolia
- Underlying tokens stay locked in escrow on the home chain
- Remote unweave: burn on destination chain → CCIP message to home chain → escrow releases → tokens forwarded via second CCIP hop
- Enterprise implication: Private chain tokens can be bridged to public chains for trading — CCIP provides the infrastructure for moving enterprise assets across chain boundaries

### Multi-Chain CRE — Chain-Agnostic Computation

- All five HTTP-triggered CRE workflows (verify, NAV, analysis + two confidential variants) work on both Sepolia and Base Sepolia
- The dApp passes chainId → CRE bridge maps to chainSelectorName → workflow executes on the appropriate chain
- Same workflow code, same verification logic, any chain — this demonstrates CRE's chain-agnostic compute model
- As RWAs deploy across Ethereum, Base, Avalanche, Polygon, and private chains, chain-agnostic basket infrastructure becomes critical

### SXT Scalability

- Space and Time's indexed blockchain data enables analytics on baskets with 1000+ components
- Single SQL query with GROUP BY instead of N individual queries
- Mainnet data indexed (Sepolia not available) — testnet addresses mapped to mainnet equivalents

### Architecture: Browser + DON Parity

- `priceFeed.ts` (frontend) and `basket-nav` (CRE) use the same Chainlink feeds and math
- Frontend provides snappy UI pricing; CRE provides verified/official NAV on-DON
- Same feeds, same logic, different execution environments — the DON is the trustless verification layer that makes baskets auditable without intermediaries

### Scaling: NAV for Enterprise Baskets

The `basket-nav` CRE workflow currently reads one Chainlink price feed per component via individual EVM calls. CRE workflows have a 10 EVM read limit per execution, and after optimization the read budget is **1 + N** (one `getComponents` call plus one `latestRoundData` per component). This supports baskets up to ~8 components (9 if LINK is included, since its price is reused for fee calculation).

For enterprise-scale baskets with hundreds or thousands of RWA components, two production-ready paths have been identified and partially validated:

**Path 1 — On-chain Multicall contract.** Deploy a Solidity helper with a function like `getPrices(address[] feeds)` that loops through all feeds internally and returns an array of prices. CRE reads the result in a single EVM call. One read, unlimited components. This is the cleanest on-chain solution and maintains full Chainlink price feed verification.

**Path 2 — SXT price feed indexing.** Space and Time indexes Chainlink price feed update events on Ethereum mainnet. A single SQL query could return the latest price for every component in the basket, regardless of count. The `basket-analysis` workflow already demonstrates this exact pattern — one SXT query covers all components via GROUP BY. Applying it to price feeds uses the same architecture. The current limitation is that SXT does not index testnets, so this path cannot be demonstrated on Sepolia.

Both paths are additive to the existing architecture. The `basket-analysis` workflow already proves CRE can orchestrate SXT queries at scale (1000+ components in a single call), and the multicall pattern is straightforward Solidity.

---

## Fee Model

- 0.1% of bundled value at weave time
- Collected in LINK tokens
- Immutable fee recipient address hardcoded in contracts
- No governance overhead

---

## Tech Stack

- **Frontend**: Tauri v2 + Svelte 5 (runes)
- **Wallet**: viem + wagmi, WalletConnect (Tauri) + MetaMask (browser)
- **Contracts**: Solidity 0.8.28, Foundry, via_ir optimization
- **Compliance**: Chainlink ACE PolicyEngine (V4, both chains)
- **Privacy**: Chainlink CCC vault (EIP-712 auth, private balances) + ConfidentialHTTPClient workflows
- **CRE**: TypeScript SDK v1.1.1, Bun runtime, 6 workflows (4 standard + 2 confidential)
- **Bridge Server**: Bun HTTP server, 6 endpoints (verify, nav, analyze, ccc-balances, nav-ccc, analyze-ccc), chain-aware
- **Chains**: Ethereum Sepolia + Base Sepolia (testnet, dual-chain deployment)
- **External**: Space and Time API, CoinGecko API, Claude API (Anthropic)

---

## The Full Chainlink Stack

Colossus is a showcase of what's possible when you build on the complete Chainlink infrastructure:

| Chainlink Service | Colossus Usage |
|---|---|
| **CRE** | 6 workflows: fund verification, NAV pricing, AI analysis, compliance checking + 2 confidential variants (ConfidentialHTTPClient) |
| **CCIP** | Cross-chain basket bridging (Sepolia ↔ Base Sepolia) |
| **ACE** | PolicyEngine with CallerAllowPolicy on weave + createBasket |
| **CCC** | Private token vault, EIP-712 balance auth, ConfidentialHTTPClient workflows (NAV + analysis) |
| **Price Feeds** | LINK/USD + ETH/USD on both chains for NAV calculation |
| **Data Feeds** | SXT integration for mainnet analytics at scale |

Every layer of Chainlink's infrastructure stack is integrated into a single, coherent application.
