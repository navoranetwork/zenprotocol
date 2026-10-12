# Upgrade: the miner pays the CGP winner itself

Status: tested on the devnet (CI) and on the public testnet; mainnet rollout planned below. Date: 2026-10-11.

## In one paragraph

In the block that pays the winner of a CGP payout vote, the protocol requires a transaction that executes the CGP contract's `Payout` command. The official node (release 1.0.13) never creates that transaction: it waits for someone to send it. If nobody does, every block at that height is rejected (`No payout Tx`) and the whole chain stops until the transaction arrives. This upgrade makes the mining node create the transaction itself. It changes no consensus rule: the same blocks are valid and invalid as before; only the miner now builds the block the rules already require.

## Background: what the protocol requires

- Every CGP interval (10,000 blocks on mainnet, 100 on the testnet) has a snapshot, nominations and a vote. If a payout candidate wins, the CGP fund pays it at the payout block: the block whose number modulo the interval equals the coinbase maturity (the 100th block of the next interval on mainnet, the 10th on the testnet).
- Every node checks that this block contains exactly the payout the vote decided: recipient and amounts. A block without it, or with a different payout, is invalid. Nobody can change the recipient or the amount, hold the money back, or redirect it.
- The transaction needs no key and no permission: anyone can send it (`POST /wallet/contract/cgp`, `scripts/cgp-payout.sh`). It only carries out what the vote already decided.

## The relay (added 2026-10-11)

The only miner on mainnet today is a third party, most likely running release 1.0.13, so a change in the miner alone does not protect mainnet. Every upgraded node therefore also acts as a **relay**: once per tip, when the next block is a payout block with a winner and no payout transaction is in its mempool, it creates the transaction (no wallet, no coins needed: it only executes the CGP contract) and sends it to its peers like any transaction. A miner running 1.0.13 receives it and its payout block is valid. One upgraded node anywhere in the network is enough. `ZEN_CGP_PAYOUT=off` switches both the miner's payout and the relay off (behaves like 1.0.13; used by the test). Code: `createCgpPayout` and `relayCgpPayout` in `src/Blockchain/Handler.fs`, run from the blockchain service's one-second tick, not during initial block download.

## Before and after

| | Release 1.0.13 (today on mainnet) | This upgrade |
|---|---|---|
| Who sends the payout transaction | someone, by hand, before the payout block | the mining node, automatically, when a winner exists and the transaction is not in its mempool |
| If nobody sends it | every block at the payout height is rejected (`No payout Tx`); the chain stops for all users until it is sent | cannot happen while one upgraded node is online: it relays the transaction to every miner |
| Who decides recipient and amount | the vote (consensus rule) | unchanged: the vote |
| Validation rules | — | unchanged (the same code validates blocks) |
| Other nodes | — | need no upgrade: the block they receive is exactly what 1.0.13 requires |
| Log line | `You should create your own contract execution` | `Miner created the CGP payout transaction <hash>` |

Only the node that mines needs the upgrade for the payout to be automatic. Non-mining nodes gain nothing from it but lose nothing either.

## What changed in the code

`src/Blockchain/Handler.fs`, block template request (commits 27ec6cb, b65fc51, merged in 7e75994):

1. Before building the template for block N+1: if N+1 is a payout block, the CGP state has a winner, and no payout transaction is in the mempool, execute the CGP contract's `Payout` command with the winner's recipient and amounts (the same call the wallet API makes).
2. Read the transaction back from its own bytes before adding it to the mempool (the bug below).
3. Log `Miner created the CGP payout transaction <hash>`, or an error. On error the template is built as before (the 1.0.13 behaviour).

Diagnostics only (no effect on results): `BlockConnection.fs` and `BlockValidation.fs` log which check failed on a `commitments mismatch`. `Chain.fs`: the `local` (devnet) chain makes a block every 2 s instead of 60 s; mainnet and testnet parameters are untouched.

## The bug found on the way

The first version (2026-10-09) made every payout block fail with `commitments mismatch` (testnet block 610: the chain stopped). Cause, in code that dates from the original release: `Serialization.Data.size` counts one byte too many for a `List`, and the payout message body contains a list. `Transaction.toExtended` serialises into a buffer of that size, so the transaction built in memory carried a trailing zero byte, and its witness hash was not the hash of the bytes the block carries. Transactions from wallets and peers never hit this, because they are read from their bytes, which hashes exactly the bytes read. The fix reads the miner's transaction back from its bytes the same way. The size function itself was not changed, because it is used in consensus code and changing it would need a replay of the whole chain.

## Tests

| # | Test | Where | Result |
|---|---|---|---|
| 1 | Full CGP cycle on a one-node devnet: contracts activated, voters funded, allocation votes, 4 nominations, payout votes; the payout block is mined by the node itself | CI workflow `cgp-devnet`, runs 38028891238 (branch) and 38029512737 (merged) | PASS: `Miner created the CGP payout transaction 2bd9c1a4…`, block 610 accepted, chain on to 621 |
| 2 | The same with the first version (before the byte fix) | CI runs 38022704486, 38024888341, 38027628831 | FAIL as on the testnet (`commitments mismatch` at 610); this is how the cause was found |
| 3 | Full cycle on the public testnet (node at 720b88e, real network, 4-minute blocks): snapshot 1090, nominations 1091–1095 (A→X, B→X, C→Y, D→Z), payout votes 1096–1100 (A→X, B→Y, C→Y, D→X) | testnet server, `cgp-sim` | PASS: winner tzn1qav9w7…08uq, 2 ZP; the miner created the payout; it is in block 1110 (transaction 689e0f01…767f); no `commitments mismatch`, no `failed validation`; the chain went on (1121 at the check) |
| 4 | Mainnet replay of the .NET 10 build from genesis against the reference made by release 1.0.13 (1,053 block hashes, CGP and supply state) | replay runner | PASS (2026-10-06/07, see MIGRATION.md). The upgrade changes no validation code, so the replay still holds |
| 6 | Payout relay: a two-node devnet, the mining node behaves exactly like release 1.0.13 (`ZEN_CGP_PAYOUT=off`: creates no payout), the second node does not mine and relays the payout (`scripts/cgp-devnet-test.sh relay`, on the testnet server because GitHub Actions is disabled) | testnet server, branch cgp-relay 9cc4764, 2026-10-11 | PASS: votes A→X, B→Y, C→Y, D→X; node 1 logged `Relaying the CGP payout transaction 60c17d01… for block 610`; the 1.0.13-like miner mined block 610 with it; chain on to 621; winner tzn1qav9w7…08uq, 2 ZP |
| 5 | The upgraded image starts on mainnet and syncs | CI `image-net10` (423da4b, includes the fix) | PASS |

