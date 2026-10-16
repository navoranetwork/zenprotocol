# Up / Down markets on oracle prices (FixedPayout V1)

Status, 2026-10-16: the contract (`contracts/v1/FixedPayout.fst`) passed on zp-contracts-v1 dab00f8 (the V1 session's
run of `scripts/v1/fixedpayout-try.mjs`, zenprotocol 94793406): the node's check, then all 38 try checks.
- Contract id with the f06ddc34 source: `000000010accfe3879fd9c12aad647f51f2fe034202828c0329ea7a035033c15707d472c`
  (17,231 bytes). A later edit of the source, even a comment, gives another id.
- Gas used:
  - Issue, Cancel and refusals: 22,547 to 23,059;
  - Settle: 10,311 (path of 0);
  - Redeem: about 24,000;
  - Void: about 23,000.
  Every call is within its declared 30,000 + 512 per coin.
- The oracle's slot stamping built on zp-lab-1 (selftest 18 ok at fecec897).

**Live on the testnet since 2026-10-16** (node image on dab00f8):
- fixedpayout-try passed there too, with the same id.
- Activated at 13:39 UTC: `ctzn1qqqqqqqg2enlrs70ansf244j8750jlcp5yq5z3spjn6n6qdgr8s2hql289scfxf0c`, expires at block
  22,905.
- The oracle runs hourly slots (first stamped round 1792155600000 = 13:00:00 UTC).
- The `bets` service has been running since 13:50 UTC, with these keys:
  - signing key m/44'/258'/0'/2/1 (from mm-key.mjs; public key 021785702c28…);
  - the oracle's key 02bee4711911864b76160c865bd29cb8a33c9f4a6d0186dffa02808b0daf122a15;
  - EUR is added to `BETS_DAILY`: no FX markets on weekends.
- The first markets close 2026-10-17 22:00 UTC (1792274400000):
  - **BTC ≥ 81,900**: Issue 1c5742bf…2961, Make Up/Down 58dd06d0…9c9e / 301a58bb…90ec;
  - **ETH ≥ 2,460**: Issue a0ba3015…ce30, Make 1d4e1d79…c409 / c7c4390d…348d.

  The Makes follow the Issue in the same minute: the node wallet spends its unconfirmed outputs.
- A dry run left behind (`docker compose run` under `timeout` leaves the container running) held port 8097. Since
  b9c52641 the service listens before its loop and stops at once on a taken port. For a dry run, remove the container
  afterwards: `docker ps -aq --filter name=bets-run | xargs -r docker rm -f`.
- At 13:59 UTC the wallet session saw the Issue and the Makes still in the mempool. By 14:07 the chain had gone
  2907 → 2911 and they were mined: an ordinary wait for blocks (4 min on average).
  - Block weight is not a limit for these calls. A V1 call weighs 400 × its declared gas, plus the signature and
    100 × its size: about 12–13M for an Issue, against a block limit of 8,000M (zp-pow testnet-v1, `Consensus/Weight.fs`).
  - The template builder adds a call that spends an earlier call's outputs in a later pass
    (`BlockTemplateBuilder.foldUntilUnchanged`).
- 2026-10-16 evening: the wallet session's feedback (static 0.55 offers get picked off; one line per ticker; 2 tokens
  of liquidity): the service now quotes at fair value with bids, opens 5 lines per ticker and quotes 10 tokens per
  order (above, "The market service").
- 14:08 UTC: `/explorer/api/bets/markets` showed ask 0.55 on Up and Down for both markets. The ZP Wallet (Markets →
  Oracle, "Up or down?") shows them with the close in local time and the 0.50 void rule.

## What a market is

One question on one oracle price at one moment: "Will BTC be at or above 110,000 at 22:00 UTC on 20 October?"

- **Bull** (shown as **Up**) wins if the oracle's price at the close is at or above the line; **Bear** (**Down**) wins
  if it is below.
- Each side is a token worth 1 unit of the collateral (zUSDC) if it wins and 0 if it loses. Its price on the Dex is
  the market's probability.
