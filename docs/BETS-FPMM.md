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
| Seed | signed | none | N collateral | once per market. Mints N Up + N Down into the contract (the reserve), N "Seed" to the contract, N "Shar" to the sender |
| Buy | signed | Position ("Bull" / "Bear"), MinOut (U64) | x collateral | tokens of that side to the sender, at the reserve's price; refused below MinOut |
| Sell | signed | Position, Amount (U64: collateral wanted), MaxIn (U64) | up to MaxIn tokens of that side | Amount collateral to the sender; the tokens not needed come back; refused if more than MaxIn are needed |
| Cancel | signed | none | N Up + N Down | N collateral, any time (as FixedPayout) |
| Settle, Void | anyone | as FixedPayout | none | as FixedPayout (the oracle round at the close; Void after 24 h without Settle) |
| Redeem | signed | Position | N tokens | after Settle: N collateral for the winner; after Void: N/2 for either |
| Withdraw | signed | none | S "Shar" | after Settle or Void: S / Seed of what the reserve is worth, see below |

Sell names the collateral wanted, not the tokens given. Solving for the tokens given needs a square root, which the
contract does not have. The wallet finds the Amount for a number of tokens itself (the quote API below does it).

### The price, the trade, the fee (integers, rounded against the trader)

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
}
```
- `trading` is false after the cutoff, or before Seed.
- `fees` and `volume` are summed from the market's Buy and Sell transactions.
- `seeder.result` is set at Withdraw: what came back minus the seed, as a string.

`GET /explorer/api/bets/quote?market=<Up asset id>&side=up|down&action=buy|sell&amount=<units>[&slippage=0.01]`:
- buy: amount = collateral to spend;
- sell: amount = tokens to sell.

The answer:
```json
{ "action": "buy", "side": "up", "in": "10000000", "out": "31480000", "fee": "60000",
  "avgPrice": 0.3177, "priceBefore": 0.2994, "priceAfter": 0.3361,
  "minOut": "31165200", "tip": 4321,
  "call": { "contract": "ctzn1…", "command": "Buy", "bodyHex": "0c…",
            "spends": [{ "asset": "<collateral>", "amount": "10000000" }] } }
```
- For a sell, `out` is the collateral, `call.command` is "Sell", the body carries `Amount` = out and `MaxIn` = the
  tokens, and `spends` is the tokens.
- `minOut` (buy) and `Amount` (sell) already take off `slippage` (default 1%).
- The wallet signs and sends `call` as it is, or builds the same body itself.
- If the reserve has changed when the transaction is mined, the contract refuses it, and nothing moves.

`GET /explorer/api/bets/positions?address=` is unchanged. For a market of the new contract, `valueNow` is the quote of
selling the whole position.

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
