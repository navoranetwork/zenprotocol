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
  1. Opens one market per ticker for the next close: `BETS_CLOSE_UTC`, 22:00 UTC by default, at least 12 h ahead.
     Stocks and gold open only on weekdays. The line is the oracle's latest value to 3 digits (BTC 82,396 → 82,400).
  2. Seeds each market: Issue `BETS_SEED` (2 zUSDC), then offers Up and Down on the Dex at `BETS_ODDS` (0.55 each).
  3. After the close: takes the oracle's round stamped with the close and runs Attest to the contract. Once the token is
     in the contract's wallet, it sends Settle with the winner.
  4. Sends Void for a market with no Settle 24 h after its close.
  A market's state comes from the markers the contract holds, so a restart loses nothing. `markets.json` in its data
  directory keeps the list and the transactions sent.
- **`site/bets/core.mjs`**: token ids, lines, closes, state, message bodies. `site/test/bets.test.mjs`: 7 tests. The
  token subtypes match the engine's try on dab00f8 byte for byte.
- **Explorer API:**
  - `GET /explorer/api/bets/markets`: the service's list. Each market has `bull` and `bear` (asset ids), `event` (the
    body fields), `status` (open, closing, settled, void, voidable), `result`, `settlePrice`, and `book.up` /
    `book.down` with the best ask and bid in zUSDC (0 to 1).
  - `GET /explorer/api/bets/positions?address=`: the address's Up and Down tokens per market. Each has `pays` (once
    settled or void), `redeemable` and `valueNow` (at the best bid).
- **Activation:** `scripts/v1/testnet-v1-bets.mjs` prints `BETS_CONTRACT` and `BETS_ID`. In `testnet-stack.env` also set:
  - `BETS_SIGN`: a key of its own, not the bridge's;
  - `BETS_DEX`;
  - `BETS_ORACLE_ADDRESS` and `BETS_ORACLE_ID`;
  - `BETS_ORACLE_KEY`: the oracle's compressed public key;
  - `BETS_COLLATERAL`: zUSDC.
  Then `docker compose … --profile bets up -d bets`. Never `--remove-orphans`.

## The wallet (ZP Wallet 0.32.2, testnet)

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
- **Not in the wallet:** Issue and Cancel of pairs, selling a position back before the close (possible today as a
  limit order on the Dex tab's "Any pair"), and Settle and Void, which the market service sends.
- **Tests:**
  - `wallet/test/bets.test.js`: rows, offers, quotes, Redeem values, the explorer answer, and the Redeem body of the
    live BTC market, compared byte for byte with `bodies.redeem` in `site/bets/core.mjs`.
  - `wallet/tools/ui-test/run-bets.py`, against `mock-node.mjs` with `bets=1`: the note before activation, markets and
    prices, a greyed side, a bet sent as a Take of 1.20 zUSDC for 2 tokens, Collect after a win and after a void.
- **Checked live on the testnet, 2026-10-16:** both first markets with Up and Down at 0.55, once the Issue and the
  Makes were in a block (2910–2911).

## Still to build

1. The first real Settle: the BTC and ETH markets of 2026-10-17 22:00 UTC (Attest, then Settle, about two blocks after
   the close round). Then a real Collect from the wallet, and its Redeem transaction kept as a vector.
2. Wallet, later: positions under Activity → Trading, the value now at the best bid (from `/bets/positions`), and
   selling a position back from the bet card.