- The contract never matches bets. It mints pairs: anyone locks N zUSDC and gets N Up + N Down, then keeps one side
  and sells the other on the Dex. A pair is always worth exactly what it locked, so the contract never owes more than
  it holds.

A market is the message-body fields below. The same seven fields appear in every command:

| Field | Type | |
| --- | --- | --- |
| OraclePubKey | PublicKey | the oracle's key (compressed, 33 bytes) |
| OracleContractId | String | the V1 Oracle contract id (72 hex) |
| Ticker | String | up to 4 characters, as the oracle names it (BTC, EUR, XAU) |
| Price | U64 | the line × 1000 (the oracle keeps 3 decimals) |
| Start, Expiry | U64 | both equal to the close, in ms (a slot of the oracle, below) |
| Collateral | String | the asset id staked and paid (zUSDC) |

## Commands

| Command | Who | Body (beyond the market) | Spend | Effect |
| --- | --- | --- | --- | --- |
| Issue | anyone, signed | none | N collateral | N Bull + N Bear to the sender |
| Settle | anyone | Position (the winner: "Bull" or "Bear"), Root, Timestamp (= the close), Value, Index, AuditPath (up to 30 hashes) | none | records the winner, once; within 24 h after the close |
| Void | anyone | none | none | more than 24 h after the close with no Settle: the market is void |
| Redeem | a holder, signed | Position | N tokens of that position | N collateral if it won; N / 2 (rounded down) if void |
| Cancel | a holder, signed | none | N Bull + N Bear | N collateral, at any time |

- **Settle** checks the oracle's proof: the leaf (SHA3 of the ticker, then the value × 1000 as a U64) against the round's
  Merkle root, the round is the close, the side matches the price, and the round's attestation token is in this
  contract's wallet. That token comes from the Oracle contract's `Attest` with this contract as the recipient. The
  market service runs it once per close round, so users never do.
- **Redeem** needs no proof: the winner (or the void) is already recorded.
- **Missing close (decided 2026-10-16):** the close round is stamped with the close time even if it is committed
  late, so an oracle outage of a few hours delays the Settle but does not void the market. With no Settle within
  24 hours, Void opens and every token pays 0.50. Holders of pairs get back exactly what they locked. A holder of one
  side gets 0.50 whatever they paid for it, as if the outcome were 50/50. The page says so on every market.
- No markets on stocks and gold over weekends and holidays, when there is no close.

## Tokens

Assets of the FixedPayout contract with subtype SHA3 of:
1. OraclePubKey (compressed);
2. OracleContractId;
3. Ticker padded to 4 characters;
4. Price U64;
5. the close U64;
6. Collateral;
7. a 4-character tag.

The tags are "Bull" and "Bear" for the positions, and "BuWn", "BeWn" and "Void" for the settlement markers the
contract keeps (one unit each). The markets API (below) gives the asset ids.

## The oracle's slots

Rounds are stamped with the start of their interval (hourly: 13:00:00.000), not the moment they are made. Facts about
the slots:
- one round per slot;
- a failed round is retried every 5 minutes within its slot;
- a close is therefore a known timestamp (a whole hour).

Stocks and gold carry their daily close (fetched after 21:30 UTC), so their markets close at 22:00 UTC or later.

## Cost

Every command declares 30,000 + 512 per coin in the contract's wallet. That is above Settle, the costliest: the proof
over a path of 30, the token and attestation hashes, and four reads of the wallet. The others are padded to it. V1 has
no fee per gas; the cost counts toward the block's weight.

## The market service and the API (written 2026-10-16, tested without the chain)

