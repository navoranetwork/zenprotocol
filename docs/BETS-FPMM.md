# Up / Down markets with an automated market maker (FPMM): the API shape

Status 2026-10-17: the agreed shape for the wallet session; **not built yet**. Approved by Alon for the **testnet
only** (docs/BETS-STALE-QUOTES.md, sections 5 and 8). The mainnet choice, FPMM or pool, comes after a couple of
weeks of the numbers logged below. Build order:
1. the wallet move on Sunday (docs/WALLET-MIGRATION.md);
2. option A in the bets service;
3. this contract, its tries on the engine and the lab;
4. activation on the testnet, the service and the explorer API;
5. the wallet.

## The contract (`contracts/v1/UpDown.fst`, a new contract; FixedPayout stays for the order-book markets)

A market is the same seven body fields as FixedPayout:
- OraclePubKey;
- OracleContractId;
- Ticker;
- Price;
- Start = Expiry = the close;
- Collateral.

The tokens are its own:
- the positions, tags "Bull" (Up) and "Bear" (Down);
- the markers, "BuWn", "BeWn" and "Void";
- the seeder's shares, "Shar";
- the record of the seed, "Seed", which the contract keeps.

The token subtype is SHA3 of the market fields and the tag, as in FixedPayout.

**Trading closes 30 minutes before the close.** Seed, Buy and Sell are refused when `ctx.timestamp > close − 1,800,000`.

| Command | Who | Body beyond the market | Spend | Effect |
| --- | --- | --- | --- | --- |
| Seed | signed | Odds (U64: the price of Up in bps, 1–9999) | N collateral | once per market. Mints N pairs; the reserve keeps all of the cheaper side and the share of the other that makes the price Odds, and the rest of that side goes back to the sender. Also N "Seed" to the contract and N "Shar" to the sender |
| Buy | signed | Position ("Bull" / "Bear"), MinOut (U64) | x collateral | tokens of that side to the sender, at the reserve's price; refused below MinOut |
| Sell | signed | Position, Amount (U64: collateral wanted), MaxIn (U64) | up to MaxIn tokens of that side | Amount collateral to the sender; the tokens not needed come back; refused if more than MaxIn are needed |
| Cancel | signed | none | N Up + N Down | N collateral, any time (as FixedPayout) |
| Settle, Void | anyone | as FixedPayout | none | as FixedPayout (the oracle round at the close; Void after 24 h without Settle) |
| Redeem | signed | Position | N tokens | after Settle: N collateral for the winner; after Void: N/2 for either |
| Withdraw | signed | none | S "Shar" | after Settle or Void: S / Seed of what the reserve is worth, see below |

Sell names the collateral wanted, not the tokens given. Solving for the tokens given needs a square root, which the
contract does not have. The wallet finds the Amount for a number of tokens itself (the quote API below does it).

### The price, the trade, the fee (integers, rounded against the trader)

- **Seed at a price** (Gnosis-style), so the first trader does not take the gap between the line and the spot:
  - for Odds < 5000: `rUp = N`, `rDown = floor(N × Odds / (10000 − Odds))`;
  - for Odds > 5000: the mirror image;
  - the seeder gets `N − rDown` Down (or `N − rUp` Up) back.
  - The service seeds at its fair price of Up from the live price.
- **The reserve:** `rUp`, `rDown`, the contract's coins of the market's two positions, with `k = rUp × rDown`.
- **Prices:** `pUp = rDown / (rUp + rDown)` and `pDown = 1 − pUp`.
- **Fee rate,** in basis points: `fee = 400 × min(rUp, rDown) / (rUp + rDown)`. That is 2% at 50%, less towards 0
  or 1.
- **Buy Up with x:**
  - `f = ceil(x × fee / 10000)` and `n = x − f`;
  - x pairs are minted;
  - `out = rUp + n − ceil(k / (rDown + n))`;
  - the reserve becomes `rUp + x − out` and `rDown + x`.
  - So the f pairs of the fee stay in the reserve: the seeder earns them.
