# On-chain DEX prices as the committee's mainnet source for crypto: an assessment

Status 2026-10-17: a proposal, **nothing built**. The context: no current CEX or aggregator source allows publishing
derived prices without a licence (docs/ORACLE-SOURCES-TERMS.md), and the committee oracle (docs/ORACLE-HARDENING.md
(a)) is approved.
- The ECB stays for daily forex.
- No stocks or commodities on mainnet until licensed.

## The idea

Each committee member reads BTC and ETH against USDC from the deepest Uniswap pools on Ethereum, Base and Arbitrum,
from its own nodes or from several independent RPC providers. It computes the same aggregate and signs it.

One property makes this better than CEX APIs for a committee: **the reading can be exact and identical for every
member.**
1. Each member calls the pool's `observe()` at a fixed block: the last block whose timestamp is at or before the
   close.
2. They all get the same tick cumulatives, so the same TWAP and the same root. The members do not need a tolerance
   to agree.
3. A member that disagrees is reading a wrong node.

## Aggregation

1. **The pools.** On each chain, the v3 pools of the pair with an in-range liquidity of at least a minimum, e.g. $5M
   within ±2% of the price, measured at the same block.
   - ETH: WETH/USDC 0.05% and 0.3% on Ethereum, Base and Arbitrum.
   - BTC: WBTC/USDC and cbBTC/USDC (see the risks: wrapped BTC).
   - **Uniswap v4 pools have no built-in oracle** (one needs a hook), so v4 counts only through a pool with a known
     oracle hook. Until then, v3.
2. **The TWAP per pool:** the geometric mean over the last 5 minutes before the close,
   `1.0001^((tickCum(t) − tickCum(t − 300 s)) / 300)`. The pool needs enough observation cardinality for a 5-minute
   window; we can raise it ourselves with `increaseObservationCardinalityNext`, for a one-time gas cost.
3. **The median:** across the qualifying pools, with **Ethereum mainnet pools as the anchor**. The round is valid only
   if:
   - at least 3 pools qualify, at least one of them on Ethereum;
   - the median is within a tolerance (e.g. 0.5%) of the Ethereum pools' value.
4. **Failure:** a round that fails is not committed. A market without a close round in 24 h is Void, as today.

## Risks

- **Manipulation on Ethereum (proof of stake).**
  - Moving a TWAP needs the price held away from the market for its whole window, against arbitrage.
  - Uniswap's own study of USDC/WETH 0.05%: moving a 30-minute TWAP 20% with two consecutive blocks needs a
    prohibitive swap. With three blocks it costs about $1 billion. Longer attacks need a validator that proposes
    several consecutive blocks.
  - **Our 5-minute window is 6× shorter, so cheaper to move.** Keep markets small next to that cost, and consider
    10–15 minutes.
  - Wide-range liquidity in the pool raises the cost the most (about $360 billion more for a two-block attack per
    $1M wide-range position, per that study). We could add a modest wide-range position ourselves.
- **L2 sequencers (Base, Arbitrum).**
  - A single sequencer orders every block. It could hold a price away for the whole window while keeping arbitrage
    out, at little cost.
  - So L2 pools only confirm the anchor: they never decide alone, and the 0.5% check against Ethereum guards that.
- **Wrapped BTC.**
  - WBTC, cbBTC and tBTC are claims on BTC held by custodians or bridges. A custodian problem moves their price away
    from BTC. That is why pools of two different wrappers count.
  - Define the market as "BTC (wrapped, against USDC, on-chain)". Or require WBTC and cbBTC to agree within 1%, else
    no round.
- **USDC.** All prices are in USDC, not USD; USDC fell to about 0.88 in March 2023. The market rules say "price in
  USDC". A USD conversion would need a licensed USDC/USD rate.
- **Gap to CEX.**
  - DEX prices follow CEX prices within seconds through arbitrage.
  - A 5-minute TWAP lags a fast move by about half its window, so in a sharp move at the close it differs from the
    CEX spot of that second.
  - For BTC and ETH on deep pools the difference is usually well under 0.1%, more in volatile minutes. The markets
    settle on this reference, so it is a definition, not an error, but the wallet must say so.