- **`site/bets/bets.mjs`** (the `bets` service of the testnet stack, profile `bets`, 127.0.0.1:8097). Each minute:
  1. **Opens the lines.** For each ticker and the next close (`BETS_CLOSE_UTC`, 22:00 UTC by default, at least 12 h
     ahead) it opens one market per offset in `BETS_OFFSETS` (0, ±1 %, ±3 %): the oracle's latest value moved by the
     offset, to 3 digits (BTC 81,981 → 79,500 / 81,200 / 82,000 / 82,800 / 84,400). The lines of a ticker and close
     are set once. Stocks, gold and FX (`BETS_DAILY`) open only on weekdays.
  2. **Quotes every open market on the Dex** (since 2026-10-16, after the first static 0.55 offers were easy to pick
     off):
     - The fair price of Up is p = N(d2) = N((ln(S/K) − σ²T/2) / (σ√T)), where:
       - S is the latest round's value;
       - K is the line;
       - T is the time to the close in years;
       - σ is `BETS_VOL` of the ticker (annual: BTC 0.55, ETH 0.75, EUR 0.08, XAU 0.16, SPY 0.18, AAPL 0.28,
         MSFT 0.25).
     - It posts four orders per market: Up bid and ask around p, Down bid and ask around 1 − p. They are `BETS_SPREAD`
       (0.06) wide, on cents, with asks at most 0.99 and no bid below 0.01. Each order is `BETS_QUOTE` (10) tokens.
     - It cancels and makes an order again when it is more than `BETS_MOVE` (0.03) from its target, or has less than a
       quarter of its size left. A taken order is made again.
     - Before an order goes out, its slot waits while that order is in the mempool, or while a Take or Cancel on it
       is. The orders come from the explorer's `/dex/orders?pending=1`, which includes the newest blocks and the
       mempool.
     - It stops quoting and cancels its orders `BETS_STOP_MIN` (20) minutes before the close. It does the same when
       the latest round is older than `BETS_STALE_MIN` (150).
     - Ask tokens come from Issue, `BETS_QUOTE` at a time, up to `BETS_MAX_ISSUE` (30) per market. The bids together
       lock at most `BETS_BID_BUDGET` (30 zUSDC).
     - At most `BETS_MAX_TX` (8) transactions per minute.
     - The price comes from the hourly rounds, so a move within the hour shows up only at the next round; the spread
       covers that.
  3. **Settles after the close.** It takes the oracle's round stamped with the close and runs one Attest to the
     contract, which serves every market of that close. Once the token is in the contract's wallet, it sends Settle
     for each market with its winner.
  4. **Voids** a market with no Settle 24 h after its close.
  5. **Redeems** the winning tokens it holds once a market is settled (both sides of a void one), so its collateral
     comes back.

  A market's state comes from the markers the contract holds and from our orders on the Dex, so a restart loses
  nothing. `markets.json` in its data directory keeps the list and the transactions sent.
  - **zUSDC needed:** at most 30 per market for asks, plus the 30 bid budget.
  - **On a weekend:** 2 tickers × 5 lines start with 10 each: about 130 zUSDC.
  - **With less:** it quotes what it can and logs `short of …`.
- **`site/bets/core.mjs`**: token ids, lines, closes, state, message bodies. `site/test/bets.test.mjs`: 11 tests (lines, N(d2), quotes, the requote plan). The
  token subtypes match the engine's try on dab00f8 byte for byte.
- **Explorer API:**
  - `GET /explorer/api/bets/markets`: the service's list. Each market has `bull` and `bear` (asset ids), `event` (the
    body fields), `status` (open, closing, settled, void, voidable), `result`, `settlePrice`, `fair` (the service's
    fair price of Up, null when not quoting), `quoting`, and `book.up` / `book.down` with the best ask and bid in zUSDC
    (0 to 1).
  - `GET /explorer/api/bets/positions?address=`: the address's Up and Down tokens per market. Each has `pays` (once
    settled or void), `redeemable` and `valueNow` (at the best bid).
- **Activation:** `scripts/v1/testnet-v1-bets.mjs` prints `BETS_CONTRACT` and `BETS_ID`. In `testnet-stack.env` also set:
  - `BETS_SIGN`: a key of its own, not the bridge's;
  - `BETS_DEX`;
  - `BETS_ORACLE_ADDRESS` and `BETS_ORACLE_ID`;
  - `BETS_ORACLE_KEY`: the oracle's compressed public key;
  - `BETS_COLLATERAL`: zUSDC.
  Then `docker compose … --profile bets up -d bets`. Never `--remove-orphans`.

## The wallet (ZP Wallet 0.33.0, testnet)

