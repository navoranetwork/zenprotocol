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

## 8. Review by the Oracle/Dex session (2026-10-17)

### Answers to section 6

1. **FPMM in a V1 contract is feasible.** It is what FixedPayout already does (mint pairs against collateral, Redeem
   after Settle) plus a reserve.
   - **Commands:**
     - `Seed`: the seeder locks N zUSDC; the contract mints N pairs into its own wallet as the reserve and gives the
       seeder a share token.
     - `Buy` (side, zUSDC in, minimum out).
     - `Sell` (side, tokens in, minimum zUSDC out).
     - `Withdraw` (share tokens, after Settle or Void).
     - `Redeem` and `Cancel` stay.
   - **The minimum in Buy and Sell is the slippage guard.** The wallet computes it from the reserves it reads, so a
     trade that lands after a price move is refused rather than filled worse.
   - **State:** V1 contracts keep none besides their wallet, so the reserves are the contract's Up/Down coins of that
     market.
     - Each trade spends that market's reserve coins and locks one coin of each back, so their number stays two per
       market.
     - The cost grows with the whole wallet (cf = base + 512 per coin, as FixedPayout), so many open markets in one
       contract make every call dearer.
     - For mainnet: one line per ticker and close, and markets closed out after Settle. Or one contract per day if
       it grows.
   - **Cost:** of the order of 25,000–40,000 gas a trade, padded to the costliest command as today. That is a weight
     of 10–16 M against 8,000 M per block. V1 has no fee per gas.
   - **Rounding:** every division rounds against the trader. Up out = reserveUp − ceil(k / reserveDown'), and Sell
     the mirror image. The contract then holds at least what it owes: pairs minted = zUSDC locked, always.
   - **To be proved by tries:** after any sequence of trades, Redeem plus Withdraw never pays more than the contract
     holds. Tries cover sequences ending settled Up, settled Down and void.
2. **LMSR:** Zulib has no exp or ln. A fixed-point series or table in F* is possible, but its cost must be uniform
   across branches (the padding rule), and its rounding must provably never overpay. That is days of work for a bound
   (b · ln 2) that FPMM gives through the seed anyway. **FPMM only.**
3. **Yes.** The context has `blockNumber` (U32) and `timestamp` (the block's, U64 ms); FixedPayout already uses
   `timestamp` for the 24-hour grace. A miner sets the timestamp within the consensus limits, so a cutoff should sit
   well inside the window, e.g. no trades after close − 30 min. `blockNumber` is exact but block times vary (~4 min).
4. **Not today:** the V1 Dex has no expiry field. Adding one (`LastBlock`: Take refused after it) means a new Dex
   contract, with its orders moved: a contract change plus a migration of the ZP/zUSDC market maker. For the testnet,
   jump detection without expiry is enough.
5. **Fees:**
   - Charge a percentage on Buy and Sell, staying in the reserve (Omen-style), so the seeder earns it.
   - Shape: proportional to min(p, 1 − p), Polymarket-style, about 2% at 50% and less near 0 or 1. Near 0 or 1 the
     price impact already protects the seeder, and a flat fee hurts buyers of long shots.
   - It goes to the seeder.
   - A CGP cut is a later decision and only adds a payout.
6. **Seed:**
   - Whoever runs the markets (the foundation or Alon at first), e.g. 100–300 zUSDC per market, with one line per
     ticker and close so the money is not spread thin.
   - **The caveat:** on a binary market the reserve drifts towards the losing side as traders buy the winner, so on
     a decisive market much of the seed is lost at Settle. Fees must pay for it.
   - Treat the seed as the cost of the market. This is what bounds the stale-quote loss: never more than the seed.
7. **Yes.** The oracle round at the close settles the market. With no Settle within 24 h, Void, and every token pays
   0.50. The seeder's Withdraw after Settle redeems the reserve's winning tokens, or after Void both sides at 0.50.

### On the recommendation (section 5)

Agreed, with three notes:
- **A on the testnet:** only the cheap part.
  - Poll every ~5 s, and on a jump cancel every quote of that ticker at once.
  - An exposure cap per side.
  - No new Dex for an expiry: with one user on the testnet it is not worth the migration.
- **D (FPMM) for mainnet,** with a trading cutoff in the contract (close − 30 min), the fee above, and one line per
  ticker and close.
- **C (pool) as the fallback:** it needs no capital and is the least work. It also suits markets where an exit
  before the close does not matter.
- **B:** agreed, only if a central operator is acceptable. Zulib's `verify` (800 gas) makes the contract side easy.
  The cost is the operator, not the code.

### Work, roughly (code, tests, and lab or testnet runs; the wallet's own work not included)

| | Contract | Service and API | Total |
|---|---|---|---|
| A, jump detection and exposure cap (no Dex change) | none | ½ day | ½ day |
| A with an order expiry (new Dex, orders moved) | 1–2 days | ½ day | 2–3 days |
| D, FPMM | 3–5 days (commands, cost padding, rounding, ~40 tries) | 1 day (seeding, API: reserves, prices, quotes for a size) | 4–6 days |
| D, LMSR | FPMM + 3–5 days (fixed-point exp/ln and their bounds) | 1 day | 7–11 days |
| C, pool | 1½–2 days | ½ day | 2–2½ days |
| B, signed quotes | 1–2 days | 2 days (quote service, operator) | 3–4 days |
