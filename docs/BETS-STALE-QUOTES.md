# Up / Down bets: stale quotes, and how to price without them

Status: proposal for review by the Oracle/Dex session (2026-10-17). Nothing here is built yet. Alon decides the direction.

## 1. The problem

Today a bet is a Dex Take of a standing order: the bets service (the market maker) posts orders that sell Up or Down
tokens at a fixed price, and requotes when its fair value moves more than 0.02 (docs/BETS.md).

The price in a standing order is fixed when it is mined, but the world moves faster than ZP blocks (~4 minutes):

1. BTC jumps 1% on Binance at 13:00:10.
2. Our Up orders still ask the old, now too low, price. The service sees the jump at its next poll (up to a minute)
   and sends a cancel or a requote.
3. That transaction is only effective once mined: up to ~4 minutes, and the same block may also hold a Take.
4. Anyone who saw the jump first takes the cheap Up tokens before the requote lands. The market maker loses the
   difference; repeated, this drains it.

This is latency arbitrage ("adverse selection", "stale quotes"). It is worth nothing on the testnet but is a hard
blocker for mainnet: whoever funds the market maker pays for every fast trader.

What limits it today: 5 tokens per order; a spread of 0.06 to 0.30 scaled by recent volatility and time to close; no
quotes in the last 20 minutes; a take and our cancel in the same block race (one of them fails). These shrink the loss,
they do not remove it, and there is no cap on the total.

## 2. How Polymarket handles it

Polymarket does not solve it on-chain; it moves the order book off-chain:

- The order book and matching run on Polymarket's server; only matched trades settle on Polygon. Orders are signed by
  their makers, so the operator cannot invent trades, but it decides the order of matching.
- A maker cancels or updates in milliseconds, with no block. The exchange contract accepts fills only from the operator,
  so a cancelled order is dead at once even if someone kept a copy.
- Since January 2026 the 15-minute crypto Up/Down markets charge a taker-only fee (highest at 50% probability), paid
  daily to makers as rebates: compensation for the trades they lose to faster takers.
- Latency-arbitrage bots on those markets are still a known business. It is managed, not solved.

Sources: The Block, "Polymarket adds taker fees to 15-minute crypto markets to fund liquidity rebates" (2026-01-06);
docs.polymarket.com/trading/overview.

## 3. Options

### A. Mitigations in the bets service (no contract change)

- Jump detection: poll the sources every ~5 s; on a move above ~0.5% since the last quote, cancel every quote on that
  ticker at once, then requote with the widened spread.
- Exposure cap per market: past N tokens sold net on one side, stop quoting that side and widen.
- Short-lived orders, if ZenDex V1 can carry a last block for an order.

Smaller losses, still uncapped. Good for the testnet now; not enough for mainnet.

### B. Signed quotes / an off-chain book (the Polymarket model)

The wallet asks the service for a quote at the current price; the service signs {market, side, price, amount, last
block, nonce}; the taker's transaction carries it, and the contract accepts it only if it is signed by the maker and not
expired. In the full model only the operator submits fills, so a withdrawn quote is dead at once.

- For: today's experience (a fixed price, profit known in advance, sell back any time); the stale window shrinks to
  about one block, and the service simply stops quoting in a jump.
- Against: a central operator decides who is matched and when; when it is down there is no trading. A market maker with
  capital is still needed, and the taker fee that pays it.

### C. A pool (pari-mutuel)

Everyone puts zUSDC into an Up pool or a Down pool; entries close some time before the close (e.g. 1 hour). At
settlement the winning side shares the whole pool pro rata, minus a fee; if no one is on the winning side, everyone is
refunded. No tokens with prices: the wallet shows the ratio so far ("if it ended now, 1 zUSDC on Up returns 1.63"),
updated each block, fixed when entries close.

- For: no stale quotes at all (there is no price to take); no market maker and no capital; fully on-chain; simple
  contract (sums and one division).
