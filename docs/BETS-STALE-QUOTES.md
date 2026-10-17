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

## 9. Option E: a dynamic pari-mutuel market (DPM, Pennock 2004), reviewed 2026-10-17

A pool in which each buyer gets **shares** at a price that rises with what is already on their side. At Settle, the
whole pool goes to the winning side's shares pro rata. There is no seeder and no operator money at risk. A late buyer
with fresh information takes from the other bettors, never from us.

### 1. The variant: share-ratio, with an integer square root

- **Share-ratio** (κ = 1): the cost of the state is C(q₁, q₂) = √(q₁² + q₂²), where q is the shares sold on each side.
  - The pool M (the collateral the contract holds for the market) is always at least C.
  - The price of side 1 is p₁ = q₁ / √(q₁² + q₂²).
  - Buying side 1 with x: s = √((M + x)² − q₂²) − q₁.
  - In integers: `s = isqrt((M + x)² − q₂²) − q₁`, with isqrt rounding down. So the new state's cost
    √((q₁ + s)² + q₂²) ≤ M + x: the pool still covers it.
- **Money-ratio** (p₁ / p₂ = M₁ / M₂) needs a logarithm: s = M₂ · ln((M₁ + x) / M₁). Zulib has none. **Share-ratio
  only.**
- **Solvency does not depend on the rounding.** Settle pays M / q_win per winning share, rounded down, so the
  contract can never owe more than the pool. Rounding decides only fairness, and it always goes against the trader.
- **Winners never lose money.** The final payout per winning share, √(q₁² + q₂²) / q_win, is at least 1. Every price
  paid along the way is at most 1. A winning share therefore always returns at least what it cost.

### 2. Square root: yes, with a uniform cost

- `isqrt` of a U64, bit by bit: 32 fixed steps, each a multiply, a compare and a shift.
- No loop depends on the data, so the cost is the same on every path, as the padding rule wants. That is about
  1,000–2,000 gas.
- It needs nothing new in Zulib, only U64 arithmetic.
- The same testnet cap as FPMM applies: M + x at most 4 × 10⁹ units (4,000 zUSDC), so the squares fit a U64. Mainnet
  needs U128.

### 3. Exit: yes, along the same curve, before the cutoff

- **Selling s shares of side 1 pays** `out = M − ceil(√((q₁ − s)² + q₂²))`. That is the cost-function difference,
  rounded so that the pool keeps covering the new state.
- **It is path-independent:** buying and selling straight back returns what was paid, minus the rounding.
- **Nobody is debited:** the pool always equals what is left of the money paid in. But a sale moves the payout per
  share of everyone else, as every buy does. It is a market, not a guarantee.
- **What a seller gets depends on the moment.** If the other side has filled up since the buy, the shares sell back
  for less than they cost. The contract never makes that up.

### 4. Edge cases

- **The first buy:**
  - With an empty pool, s = x: price 1.
  - The first buyer on the other side gets many shares per zUSDC (price near 0). That is the DPM's incentive to take
    the other side.
  - Proposal: the service opens each market with 1 zUSDC on each side, so prices start near 0.71 / 0.71. That is
    2 zUSDC of service money per market, which comes back pro rata like anyone's.
- **Void, and one side empty at Settle** (no winning shares): refund the money paid.
  - Shares cannot do that: a share's price depends on when it was bought. So each Buy also mints a receipt token,
    "Paid", equal to x.
  - A Sell burns as many Paid as it pays out.
  - Σ Paid outstanding then always equals the pool M exactly, and Void redeems Paid 1:1.
  - The same rule applies to a settled market whose winning side has no shares.
- **Settle** pays `floor(M × s / q_win)` per Redeem. Any dust left after the last Redeem stays in the contract. It
  is at most one unit per Redeem.

### 5. What the wallet can show per buy (from q₁, q₂ and M, read from the contract's wallet)

- the shares received s, and the average price x / s;
- the payout per share if it closed now: `(M + x) / (q_side + s)`, and so "your x would return y";
- the price before and after, and "the other side would pay z per share".

For example, a pool opened with 1 + 1, then Up 10, then Down 10, then Up 10 (zUSDC):

| Buy | Shares per zUSDC | Pool after | If its side won now, per share | x returns |
| --- | --- | --- | --- | --- |
| Up 10 (A) | 1.087 | 12 | 1.0106 | 10.99 |
| Down 10 (B) | 1.679 | 22 | 1.1879 | 19.94 |
| Up 10 (C) | 1.422 | 32 | 1.2262 | 17.44 |

At the end:
- if Up wins: 1.2262 per Up share, so A gets 13.33 and C gets 17.44;
- if Down wins: 1.7278 per Down share.

A buyer gets more shares when the other side is heavier, so coming early pays only if you are early on your side
before the others arrive. The pool does not reward early buyers by itself.

### 6. Cost, guards, work

- **A trade:** about 25,000–35,000 gas. That is FPMM's walk of the contract's wallet, plus isqrt, plus one more token
  (Paid).
- **Guards:** `MinShares` on Buy and `MinOut` on Sell. A transaction that lands after the pool moved is refused and
  nothing moves, the same risk as FPMM's MinOut. The same cutoff at close − 30 min applies.
- **Work:** the contract 3–4 days (Buy, Sell, Settle/Void, Redeem by shares and by Paid, isqrt, about 40 tries),
  plus the service and API 1 day. **4–5 days**, against FPMM's 4–6 and the plain pool's 2–2½.

### Compared with FPMM and the pool

| | Who carries the risk | Price per buyer | Exit before close | Payout known when buying | Capital |
| --- | --- | --- | --- | --- | --- |
| FPMM | the seeder (loses on decisive markets; fees must cover) | yes | yes, at the curve | yes: 1 per winning token | a seed per market |
| DPM | the other bettors only | yes, in shares | yes, at the curve | no: it moves until the cutoff | none (2 zUSDC to open) |
| Pool | the other bettors only | no (one ratio for all) | no | no | none |

**My view:** if the operator should carry no risk on mainnet, DPM is the better of the two no-capital options. It
has a price per buyer and an exit, and the pool has neither. Its cost to users is a payout that is not known when
buying. FPMM gives a fixed 1 per winning token but needs seed money. The testnet numbers from FPMM (fees against the
seeder's losses) are what decide between the two.
