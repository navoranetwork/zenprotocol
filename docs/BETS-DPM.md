# Up / Down markets as a dynamic pari-mutuel market (DPM): the shape

Status 2026-10-17: Alon chose DPM (share-ratio, docs/BETS-STALE-QUOTES.md section 9) for the **testnet**, instead of
FPMM. FPMM stays documented (docs/BETS-FPMM.md) for later and for a general swap pool. **Nothing is built yet.** The
build order is:
1. the wallet move on Sunday (docs/WALLET-MIGRATION.md);
2. option A in the bets service;
3. this contract and its tries;
4. the API;
5. the wallet.

**Mainnet needs an outside review of the contract** before any real money, as well as the oracle hardening
(docs/ORACLE-HARDENING.md).

## The idea

Bettors buy **shares** of Up or Down into one pool per market.
- A share's price rises with the shares already sold on its side.
- At Settle, the whole pool goes to the winning side's shares pro rata.
- There is no seeder and no operator money at risk, beyond the service's 1 + 1 zUSDC opening. A late buyer with
  fresh information takes from the other bettors only.
- A winning share always returns at least its price: the payout per share is at least 1, every price at most 1.

## The contract (`contracts/v1/UpDownPool.fst`, new; FixedPayout stays for the order-book markets)

A market is the same seven body fields as FixedPayout:
- OraclePubKey;
- OracleContractId;
- Ticker;
- Price;
- Start = Expiry = the close;
- Collateral.

Its tokens, with subtype SHA3 of the market fields and a 4-character tag:

| Tag | What | Who holds it |
| --- | --- | --- |
| Bull, Bear | Up and Down shares | bettors |
| Paid | a receipt for the money paid in, 1 unit per unit | bettors |
| QBul, QBea | the record of the shares sold on each side (qUp, qDown) | the contract |
| MBul, MBea | the record of the money paid into each side, net of sales (the base of the fee) | the contract |
| Pool | the record of the market's pool (the collateral held for it) | the contract |
| BuWn, BeWn, Void | the settlement markers, as FixedPayout | the contract |

The collateral of all markets is one asset in one wallet, so the pool of each market is kept as its own record.

**Trading closes 30 minutes before the close:** Buy and Sell are refused when `ctx.timestamp > close − 1,800,000`.

| Command | Who | Body beyond the market | Spend | Effect |
| --- | --- | --- | --- | --- |
| Buy | signed | Position ("Bull" / "Bear"), MinShares | x collateral | s shares and x Paid to the sender; qSide += s, Pool += x |
| Sell | signed | Position, Shares (n), MinOut | n shares, and P ≥ out Paid | out collateral to the sender; P − out Paid come back; qSide −= n, Pool −= out |
| Settle | anyone | as FixedPayout, plus Sigs: the round's committee signatures | none | records the winner; pays the fee (above) to the signers and the operator; Pool −= fee |
| Void | anyone | as FixedPayout | none | Void after 24 h without Settle; no fee |
| Redeem | signed | Position (the winner) | n winning shares | `floor(n × Pool / qWin)`, with Pool already net of the fee; qWin −= n, Pool −= that |
| Refund | signed | none | p Paid | after Void, or after Settle when the winning side has no shares: p collateral; Pool −= p |

There is no Cancel and no pairs.

### The integer formulas

The state of a market is qUp, qDown and pool.

- **The invariant:** `pool² ≥ qUp² + qDown²`. The pool covers the cost of the state.
- **isqrt(n)**, for 0 ≤ n < 2⁶⁴, rounds down. It works bit by bit, 32 fixed steps, so it costs the same for every n.
- **Buy side a** (other side b) with x:
  - `t = pool + x`, refused if `t > 4·10⁹` (the testnet cap, so every square fits a U64);
  - `s = isqrt(t² − qb²) − qa`, refused if `s = 0` or `s < MinShares`;
  - the new state is `qa + s`, `qb`, `t`.
- **Sell n shares of side a:**
  - refused unless `1 ≤ n ≤ qa`;
  - `p' = ceil(sqrt((qa − n)² + qb²))`, which is isqrt plus one when not exact;
  - `out = pool − p'`, refused if `out = 0` or `out < MinOut`;
  - the new state is `qa − n`, `qb`, `p'`.
  - The seller hands in `out` Paid.