- **Sell Up for Amount c:**
  - `g = ceil(c × 10000 / (10000 − fee))`, so the fee is `g − c`;
  - `in = ceil(k / (rDown − g)) − rUp + g`;
  - c pairs are burned and c collateral is paid;
  - the reserve becomes `rUp + in − c` and `rDown − c`.
  - It is refused if `g ≥ rDown`.
- Down is the mirror image.
- **Every division is rounded so that `k` never falls:** pairs minted = collateral locked, always. The tries check
  that Redeem plus Withdraw never pay more than the contract holds, after Settle Up, Settle Down and Void.
- **Testnet limit:** reserves at most 4 × 10⁹ units a side (4,000 zUSDC), so `k` fits in a U64. Above that a trade is
  refused.
- **Withdraw S shares:**
  - worth after Settle: `S × (reserve of the winning side) / Seed`;
  - worth after Void: `S × (rUp + rDown) / 2 / Seed`;
  - all rounded down.
  - The shares are destroyed. The reserve's tokens are redeemed inside the contract.

## The explorer API (what the wallet reads)

`GET /explorer/api/bets/markets`: each market of the new contract also has an `amm` object. Amounts are strings in
base units; prices are numbers from 0 to 1:
```json
"amm": {
  "contract": "ctzn1…", "reserveUp": "153000000", "reserveDown": "65400000",
  "price": { "up": 0.2994, "down": 0.7006 }, "feeBps": 120,
  "seed": "100000000", "cutoff": 1792272600000, "trading": true,
  "fees": "1830000", "volume": "91500000",
  "seeder": { "address": "tzn1…", "result": null }
},
"tokens": { "bull": "<asset>", "bear": "<asset>", "bullWon": "<asset>", "bearWon": "<asset>", "void": "<asset>",
            "share": "<asset>", "seed": "<asset>" }
```
- `tokens` names every asset of the market by its tag. The wallet:
  - shows "share" as a liquidity share;
  - hides the markers (bullWon, bearWon, void) and the seed record, which only the contract holds.
- `cutoff` is the contract's (close − 30 min), as it is. The wallet stops offering trades 5 minutes earlier, because a
  transaction sent later may be mined after the cutoff.
- `trading` is false after the cutoff, or before Seed.
- `fees` and `volume` are summed from the market's Buy and Sell transactions.
- `seeder.result` is set at Withdraw: what came back minus the seed, as a string.

`GET /explorer/api/bets/quote?market=<Up asset id>&side=up|down&action=buy|sell&amount=<units>[&slippage=0.01]`:
- buy: amount = collateral to spend;
- sell: amount = tokens to sell.

The answer:
```json
{ "action": "buy", "side": "up", "in": "10000000", "out": "29962999", "fee": "119000",
  "avgPrice": 0.3337, "priceBefore": 0.2994, "priceAfter": 0.3617,
  "minOut": "29663369", "tip": 4321,
  "call": { "contract": "ctzn1…", "command": "Buy", "bodyHex": "0c…",
            "spends": [{ "asset": "<collateral>", "amount": "10000000" }] } }
```
- For a sell, `out` is the collateral, `call.command` is "Sell", the body carries `Amount` = out and `MaxIn` = the
  tokens, and `spends` is the tokens.
- `minOut` (buy) and `Amount` (sell) already take off `slippage` (default 1%).
- **The wallet does not sign `call` blindly.** It builds the body itself and compares it with `bodyHex` byte for byte.
  Its expect check makes sure the contract pays this wallet at least `minOut` (or `Amount`) and nothing to anyone
  else. It computes quotes locally with the shared math (below) and uses `/bets/quote` as a cross-check.
- If the reserve has changed when the transaction is mined, the contract refuses it, and nothing moves.

`GET /explorer/api/bets/positions?address=` is unchanged. For a market of the new contract, `valueNow` is the quote of
selling the whole position.

## The shared math and its vectors

`site/bets/fpmm.mjs` is the reference, in integers, exactly as the contract will compute:
- `seed`, `buy`, `sell`;
- `sellFor`: the Amount for a number of tokens, by bisection;
- `withdraw`, `feeBps`.