Markets → Oracle shows an **Up or down?** card above the prices, filtered by the same chips as the prices (Crypto,
Forex, Stocks, Commodities). The wallet computes no ids: everything comes from `GET /explorer/api/bets/markets`.
Code: `wallet/src/bets.js` (pure parts) and `betsCard`, `yourBets`, `betModal`, `betRedeem` in `wallet/web/app.js`.

- **Before the contract is active** (the markets API does not answer), the card is a short note.
- **Markets.** Every open market whose close is ahead shows "TICKER at or above LINE", its close in local time with
  the time left, and two buttons, **▲ Up** and **▼ Down**. Each button shows the price of one token in zUSDC: the
  cheapest Dex order in `/explorer/api/dex/orders` that sells that token for the collateral, already in a block.
  Pending orders and orders being taken are skipped. A side with no such order is shown greyed out. The rule is
  printed under the list: "If the oracle has no close price within 24 hours, every token pays 0.50."
- **Checks on each row** (`marketOf`): the seven event fields are well formed; Start equals Expiry; the bull and bear
  ids differ; the collateral is the one at the top of the answer (other rows are dropped); the contract id comes from
  the top-level `contractId`. Up and Down tokens are named "BTC 81,900 Up" / "… Down" and counted with the
  collateral's 6 decimals, everywhere in the wallet.
- **A bet** is a Dex Take of that order. The sheet:
  - says when you win, for example "BTC is at or above 81,900 at 01:00 18 Oct";
  - takes a stake in zUSDC, at most the order's total and the wallet's spendable zUSDC;
  - shows as you type "If right you get N zUSDC (+profit)" and "If not 0". N = floor(order amount × stake / order
    total), the Dex's rule.
  
  Review re-reads the order on the chain ("Someone took it first" if it is gone). The confirmation lists the bet, the
  close, the stake and the payout. The Take is checked before signing, as every Dex Take: the Dex pays exactly that
  and nothing goes elsewhere. It is anonymous, as on the Dex tab.
- **Your bets** lists the wallet's Up and Down tokens per market, read from its own balance:
  - open: "If right: N zUSDC";
  - closing or voidable: "waiting for the result" / "being voided (0.50 per token)";
  - settled and won: **Collect N zUSDC**;
  - settled and lost: "Lost";
  - void: **Collect N/2 zUSDC**.
- **Collect** is a signed `Redeem` to the contract id: the event's seven fields plus `Position` ("Bull" | "Bear"),
  spending all of that side's tokens. Before signing, the wallet checks that the contract pays the signer's key
  exactly N (won) or floor(N/2) (void), and nothing to anyone else. The row then shows "Collecting…" until the next
  block.
- **Sell** (0.33.0), on an open position in Your bets: a sheet with the holding, the best bid if someone is buying
  (**Sell now** = a Take of that bid, for as many tokens as it takes), and a price per token (below 1, at most 4
  decimals; total at least 0.01 zUSDC) with how many tokens. Review places a signed Dex Make of the tokens for the
  total. The order shows under the position as "On sale: N at P" with Cancel (or "waiting for its block").
- **Not in the wallet:** Issue and Cancel of pairs, and Settle and Void, which the market service sends.
- **Tests:**
  - `wallet/test/bets.test.js`: rows, offers, quotes, Redeem values, the explorer answer, and the Redeem body of the
    live BTC market, compared byte for byte with `bodies.redeem` in `site/bets/core.mjs`.
  - `wallet/tools/ui-test/run-bets.py`, against `mock-node.mjs` with `bets=1`: the note before activation, markets and
    prices, a greyed side, a bet sent as a Take of 1.20 zUSDC for 2 tokens, Collect after a win and after a void.
- **Checked live on the testnet, 2026-10-16:** both first markets with Up and Down at 0.55, once the Issue and the
  Makes were in a block (2910–2911).

## Where we are (2026-10-16, 19:00 Israel)

The testnet still runs the first version of the service, with static 0.55 offers on BTC ≥ 81,900 and ETH ≥ 2,460.
The fair-value quoting (892c5797, above) is pushed but **not deployed yet**. Open steps, all on the testnet server
(91.98.3.17, `~/zenprotocol-testnet`):