- **Reorgs:** read at a block old enough to be safe (Ethereum: finalized, about 13 minutes; L2s: their finality). So
  the round for a close is committed about 15 minutes after it.

## Terms

- **Uniswap pools:** the protocol's state is public chain data, and no licence covers reading it. Uniswap Labs' terms
  cover their interface and APIs, not the contracts.
- **RPC providers:** the terms we read are restrictive.
  - Alchemy, version 2.0 of 2025-06-27: use is "solely for your internal business purposes". It forbids reselling,
    automated downloading or scraping of data, and building products that compete with the service.
  - Whether a few `eth_call`s an hour feeding an oracle are within that is a question for the legal review.
  - Infura and QuickNode are to be read the same way.
- **The clean answer: each member runs its own nodes**, or a light client.
  - Own nodes: Ethereum (a full node, about 2 TB of SSD; `observe` at a recent block needs no archive) and the L2s
    (each a full node, or the L2's node following our own Ethereum node).
  - A light client: **Helios** verifies execution results against proofs from an untrusted RPC, so the RPC is only
    bandwidth. Its terms matter less, but read them anyway.
- **Chainlink:**
  - Its feeds can technically be read on-chain by anyone.
  - Their data comes from licensed providers, and the docs link Chainlink's Terms of Use (chain.link/terms). That
    page could not be retrieved for this note: read it in the review.
  - **Until it says otherwise, assume a Chainlink feed may not be republished as an input to another oracle.** At
    most it can be a private cross-check that never enters the committed value.

## Beyond BTC and ETH (assessed 2026-10-17)

The liquidity figures are each pool's **total value locked** on Uniswap v3, Ethereum, from DexPaprika and GeckoTerminal
on 2026-10-17. **In-range liquidity is lower**, often much lower. Before a ticker is listed, the reader measures it
at a block (≥ $5M within ±2% of the price). A token priced against WETH is converted through the WETH/USDC TWAP of
the same window.

| Ticker | Source | Liquidity (TVL, Ethereum) | Verdict |
| --- | --- | --- | --- |
| ETH | WETH/USDC (two fee tiers), WETH/USDT | $82M, $55M; $96M | **yes** (approved) |
| BTC | WBTC/USDC; WBTC/USDT; WBTC/WETH; cbBTC through WBTC/cbBTC | $22M; $31M + $25M; $40M + $39M; $8M | **yes** (approved). cbBTC/USDC is deep on Base, not on Ethereum, so on Ethereum the WBTC–cbBTC agreement comes from the WBTC/cbBTC pool |
| UNI | UNI/WETH (× WETH/USDC) | $13.7M (UNI/USDT $2.6M) | **candidate**: measure the in-range liquidity; one pool only, so no second pool to agree with |
| LINK | LINK/WETH (× WETH/USDC) | $13.6M (LINK/USDC $1.1M) | **candidate**, as UNI |
| AAVE | AAVE/WETH (× WETH/USDC) | $11.3M | **candidate**, as UNI |
| ENA, ONDO, wTAO, LDO, PENDLE and others | X/WETH | $0.4–2.9M | **no**: below the threshold |
| SOL, XRP, DOGE and other non-Ethereum assets | only thin wrapped pools on Ethereum | — | **no** |
| Gold (XAU) | PAXG/USDC; XAUt/USDT; PAXG/WETH, XAUt/WETH | $2.2M; $4.6–5.3M; $3.0M, $3.7M | **no** (see below) |
| EUR/USD | ECB reference rate (daily fixing), with EURC/USDC as confirmation | EURC/USDC $2.2M (EURCV/USDC $3.3M) | **yes, daily, on the ECB.** EURC is a soft check only |
| Stocks, indices | tokenized stocks (e.g. TSLAon/USDC, SPCXon/USDC) | $0.2–0.3M | **no**: not publishable without a licence, and the tokens are too thin |
| Oil (WTI, Brent) | none on-chain | — | **no**: not without a licence |

**Gold.**
- No pool reaches $5M in-range against a dollar stablecoin. The largest, XAUt/USDT, is about $4.6–5.3M in total, so
  less in range, and is in USDT, not USDC.
- **Tracking:**
  - The tokens traded at about $4,156 (PAXG) and $4,166 (XAUt) when read. Spot gold closed at $4,143.94 on
    2026-10-06; the figures are from different days, so this is only an indication.
  - They usually follow spot within about 0.5–1%, with a premium or discount of their own.
  - They trade all weekend while spot gold is closed, so a weekend close would settle on token prices that no gold
    market confirms.
- A gold market on these pools would be a market on PAXG/XAUt, not on gold. **Not for mainnet** unless the pools
  deepen (both tokens ≥ $5M in range and agreeing within 1%) and the rules say "tokenized gold".

**Forex.**
- EUR/USD settles at the ECB fixing (about 14:15 UTC, published around 16:00 CET), once a day, on ECB working days,
  with "Source: ECB statistics" shown.
- The markets close at the fixing time. A market closes only on a day with a fixing, and is Void if the ECB publishes
  none.
- EURC/USDC (Ethereum $2.2M; the Base pool to be measured) is too thin to settle on. It only flags a fixing more than
  1% away from it for a manual look; it never blocks the round.
- Other currencies follow the same rule, if their ECB rate exists and the lawyer clears the use (rounding, the
  "information only" note).

**Stocks, indices, oil.** Confirmed: none of them is publishable without a licence.
- Exchange prices of stocks and indices need the exchanges' or a vendor's redistribution licence.
- Oil prices are CME or ICE data.
- The tokenized versions on-chain are both thin and derived from licensed data.

Sources:
- [DexPaprika: Uniswap v3 pools on Ethereum](https://dexpaprika.com/ethereum/uniswap_v3)
- [GeckoTerminal: PAXG/USDC 0.05%](https://www.geckoterminal.com/eth/pools/0x5ae13baaef0620fdae1d355495dc51a17adb4082)
- [GeckoTerminal: PAXG/USDC 0.3%](https://www.geckoterminal.com/eth/pools/0xb431c70f800100d87554ac1142c4a94c5fe4c0c4)
- [GeckoTerminal: XAUt/USDT 0.05%](https://www.geckoterminal.com/eth/pools/0x6546055f46e866a4b9a4a13e81273e3152bae5da)
- [Gold price, 2026-10-06 (pricegold.net)](https://pricegold.net/2026/october/6/)

## Cost and work

- **Per member:** nodes for 3 chains, or a light client; a few `eth_call`s per round.
- **Work:**
  - the reader (block at the close, `observe` on each pool, liquidity check, TWAP, median, the rules) with tests on
    recorded blocks: 2–3 days;
  - the committee member service uses it in place of HTTP sources: ½ day;
  - one-time: raise the pools' observation cardinality if needed;
  - running the nodes: per member, ongoing.

## Recommendation

1. Use DEX TWAPs for BTC and ETH on mainnet, with:
   - Ethereum as the anchor and L2s as confirmation;
   - two wrapped BTCs that must agree;
   - a 10–15 minute window rather than 5;
   - markets kept small next to the manipulation cost;
   - the rules stated as "on-chain price in USDC".
2. Members read from their own nodes or a light client, not a commercial RPC, unless the legal review clears it.
3. Chainlink is a private cross-check at most, pending its terms.

Sources:
- [Uniswap: Uniswap v3 TWAP oracles in proof of stake](https://blog.uniswap.org/uniswap-v3-oracles)
- [ChainSecurity: oracle manipulation after the merge](https://chainsecurity.com/oracle-manipulation-after-merge/)
- [Alchemy legal terms](https://legal.alchemy.com/)
- [Chainlink Data Feeds docs (footer: Terms of Use)](https://docs.chain.link/data-feeds)
