# Up / Down markets on oracle prices (FixedPayout V1)

Status, 2026-10-16: the contract is written (`contracts/v1/FixedPayout.fst`), not built yet. It needs the node image
with zp-contracts-v1 dab00f8 or later (`Zen.MerkleTree`, `Zen.Integers`). `contracts/v1/probes/MerkleProbe.fst`, which
proves an oracle price the same way, passed on dab00f8. The oracle service stamps rounds with their slot (below); that
change also waits for a lab build. Nothing here is on the testnet yet.

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

## Still to build

1. The engine check and tries of `contracts/v1/FixedPayout.fst` on dab00f8 (the V1 session or the lab), then
   activation on the testnet.
2. The market service:
   - opens markets (lines near the price, daily closes);
   - runs Attest for each close round to the contract, then Settle;
   - seeds each book by minting pairs.
3. Explorer: `GET /explorer/api/bets/markets` and `GET /explorer/api/bets/positions?address=`.
4. Wallet: the Up / Down flow in the Oracle tab, Redeem after the close, positions under Activity → Trading.