- **Redeem n winning shares:** `floor(n × pool / qWin)`.
  - It is never more than the pool.
  - The dust left after the last Redeem is less than one unit per Redeem, and stays in the contract.
- **Refund p Paid:** p collateral. Paid outstanding always equals the pool: every Buy adds x to both, and every Sell
  takes out of both.
- **Empty pool:** the first Buy gets `s = x`, price 1. The service opens each market with 1 zUSDC on each side, so
  prices start at 0.707 / 0.707.

### Price and probability (the wallet shows both)

- **The price**, `q_side / sqrt(qUp² + qDown²)`, is the marginal cost of a share. It is **not** a probability: it is
  0.707 on each side at 50/50.
- **The implied probability** is `q_side² / (qUp² + qDown²)`. Both sides sum to 1, and it is the probability at which
  a marginal share is a fair bet.
- **The payout per share if it closed now** is `pool / q_side`.

## Fees (decided by Alon, 2026-10-17)

- **One fee: at Settle, 2% of the pool, taken only from the losing side's money.**
  - The contract keeps the money paid into each side, net of sales, as two more records: "MBul" and "MBea".
  - `fee = min(pool × 200 / 10000, money of the losing side, pool − qWin)`. The last term keeps the payout per winning
    share at least 1, so a winner never gets back less than a share's price.
  - The pool for Redeem is `pool − fee`.
- **No fee on Buy, Sell or Refund.** A void market, or a settled one whose winning side has no shares, pays everyone
  back in full.
- **The split, fixed in the contract source** (a change means a new contract version, for new markets):
  - **Committee 60%,** in equal shares to the members whose signatures made the settling round.
    - How: the 5 member keys are fixed in the source. Settle carries the round's signatures over the commit hash,
      `(index, signature)` for each signer, at least 3.
    - The contract verifies each with `Zen.Crypto.verify`, 800 gas, so up to 4,000 gas for 5. It pays
      `floor(fee × 60% / n)` to each valid signer's key.
    - This works without the Oracle contract reporting its signers, which it cannot pass through an attestation
      token.
    - Who sends Settle chooses which signatures to include, and could leave a member out. The bets service includes
      every signature the round has, and the members can check that in the log.
    - **The nearest alternative,** if verifying in Settle is judged too heavy: equal shares to all 5 members, absent
      or not.
  - **Operator 40%,** to the operator's address in the source, plus every rounding remainder, so nothing is lost.
  - **CGP 0%,** a parameter in the source (`CGP_BPS = 0`).
- **The CGP rule:**
  - **The documented target is 15% to the CGP, taken from the operator's share:** committee 60%, operator 25%,
    CGP 15%.
  - It is switched on through a new contract version, for new markets, once the operator's fee income has covered
    the running costs for **3 consecutive calendar months**.
  - **The running-cost budget is published and fixed: €600 a month.** It covers servers and upkeep. It is revised at
    most once a year, publicly, in this document.
  - **The check:**
    - The operator's monthly fee income is the sum of the operator payouts in the per-market log, in zUSDC.
    - It is compared with the budget converted at the month's average ECB EUR/USD rate.
    - The trigger is met in the month after 3 consecutive months above the budget.
- **What users see:**
  - the rules text, below;
  - `feeBps` and the split in `/bets/markets`;
  - `payoutPerShareIfWins` in the quote, **net of the fee**.

## Market rules (the text users read; the wallet shows it)

**Mainnet, BTC and ETH:**
> **How this market settles.** The settlement price is the **15-minute time-weighted average price (TWAP) of BTC (or
> ETH) in USDC on Uniswap**, up to the close. It is read from the deepest Uniswap v3 pools on Ethereum, confirmed by
> pools on Base and Arbitrum within 0.5%. It is **not** the price on an exchange such as Coinbase or Binance at one
> second, so it can differ from it slightly, more so when the price moves fast just before the close. BTC is priced
> through wrapped BTC (WBTC and cbBTC must agree within 1%). Prices are in USDC, not US dollars.
> **Up wins** if the settlement price is at or above the line; **Down wins** if it is below.
> The result is published about 15 minutes after the close, once Ethereum has finalized it. If no valid settlement
> price is published within 24 hours, the market is void and every bettor gets back what they paid.
> Trading stops 30 minutes before the close.
> **Fee:** 2% of the pool at settlement, taken only from the losing side's money and never so much that a winning share
> pays less than 1. There is no fee on buying, selling or refunds, and a void market pays everyone back in full.

