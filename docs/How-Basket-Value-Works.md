**How the contract works:** Each basket defines a fixed recipe per unit. Say a Basket is defined as 10 LINK + 0.01 WETH per unit.

**The scenario at $100/unit:**

| Action                  | Units  | Deposited to Escrow      | Each unit redeemable for |
| ----------------------- | ------ | ------------------------ | ------------------------ |
| Initial weave (2 units) | 2      | 20 LINK + 0.02 WETH      | 10 LINK + 0.01 WETH      |
| Splice 15 more units    | +15    | +150 LINK + 0.15 WETH    | 10 LINK + 0.01 WETH      |
| **Total**               | **17** | **170 LINK + 0.17 WETH** | **10 LINK + 0.01 WETH**  |

****Each unit is still worth 100.**** There's no dilution. Every new unit requires the full deposit of underlying tokens at the defined ratio. The person splicing paid $1,500 in tokens to mint those 15 new units.

**This** is fundamentally different from stocks or fund shares where new issuance can dilute. Here, every unit is **fully backed 1:1** by the escrowed tokens. The escrow always holds exactly `totalSupply × amountPerUnit` for each component.

**What changes unit value?** Only market prices. If LINK doubles next month, each unit is worth ~$150 regardless of whether there are 2 units or 17.

**Colossus calculates this correctly.** The NAV logic (both `priceFeed.ts` and `basket-nav` CRE workflow) computes: unit value = Σ(component amount × USD price). Portfolio total = unit value × user's balance. The number of outstanding units doesn't factor in — each unit is an independent, fully-backed claim.

**For a DCA or scheduled-emittance this is perfect:** a user sets "splice 1 unit of Basket #4 every month." Each month they deposit the fixed component amounts at whatever the current market prices are. Dollar-cost averaging into a diversified basket.

**The baskets are fungible.** They're ERC-1155 tokens. Once transferred, the recipient has full control — they can unweave and redeem the underlying tokens themselves. The creator has no special privilege after distribution.

**Quick scenario using the 17 units above:**

| Holder  | Balance  | Can unweave | Receives            |
| ------- | -------- | ----------- | ------------------- |
| Creator | 2 units  | up to 2     | 20 LINK + 0.02 WETH |
| Buyer A | 10 units | up to 10    | 100 LINK + 0.1 WETH |
| Buyer B | 5 units  | up to 5     | 50 LINK + 0.05 WETH |

No one can touch anyone else's units. The escrow always has exactly enough to cover all outstanding units.