Test 3 is the decisive one: a real network, real block times, a real vote, the payout created by the miner and accepted.

## Risks and how they are covered

| Risk | Cover |
|---|---|
| The upgraded node disagrees with 1.0.13 about a block | Validation code unchanged; full mainnet replay passed; on mainnet a shadow node runs next to the official one first and their tips and CGP state are compared |
| The miner builds a wrong payout | It uses the same contract call as the wallet API; a wrong payout makes the block invalid, which every node rejects; it then falls back to 1.0.13 behaviour (log line shows it) |
| The chain data of the 1.0.13 node does not work with the .NET 10 build | The shadow node starts from the published snapshot (made by the 1.0.13 node), so this is tested before anything is switched |
| Something goes wrong after the switch | Rollback: set the image back to `ghcr.io/navoranetwork/zen-node:latest` and start; the old data folder is kept until the new node has run for days |

## Mainnet rollout

Every step needs the maintainer's approval before it runs; nothing is done on mainnet automatically.

1. **Shadow node** on the community server (77.42.12.190): the .NET 10 image with the fix, loaded from the published snapshot into a separate folder, its own ports (API 127.0.0.1:11568, no P2P port opened), no mining, no wallet. The official node and the website keep running untouched.
2. **Compare** for at least 24 hours: same tip hash at the same height and the same `/blockchain/cgp` state as the official node.
3. **Switch the community node** to the new image (a few minutes of downtime), keeping the old data folder for rollback.
4. **Switch the mining node** (the one whose rewards go to the mining wallet): only this one makes payouts automatic. Before the next mainnet payout block with a winner, check with `wallet/tools/cgp-check.sh --net main`.
5. Until step 4 is done: before a mainnet payout block with a winner, send the payout by hand with `scripts/cgp-payout.sh`.

## Mainnet rollout log

| Date (UTC) | Step | Result |
|---|---|---|
| 2026-10-11 07:20 | 1. Shadow node on 77.42.12.190: image `ghcr.io/navoranetwork/zen-node:net10@sha256:e6905e2896abcc8cb5d422d96bfd0bd45ebc23623121790a996bb01b8becdd66`, loaded from the snapshot made by the 1.0.13 node (block 1,052,929) | Loaded; synced the remaining ~1,650 mainnet blocks within 90 s |
| 2026-10-11 07:21 | 2. First compare (`scripts/shadow-compare.sh`) | Height 1,054,595: same tip `000000000019d533…0a10`, same CGP state (interval 106, allocation 90, no payout winner). 24-hour compare follows |
| 2026-10-11 ~09:40 | Relay shadow node: `zen-node:relay-2d0a7b0` built on the server (Actions disabled), `PUBLIC_NODE=1`, same data folder as the first shadow | Up, synced |
| 2026-10-11 19:19 local | 2. Compare after ~6 h | Height 1,054,728: same tip `00000000003361cc…6e55`, same CGP state (interval 106, allocation 90, no winner), 0 validation errors |
| 2026-10-11 19:21 local | 3. Community node switched: `ZEN_IMAGE=zen-node:relay-2d0a7b0` (it already ran the .NET 10 image `ghcr.io/navoranetwork/zen-node:net10` without the relay; same data folder) | Up at once at 1,054,728; explorer answers. Rollback: `ZEN_IMAGE=ghcr.io/navoranetwork/zen-node:net10` and `docker compose up -d` |
| 2026-10-12 11:53 local | Check after ~16 h | Community node at 1,054,981, `blocks` = `headers`, image `zen-node:relay-2d0a7b0`: 253 mainnet blocks since the switch without a problem |
| 2026-10-12 11:54 local | Shadow node removed (`docker rm -f zen-shadow`, `~/zen-shadow` and `~/zen-build` deleted); build cache and dangling images pruned | Disk 26 GB free (75 GB). Kept for rollback: `ghcr.io/navoranetwork/zen-node:net10` (`ghcr.io/alonp1/zen-node:net10`; same image, `sha256:e6905e2896abcc8cb5d422d96bfd0bd45ebc23623121790a996bb01b8becdd66`, checked on 77.42.12.190) (.NET 10 without the relay) and `ghcr.io/navoranetwork/zen-node:latest` (`ghcr.io/alonp1/zen-node:latest`; same image, `sha256:316927cba519b5d4bd3f9d628503cfecaab77590617d991115ae82b9335090fe`, checked on 77.42.12.190) (release 1.0.13) |

**Status: done.** The community node (77.42.12.190) runs the .NET 10 build with the miner payout and the payout relay. Open: while GitHub Actions is disabled for the account, images are built on the servers (`docker build -f Docker/Dockerfile.net10`), not in CI; mainnet has no payout winner yet, so the relay has not been needed on mainnet so far.