**Testnet:** the same, except that the settlement price is the hourly round of the testnet oracle, the median of
Coinbase, Binance and CoinGecko, at the close.

### The chance shown to users

- **The label:** "Market's chance". Under it, one line: *"From how participants have bet so far. It is not our
  forecast."*
- **The value:** the implied probability `q_side² / (qUp² + qDown²)`, as a percentage, rounded to whole percent.
- **Next to it, the pool:** "based on 40 zUSDC".
- **Below a minimum pool, no percentage.** Instead: "Not enough bets yet".
  - The minimum is **100 zUSDC on mainnet and 10 on the testnet**.
  - The service sets it (`BETS_MIN_POOL_FOR_CHANCE`). The API gives `minPoolForChance` and `chanceShown` per market,
    so the wallet and the site apply the same rule.
  - The service's 1 + 1 opening counts towards the pool like any bet.
- **The price per share** (0.707 at 50/50) is shown only on the buy screen, as "price per share", never as a chance.

## The explorer API

`GET /explorer/api/bets/markets`: each market of the new contract has a `pool` object. Amounts are strings in base
units; the other numbers are floats:
```json
"pool": {
  "contract": "ctzn1…", "qUp": "26095976", "qDown": "18520261", "pool": "32000001",
  "price": { "up": 0.8155, "down": 0.5788 }, "prob": { "up": 0.6650, "down": 0.3350 },
  "payoutPerShare": { "up": 1.2262, "down": 1.7278 },
  "cutoff": 1792272600000, "trading": true, "volume": "41000000", "refundable": false,
  "minPoolForChance": "10000000", "chanceShown": true,
  "money": { "up": "21000000", "down": "11000001" },
  "fee": { "feeBps": 200, "split": { "committeeBps": 6000, "operatorBps": 4000, "cgpBps": 0 },
           "ifUpWins": "640000", "ifDownWins": "640000" }
},
"dexPrice": { "value": 81962.41, "kind": "twap15", "block": 23581234, "time": 1792270800000, "chain": "ethereum",
              "source": "Uniswap v3 WBTC/USDC, cbBTC/USDC; 15-min TWAP" },
"tokens": { "bull": "<asset>", "bear": "<asset>", "paid": "<asset>", "bullWon": "<asset>", "bearWon": "<asset>",
            "void": "<asset>", "qBull": "<asset>", "qBear": "<asset>", "pool": "<asset>" }
```
- **`dexPrice`** is the price to show on **mainnet**: the Uniswap 15-minute TWAP the committee would compute now
  (`kind: "twap15"`), or the latest Uniswap spot (`kind: "spot"`). It comes with its block, time and chain, and a
  `source` line to display. On mainnet the wallet and the site show **no CEX prices**: Coinbase, Binance and
  CoinGecko do not allow redistribution (docs/ORACLE-SOURCES-TERMS.md). On the testnet `dexPrice` is null and the
  oracle's current sources stay.
- The example is the state after C (the vectors). The quote is C's buy itself: Up 10 after the opening, A and B.
- **`chanceShown`** is `pool ≥ minPoolForChance`. While it is false, `prob` is still given (for the quote screen), but the
  wallet and the site show "Not enough bets yet" instead of a percentage.
- **The wallet shows:** Bull and Bear as shares, and Paid as "refundable if void". It hides the records and markers.
- **`cutoff` is as is:** the wallet stops offering trades 5 minutes earlier.

`GET /explorer/api/bets/quote?market=<Up asset id>&side=up|down&action=buy|sell&amount=<units>[&slippage=0.01]`:
- buy: amount = collateral;
- sell: amount = shares.

The answer:
```json
{ "action": "buy", "side": "up", "in": "10000000", "shares": "14221634", "avgPrice": 0.7032,
  "priceBefore": 0.5397, "priceAfter": 0.8155, "probBefore": 0.2913, "probAfter": 0.6650,
  "payoutPerShareIfWins": 1.2017, "returnsIfWins": "17090391", "minShares": "14079417",
  "call": { "contract": "ctzn1…", "command": "Buy", "bodyHex": "0c…",
            "spends": [{ "asset": "<collateral>", "amount": "10000000" }] } }
```
- **For a sell:** the answer has `out` and `minOut`, and `spends` = the shares plus `out` Paid.
- **The wallet** builds the body itself, compares it with `bodyHex` byte for byte, and checks with its expect callback
  that the contract pays it at least `minShares` (or `minOut`) and nothing to others. It computes quotes locally with
  the shared module and uses the API as a cross-check.