- Against: no price per buyer (first and last get the same ratio), so no reward for coming early and everyone waits for
  the cutoff; the payout is unknown until the cutoff; no exit before the close (that would need a book again); several
  lines per ticker split the money into thin pools.

### D. An automated market maker in the contract (LMSR or FPMM)

The contract holds the market's liquidity and prices every trade from its own state: buying Up raises the next Up
price. Each buyer gets their own price and can sell back to the contract at its current price. No service posts or
updates anything.

- LMSR (logarithmic market scoring rule): cost C(qUp, qDown) = b · ln(e^(qUp/b) + e^(qDown/b)); price of Up =
  e^(qUp/b) / (e^(qUp/b) + e^(qDown/b)). The worst-case loss of whoever seeds the market is b · ln 2, known in advance
  (b = 100 zUSDC: at most ~69.3 zUSDC per market, whatever happens). Needs exp and ln in fixed point inside a V1
  contract.
- FPMM (fixed product market maker, as Gnosis/Omen and early Polymarket used): the contract keeps a reserve of Up and
  Down tokens with reserveUp × reserveDown = k; buying Up for x zUSDC mints x pairs and returns Up tokens from the
  reserve. Only multiplication and division: much easier in F*. The seed liquidity is at risk (not capped by a formula,
  but limited to what was put in).
- Stale prices still exist: after a jump the contract's price stays put until someone trades, and that trader gains.
  The difference from today: the loss is bounded (LMSR: b · ln 2; FPMM: the seed), and a fee per trade (e.g. 1–2%,
  higher near 50%) pays for it over time.
- For: dynamic prices, a price per buyer, exit any time, fully on-chain, risk known in advance, no service to keep up.
- Against: the most contract work (LMSR in particular); the seed liquidity per market is the bounded but real cost.

## 4. Comparison

| | Price per buyer | Stale quotes | Capital needed | Exit before close | Central operator | Contract work |
|---|---|---|---|---|---|---|
| Today (Dex orders) | yes | exposed, uncapped | a market maker, large | yes | no | none |
| A. Mitigations | yes | smaller, uncapped | same | yes | no | none |
| B. Signed quotes | yes | ~1 block | a market maker | yes | yes | medium |
| C. Pool | no | none | none | no | no | low |
| D. LMSR / FPMM | yes | bounded loss | seed per market, known | yes | no | high (LMSR) / medium (FPMM) |

## 5. Recommendation (for review)

- Now, on the testnet: A (jump detection, exposure cap), to keep the current markets usable.
- For mainnet: D, starting with FPMM (only multiplication and division in F*), with a trade fee and a fixed seed per
  market. It keeps what users expect (a price per buyer, exit any time) and caps the risk. If FPMM in V1 turns out
  impractical, C (pool) is the fallback that needs no capital at all.
- B only if a central operator is acceptable; it is the least in line with a decentralised network.

## 6. Questions for the Oracle/Dex session

1. FPMM in a V1 contract: buy, sell back, redeem after Settle; the cost of one trade in the V1 cost model; rounding
   that can never pay out more than the reserves hold.
2. LMSR: is fixed-point exp/ln (a table or a short series) affordable in a V1 contract? If not, FPMM only.
3. Does the contract context give a block timestamp or number we can use for a trading cutoff (no trades in the last
   N minutes / blocks before the close)?
4. Can ZenDex V1 orders carry a last block (for A)?
5. Fees: rate, shape (flat or highest near 50%), and who receives them (the seed provider, the CGP fund).
6. Seed: who provides it per market on mainnet, and how much (it sets the price impact of a trade).
7. Settle and Void stay as today (oracle round at the close; no close price within 24 h → every token pays 0.50)?

## 7. Decisions for Alon

- The direction for mainnet: D (FPMM/LMSR), C (pool), or B (operator).
- The fee and who receives it.
- One line per ticker and close (deeper markets), or several lines as today.