The service, `/bets/quote` and the wallet use it or match it. The contract's tries use the same vectors.
`site/test/fpmm.test.mjs` checks the vectors below, plus 200 random runs of 40 trades in which `k` never falls and
every Up and every Down stays backed by one pair.

Amounts are base units: 1,000,000 = 1 zUSDC. Each `out` is either the result or `{ "error": … }`, and a refused call
changes nothing.

```json vectors
[
 {
  "name": "seed 100 at 0.50",
  "op": "seed",
  "in": {
   "n": "100000000",
   "oddsBps": "5000"
  },
  "out": {
   "rUp": "100000000",
   "rDown": "100000000",
   "backUp": "0",
   "backDown": "0",
   "shares": "100000000"
  }
 },
 {
  "name": "seed 100 at 0.30: Down surplus back",
  "op": "seed",
  "in": {
   "n": "100000000",
   "oddsBps": "3000"
  },
  "out": {
   "rUp": "100000000",
   "rDown": "42857142",
   "backUp": "0",
   "backDown": "57142858",
   "shares": "100000000"
  }
 },
 {
  "name": "seed 100 at 0.70: Up surplus back",
  "op": "seed",
  "in": {
   "n": "100000000",
   "oddsBps": "7000"
  },
  "out": {
   "rUp": "42857142",
   "rDown": "100000000",
   "backUp": "57142858",
   "backDown": "0",
   "shares": "100000000"
  }
 },
 {
  "name": "refused: seed at 0",
  "op": "seed",
  "in": {
   "n": "100000000",
   "oddsBps": "0"
  },
  "out": {
   "error": "Seed needs N > 0 and a price between 1 and 9999 bps"
  }
 },
 {
  "name": "buy Up 10 at 50%",
  "op": "buy",
  "in": {
   "rUp": "100000000",
   "rDown": "100000000",
   "side": "up",
   "x": "10000000"
  },
  "out": {
   "out": "18725318",
   "fee": "200000",
   "rUp": "91274682",
   "rDown": "110000000"
  }
 },
 {
  "name": "buy Down 10 at 50%",
  "op": "buy",
  "in": {
   "rUp": "100000000",
   "rDown": "100000000",
   "side": "down",
   "x": "10000000"
  },
  "out": {
   "out": "18725318",
   "fee": "200000",
   "rUp": "110000000",
   "rDown": "91274682"
  }
 },
 {
  "name": "buy Up 10 on a skewed reserve (fee 119 bps)",
  "op": "buy",
  "in": {
   "rUp": "153000000",
   "rDown": "65400000",
   "side": "up",
   "x": "10000000"
  },
  "out": {
   "out": "29962999",
   "fee": "119000",
   "rUp": "133037001",
   "rDown": "75400000"
  }
 },
 {
  "name": "buy Up 30 at 50%",
  "op": "buy",
  "in": {
   "rUp": "100000000",
   "rDown": "100000000",
   "side": "up",
   "x": "30000000"
  },
  "out": {
   "out": "52120247",
   "fee": "600000",
   "rUp": "77879753",
   "rDown": "130000000"
  }
 },
 {
  "name": "rounding: buy 3 units",
  "op": "buy",
  "in": {
   "rUp": "100000000",
   "rDown": "100000000",
   "side": "up",
   "x": "3"
  },
  "out": {
   "out": "3",
   "fee": "1",
   "rUp": "100000000",
   "rDown": "100000003"
  }
 },
 {
  "name": "refused: buy 1 unit (all fee)",
  "op": "buy",
  "in": {
   "rUp": "100000000",
   "rDown": "100000000",
   "side": "up",
   "x": "1"
  },
  "out": {
   "error": "Buy too small: nothing out"
  }
 },
 {
  "name": "refused: below MinOut",
  "op": "buy",
  "in": {
   "rUp": "100000000",
   "rDown": "100000000",
   "side": "up",
   "x": "10000000",
   "minOut": "20000000"
  },
  "out": {
   "error": "out 18725318 is below MinOut 20000000"
  }
 },
 {
  "name": "refused: past the testnet cap",
  "op": "buy",
  "in": {
   "rUp": "3990000000",
   "rDown": "3990000000",
   "side": "up",
   "x": "20000000"
  },
  "out": {
   "error": "the reserve would pass the testnet cap"
  }
 },
 {
  "name": "sell Up for 5 at 50%",
  "op": "sell",
  "in": {
   "rUp": "100000000",
   "rDown": "100000000",
   "side": "up",
   "amount": "5000000"
  },
  "out": {
   "in": "10478386",
   "fee": "102041",
   "rUp": "105478386",
   "rDown": "95000000"
  }
 },
 {
  "name": "sell Up for 5 on a skewed reserve",
  "op": "sell",
  "in": {
   "rUp": "90000000",
   "rDown": "111000000",
   "side": "up",
   "amount": "5000000"
  },
  "out": {
   "in": "9417511",
   "fee": "91132",
   "rUp": "94417511",
   "rDown": "106000000"
  }
 },
 {
  "name": "rounding: sell Down for 1 unit",
  "op": "sell",
  "in": {
   "rUp": "100000000",
   "rDown": "100000000",
   "side": "down",
   "amount": "1"
  },
  "out": {
   "in": "5",
   "fee": "1",
   "rUp": "99999999",
   "rDown": "100000004"
  }
 },
 {
  "name": "refused: sell larger than the reserve",
  "op": "sell",
  "in": {
   "rUp": "100000000",
   "rDown": "100000000",
   "side": "up",
   "amount": "99000000"
  },
  "out": {
   "error": "Sell too large for the reserve"
  }
 },
 {
  "name": "refused: more than MaxIn",
  "op": "sell",
  "in": {
   "rUp": "100000000",
   "rDown": "100000000",
   "side": "up",
   "amount": "5000000",
   "maxIn": "10000000"
  },
  "out": {
   "error": "needs 10478386 tokens, more than MaxIn 10000000"
  }
 },
 {
  "name": "the Amount for selling 10 Up",
  "op": "sellFor",
  "in": {
   "rUp": "100000000",
   "rDown": "100000000",
   "side": "up",
   "tokens": "10000000"
  },
  "out": {
   "amount": "4777576",
   "in": "10000000",
   "fee": "97502",
   "rUp": "105222424",
   "rDown": "95222424"
  }
 },
 {
  "name": "withdraw all after Up won",
  "op": "withdraw",
  "in": {
   "shares": "100000000",
   "seed": "100000000",
   "rUp": "153000000",
   "rDown": "65400000",
   "result": "up"
  },
  "out": {
   "amount": "153000000"
  }
 },
 {
  "name": "withdraw all after Down won",
  "op": "withdraw",
  "in": {
   "shares": "100000000",
   "seed": "100000000",
   "rUp": "153000000",
   "rDown": "65400000",
   "result": "down"
  },
  "out": {
   "amount": "65400000"
  }
 },
 {
  "name": "withdraw half after Void (odd total, rounded down)",
  "op": "withdraw",
  "in": {
   "shares": "50000000",
   "seed": "100000000",
   "rUp": "153000000",
   "rDown": "65400001",
   "result": "void"
  },
  "out": {
   "amount": "54600000"
  }
 }
]
```

## For mainnet

- The U64 cap on `k` (4,000 zUSDC a side) is for the testnet. Mainnet needs one of these:
  - U128 arithmetic in the contract (Zen.Integers has the conversions; the cost of a 128-bit multiply and divide is
    to be measured);
  - reserves kept in scaled units.

## The log (for the mainnet decision)

The bets service keeps one line per market in `amm-log.json`, and `GET /explorer/api/bets/amm-log` serves it:
- the market;
- the seed;
- the trades and the volume;
- the fees earned;
- the reserve at the cutoff;
- the result (Up, Down or Void);
- what Withdraw returned;
- the seeder's result.