- **`/bets/positions`:**
  - for a market of the new contract it gives shares and Paid per side;
  - `valueNow` is the sell quote;
  - `ifWins` is shares × payout per share now.

## The shared module and the vectors

`site/bets/dpm.mjs` is the integer reference, exactly as the contract computes:
- `isqrt`, `buy`, `sell`, `settle` (the fee and its split), `redeem`, `refund`, `prices`, `payoutPerShare`,
  `payoutPerShareNet`.

`site/test/dpm.test.mjs` checks three things:
- the vectors below;
- `isqrt` at 10,000 random points;
- the solvency asserts, over 300 random runs of 40 trades, each run starting with the 1 + 1 opening:
  - `pool² ≥ qUp² + qDown²` after every trade;
  - Paid outstanding = pool;
  - Redeem in random pieces pays at most the pool;
  - Void refunds of all Paid pay exactly the pool.

The vectors start from an empty pool. The opening is 1 + 1, then A Up 10, B Down 10, C Up 10. The sells, redeems and
refunds start from the state after C.

```json vectors
[
 {
  "name": "isqrt 0",
  "op": "isqrt",
  "in": {
   "n": "0"
  },
  "out": {
   "r": "0"
  }
 },
 {
  "name": "isqrt 1",
  "op": "isqrt",
  "in": {
   "n": "1"
  },
  "out": {
   "r": "1"
  }
 },
 {
  "name": "isqrt 2",
  "op": "isqrt",
  "in": {
   "n": "2"
  },
  "out": {
   "r": "1"
  }
 },
 {
  "name": "isqrt 3",
  "op": "isqrt",
  "in": {
   "n": "3"
  },
  "out": {
   "r": "1"
  }
 },
 {
  "name": "isqrt 4",
  "op": "isqrt",
  "in": {
   "n": "4"
  },
  "out": {
   "r": "2"
  }
 },
 {
  "name": "isqrt 15",
  "op": "isqrt",
  "in": {
   "n": "15"
  },
  "out": {
   "r": "3"
  }
 },
 {
  "name": "isqrt 16",
  "op": "isqrt",
  "in": {
   "n": "16"
  },
  "out": {
   "r": "4"
  }
 },
 {
  "name": "isqrt 17",
  "op": "isqrt",
  "in": {
   "n": "17"
  },
  "out": {
   "r": "4"
  }
 },
 {
  "name": "isqrt 999999",
  "op": "isqrt",
  "in": {
   "n": "999999"
  },
  "out": {
   "r": "999"
  }
 },
 {
  "name": "isqrt 1000000",
  "op": "isqrt",
  "in": {
   "n": "1000000"
  },
  "out": {
   "r": "1000"
  }
 },
 {
  "name": "isqrt 18446744073709551615",
  "op": "isqrt",
  "in": {
   "n": "18446744073709551615"
  },
  "out": {
   "r": "4294967295"
  }
 },
 {
  "name": "isqrt 16000000000000000000",
  "op": "isqrt",
  "in": {
   "n": "16000000000000000000"
  },
  "out": {
   "r": "4000000000"
  }
 },
 {
  "name": "open: Up 1 on an empty pool",
  "op": "buy",
  "in": {
   "state": {
    "qUp": "0",
    "qDown": "0",
    "pool": "0",
    "mUp": "0",
    "mDown": "0"
   },
   "side": "up",
   "x": "1000000"
  },
  "out": {
   "shares": "1000000",
   "paid": "1000000",
   "state": {
    "qUp": "1000000",
    "qDown": "0",
    "pool": "1000000",
    "mUp": "1000000",
    "mDown": "0"
   }
  }
 },
 {
  "name": "open: Down 1",
  "op": "buy",
  "in": {
   "state": {
    "qUp": "1000000",
    "qDown": "0",
    "pool": "1000000",
    "mUp": "1000000",
    "mDown": "0"
   },
   "side": "down",
   "x": "1000000"
  },
  "out": {
   "shares": "1732050",
   "paid": "1000000",
   "state": {
    "qUp": "1000000",
    "qDown": "1732050",
    "pool": "2000000",
    "mUp": "1000000",
    "mDown": "1000000"
   }
  }
 },
 {
  "name": "A: Up 10",
  "op": "buy",
  "in": {
   "state": {
    "qUp": "1000000",
    "qDown": "1732050",
    "pool": "2000000",
    "mUp": "1000000",
    "mDown": "1000000"
   },
   "side": "up",
   "x": "10000000"
  },
  "out": {
   "shares": "10874342",
   "paid": "10000000",
   "state": {
    "qUp": "11874342",
    "qDown": "1732050",
    "pool": "12000000",
    "mUp": "11000000",
    "mDown": "1000000"
   }
  }
 },
 {
  "name": "B: Down 10",
  "op": "buy",
  "in": {
   "state": {
    "qUp": "11874342",
    "qDown": "1732050",
    "pool": "12000000",
    "mUp": "11000000",
    "mDown": "1000000"
   },
   "side": "down",
   "x": "10000000"
  },
  "out": {
   "shares": "16788209",
   "paid": "10000000",
   "state": {
    "qUp": "11874342",
    "qDown": "18520259",
    "pool": "22000000",
    "mUp": "11000000",
    "mDown": "11000000"
   }
  }
 },
 {
  "name": "C: Up 10",
  "op": "buy",
  "in": {
   "state": {
    "qUp": "11874342",
    "qDown": "18520259",
    "pool": "22000000",
    "mUp": "11000000",
    "mDown": "11000000"
   },
   "side": "up",
   "x": "10000000"
  },
  "out": {
   "shares": "14221634",
   "paid": "10000000",
   "state": {
    "qUp": "26095976",
    "qDown": "18520259",
    "pool": "32000000",
    "mUp": "21000000",
    "mDown": "11000000"
   }
  }
 },
 {
  "name": "refused: MinShares not met",
  "op": "buy",
  "in": {
   "state": {
    "qUp": "26095976",
    "qDown": "18520259",
    "pool": "32000000",
    "mUp": "21000000",
    "mDown": "11000000"
   },
   "side": "up",
   "x": "10000000",
   "minShares": "20000000"
  },
  "out": {
   "error": "shares 11600177 below MinShares 20000000"
  }
 },
 {
  "name": "refused: past the testnet cap",
  "op": "buy",
  "in": {
   "state": {
    "qUp": "26095976",
    "qDown": "18520259",
    "pool": "32000000",
    "mUp": "21000000",
    "mDown": "11000000"
   },
   "side": "down",
   "x": "3990000000"
  },
  "out": {
   "error": "the pool would pass the testnet cap"
  }
 },
 {
  "name": "rounding: buy 1 unit",
  "op": "buy",
  "in": {
   "state": {
    "qUp": "26095976",
    "qDown": "18520259",
    "pool": "32000000",
    "mUp": "21000000",
    "mDown": "11000000"
   },
   "side": "down",
   "x": "1"
  },
  "out": {
   "shares": "2",
   "paid": "1",
   "state": {
    "qUp": "26095976",
    "qDown": "18520261",
    "pool": "32000001",
    "mUp": "21000000",
    "mDown": "11000001"
   }
  }
 },
 {
  "name": "sell 5,000,000 Up shares",
  "op": "sell",
  "in": {
   "state": {
    "qUp": "26095976",
    "qDown": "18520261",
    "pool": "32000001",
    "mUp": "21000000",
    "mDown": "11000001"
   },
   "side": "up",
   "shares": "5000000"
  },
  "out": {
   "out": "3927946",
   "state": {
    "qUp": "21095976",
    "qDown": "18520261",
    "pool": "28072055",
    "mUp": "17072054",
    "mDown": "11000001"
   }
  }
 },
 {
  "name": "sell back at once what was just bought (7 zUSDC of Down)",
  "op": "sell",
  "in": {
   "state": {
    "qUp": "26095976",
    "qDown": "28982755",
    "pool": "39000001",
    "mUp": "21000000",
    "mDown": "18000001"
   },
   "side": "down",
   "shares": "10462494"
  },
  "out": {
   "out": "7000000",
   "state": {
    "qUp": "26095976",
    "qDown": "18520261",
    "pool": "32000001",
    "mUp": "21000000",
    "mDown": "11000001"
   }
  }
 },
 {
  "name": "refused: more shares than sold",
  "op": "sell",
  "in": {
   "state": {
    "qUp": "26095976",
    "qDown": "18520261",
    "pool": "32000001",
    "mUp": "21000000",
    "mDown": "11000001"
   },
   "side": "up",
   "shares": "26095977"
  },
  "out": {
   "error": "Sell needs between 1 and the shares sold on that side"
  }
 },
 {
  "name": "refused: MinOut not met",
  "op": "sell",
  "in": {
   "state": {
    "qUp": "26095976",
    "qDown": "18520261",
    "pool": "32000001",
    "mUp": "21000000",
    "mDown": "11000001"
   },
   "side": "up",
   "shares": "5000000",
   "minOut": "10000000"
  },
  "out": {
   "error": "out 3927946 below MinOut 10000000"
  }
 },
 {
  "name": "rounding: sell 1 share",
  "op": "sell",
  "in": {
   "state": {
    "qUp": "26095976",
    "qDown": "18520261",
    "pool": "32000001",
    "mUp": "21000000",
    "mDown": "11000001"
   },
   "side": "down",
   "shares": "1"
  },
  "out": {
   "out": "1",
   "state": {
    "qUp": "26095976",
    "qDown": "18520260",
    "pool": "32000000",
    "mUp": "21000000",
    "mDown": "11000000"
   }
  }
 },
 {
  "name": "settle: Up wins, 3 signers (fee 2% of the pool)",
  "op": "settle",
  "in": {
   "state": {
    "qUp": "26095976",
    "qDown": "18520261",
    "pool": "32000001",
    "mUp": "21000000",
    "mDown": "11000001"
   },
   "winner": "up",
   "signers": "3"
  },
  "out": {
   "fee": "640000",
   "committeeEach": "128000",
   "cgp": "0",
   "operator": "256000",
   "refundsOnly": false,
   "state": {
    "qUp": "26095976",
    "qDown": "18520261",
    "pool": "31360001",
    "mUp": "21000000",
    "mDown": "11000001"
   }
  }
 },
 {
  "name": "settle: Down wins, 5 signers",
  "op": "settle",
  "in": {
   "state": {
    "qUp": "26095976",
    "qDown": "18520261",
    "pool": "32000001",
    "mUp": "21000000",
    "mDown": "11000001"
   },
   "winner": "down",
   "signers": "5"
  },
  "out": {
   "fee": "640000",
   "committeeEach": "76800",
   "cgp": "0",
   "operator": "256000",
   "refundsOnly": false,
   "state": {
    "qUp": "26095976",
    "qDown": "18520261",
    "pool": "31360001",
    "mUp": "21000000",
    "mDown": "11000001"
   }
  }
 },
 {
  "name": "settle: the losing side holds less than 2% of the pool (fee = its money)",
  "op": "settle",
  "in": {
   "state": {
    "qUp": "20000000",
    "qDown": "1414213",
    "pool": "21000000",
    "mUp": "20000000",
    "mDown": "300000"
   },
   "winner": "up",
   "signers": "3"
  },
  "out": {
   "fee": "300000",
   "committeeEach": "60000",
   "cgp": "0",
   "operator": "120000",
   "refundsOnly": false,
   "state": {
    "qUp": "20000000",
    "qDown": "1414213",
    "pool": "20700000",
    "mUp": "20000000",
    "mDown": "300000"
   }
  }
 },
 {
  "name": "settle: the cap keeps a winning share at 1 (fee = pool - qWin)",
  "op": "settle",
  "in": {
   "state": {
    "qUp": "31000000",
    "qDown": "5000000",
    "pool": "31400802",
    "mUp": "30000000",
    "mDown": "2000000"
   },
   "winner": "up",
   "signers": "3"
  },
  "out": {
   "fee": "400802",
   "committeeEach": "80160",
   "cgp": "0",
   "operator": "160322",
   "refundsOnly": false,
   "state": {
    "qUp": "31000000",
    "qDown": "5000000",
    "pool": "31000000",
    "mUp": "30000000",
    "mDown": "2000000"
   }
  }
 },
 {
  "name": "settle: no winning shares (refunds, no fee)",
  "op": "settle",
  "in": {
   "state": {
    "qUp": "0",
    "qDown": "5000000",
    "pool": "5000000",
    "mUp": "0",
    "mDown": "5000000"
   },
   "winner": "up",
   "signers": "3"
  },
  "out": {
   "fee": "0",
   "committeeEach": "0",
   "cgp": "0",
   "operator": "0",
   "refundsOnly": true,
   "state": {
    "qUp": "0",
    "qDown": "5000000",
    "pool": "5000000",
    "mUp": "0",
    "mDown": "5000000"
   }
  }
 },
 {
  "name": "redeem 10,874,342 Up shares after Up won (pool net of the fee)",
  "op": "redeem",
  "in": {
   "state": {
    "qUp": "26095976",
    "qDown": "18520261",
    "pool": "31360001",
    "mUp": "21000000",
    "mDown": "11000001"
   },
   "side": "up",
   "n": "10874342"
  },
  "out": {
   "out": "13067891",
   "state": {
    "qUp": "15221634",
    "qDown": "18520261",
    "pool": "18292110",
    "mUp": "21000000",
    "mDown": "11000001"
   }
  }
 },
 {
  "name": "refund 11 Paid after Void",
  "op": "refund",
  "in": {
   "state": {
    "qUp": "26095976",
    "qDown": "18520261",
    "pool": "32000001",
    "mUp": "21000000",
    "mDown": "11000001"
   },
   "p": "11000000"
  },
  "out": {
   "out": "11000000",
   "state": {
    "qUp": "26095976",
    "qDown": "18520261",
    "pool": "21000001",
    "mUp": "21000000",
    "mDown": "11000001"
   }
  }
 },
 {
  "name": "refused: refund more than the pool",
  "op": "refund",
  "in": {
   "state": {
    "qUp": "26095976",
    "qDown": "18520261",
    "pool": "32000001",
    "mUp": "21000000",
    "mDown": "11000001"
   },
   "p": "32000002"
  },
  "out": {
   "error": "Refund needs between 1 and the pool"
  }
 },
 {
  "name": "prices, implied probabilities and payouts after C",
  "op": "prices",
  "in": {
   "state": {
    "qUp": "26095976",
    "qDown": "18520261",
    "pool": "32000001",
    "mUp": "21000000",
    "mDown": "11000001"
   }
  },
  "out": {
   "up": 0.8154992376955592,
   "down": 0.5787581475175635,
   "probUp": 0.6650390066820382,
   "probDown": 0.33496099331796175,
   "payoutUp": 1.2262427356616208,
   "payoutDown": 1.7278374748606404,
   "payoutUpNet": 1.20171788171479,
   "payoutDownNet": 1.693280726443326
  }
 }
]
```