1. **Check the zUSDC in the node wallet.** The wallet is shared with the ZP market maker, whose three bid levels lock
   about 120. The new service needs about 130 on a weekend (10 markets), or less with a smaller `BETS_QUOTE`:
   ```
   curl -s localhost:31567/wallet/balance | python3 -c "import sys,json;print(sum(x['balance'] for x in json.load(sys.stdin) if x['asset'].startswith('000000015ab27aa3'))/1e6)"
   ```
   If short: bridge more USDC, or set `BETS_QUOTE=5000000`, `BETS_MAX_ISSUE=15000000` and `BETS_BID_BUDGET=15000000`
   in `testnet-stack.env`.
2. **Dry run.** It needs the port, so stop the service first, and remove the container afterwards:
   ```
   git pull -q; C="docker compose -f docker-compose.testnet.yml -f docker-compose.testnet-stack.yml"
   $C stop bets
   timeout 40 $C --profile bets run --rm -T -e BETS_DRY=1 -e BETS_DATA=/tmp/dry -e BETS_MAX_TX=40 bets | cut -c1-150 | head -45
   docker ps -aq --filter name=bets-run | xargs -r docker rm -f
   ```
   Expect `open` lines for 5 BTC and 5 ETH lines, then `issue`, `ask` and `bid` lines with `fair Up` near 0.5 for
   the middle line.
3. **Go live:** `$C --profile bets up -d --force-recreate bets`, then `$C logs --tail 30 bets`.
   - The old 0.55 offers stay while they are within 0.03 of the fair price.
   - Otherwise they are cancelled. Their 2 tokens are below the minimum size, so they are made again at 10.
4. **Tell the wallet session:**
   - each market now has `fair` and `quoting` in `/bets/markets`;
   - bids exist, so Sell now works;
   - a ticker has 5 lines per close.
5. **First Settle:** the close of 2026-10-17 22:00 UTC. A check is scheduled for 22:40 UTC:
   ```
   $C logs --since 1h bets | grep -E "attest|settle|redeem|failed"
   curl -s localhost:11581/explorer/api/bets/markets | head -c 800
   ```

### Fair-value quoting on the testnet (2026-10-16 evening)

- Live since 19:12 UTC with `BETS_QUOTE` 5, `BETS_MAX_ISSUE` 15 and `BETS_BID_BUDGET` 25, and 80 zUSDC bridged to
  the service's key (`tzn1qr606fj36kxfx6czpw4nxd805lp6jly3r0pld994jjue9jzv3qvuszejah2`, m/44'/258'/0'/2/1). Lines:
  - BTC: 78,600, 80,200, 81,000, 81,800, 83,500, plus the first 81,900;
  - ETH: 2,330, 2,380, 2,400, 2,430, 2,480, plus 2,460.
- First run: a second Issue and copies of orders a minute later, the same order cancelled three times, and a refused
  Cancel ("Could not find order in wallet") ending the cycle.
  - The service now remembers its own Makes for 20 minutes (in `recent-makes.json`, kept across restarts) and its
    Cancels for 10. A refused call no longer stops the cycle. Commits 2016d6e1, 7fb0e52d and 2fc5d65c.
- Open: the explorer's `/dex/orders?pending=1` did not show our Makes, or mark our Cancels, while they were in the
  mempool.
  - `scripts/v1/dex-mempool-probe.mjs` shows that a mempool Cancel parses correctly: the target matches the order,
    and `contractId` = `ZEN_DEX`.
  - The cause is not found yet. The suspect is the step between a block and `/addressdb/balance` of the Dex: an order
    counts as open only while the Dex holds its order asset.
  - The service no longer depends on it.

## Still to build

1. The first real Settle: the BTC and ETH markets of 2026-10-17 22:00 UTC (Attest, then Settle, about two blocks after
   the close round). Then a real Collect from the wallet, and its Redeem transaction kept as a vector.
2. Wallet, later: positions under Activity → Trading, and the value now at the best bid (from `/bets/positions`).