## The tries (on the engine and the lab, before activation)

- Every command, accepted and refused: the cutoff, MinShares, MinOut, the cap, a Sell beyond qSide, a Redeem on the
  loser, a Refund before Void.
- Sequences that end settled Up, settled Down, Void, and settled with an empty winning side (refunds). Each one starts
  with the service's 1 + 1 opening.
- **The assert:** after each sequence the contract's collateral for the market is at least what every Redeem and
  Refund pays out.
- The gas per command, padded to the costliest: the target is 25,000–35,000.

## The per-market log (`amm-log.json`, `GET /explorer/api/bets/pool-log`)

For each market:
- the line and the close;
- the opening (1 + 1);
- the trades, the volume, buys and sells;
- the state at the cutoff (qUp, qDown, pool, the implied probability);
- the result (Up, Down, Void, or no winners);
- the payout per winning share;
- the redeems paid, the refunds paid, and the dust left;
- the service's own result: its 1 + 1 back, minus 2;
- the fee: the total, each signer's share, the operator's and the CGP's.

**Monthly lines** in the same endpoint: the operator's fee income for the month, in zUSDC and in euros at the month's
average ECB rate, next to the €600 budget, with the count of consecutive months above it. Anyone can see how far the
CGP trigger is.

## Notes for mainnet

- **An outside review of the contract** before real money.
- **The cap:** U128 arithmetic (or scaled units) instead of the 4,000 zUSDC testnet cap.
- **The oracle** is a single key today: docs/ORACLE-HARDENING.md.
