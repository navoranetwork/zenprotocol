# Testnet acceptance: what must run, what must survive, and when mainnet may start

Status 2026-10-17: Alon's rule.
- **Everything is tested and working on the testnet before mainnet.**
- The real committee members are chosen from the testnet results.
- This document is the checklist. Nothing here is built yet; the build order stays: the wallet move (Sunday), option
  A, then DPM and the committee.

## 1. What runs on the testnet exactly as on mainnet

| Part | On the testnet | Difference from mainnet |
| --- | --- | --- |
| **DPM markets** (docs/BETS-DPM.md) | the `UpDownPool` contract, the bets service (1 + 1 opening, settle, void, log), `/bets/markets`, `/bets/quote`, `/bets/positions` | the testnet cap (4,000 zUSDC a pool); zUSDC is the testnet's |
| **The 3-of-5 committee** (docs/ORACLE-HARDENING.md (a)) | the `CommitteeOracle` contract, 5 member processes, each on its own small server (CX33 or similar, at different providers and locations), each with its own ZP node, its own key and its own sources | we run all 5; on mainnet some or all become independent members, through a new committee contract |
| **The price source** (docs/ORACLE-DEX-PRICES.md) | the 15-minute Uniswap v3 TWAP of BTC and ETH in USDC, `observe()` at the last Ethereum mainnet block at or before the close, the median rules, WBTC/cbBTC agreement, after Ethereum finality | read through **RPC providers** for testing, each member a different provider. Full Ethereum nodes only on mainnet. Base and Arbitrum through RPC as on mainnet after the legal review |
| **The wallet flows** | browse markets (Market's chance, pool, cutoff), quote, buy, sell back, positions, Redeem after Settle, Refund after Void, the market rules text | none |
| **The display rules** | `dexPrice` and the "Uniswap TWAP" label for BTC and ETH; no CEX prices on the market pages | the testnet's other tickers (if any) may keep their current sources, labelled "testnet" |

The testnet markets settle on **real Ethereum mainnet prices**, so a testnet result can be checked against what a
mainnet market would have paid.

## 2. The drills

Each drill is run on purpose, at least once, on a live testnet market, and written into its log with the round, the
block, the transactions and the result.

| # | Drill | How | Expected result | Evidence |
| --- | --- | --- | --- | --- |
| 1 | **1 member down** | stop one member's service through a close | the round is signed by the other 4 (3 needed) and committed on time; Settle as usual | the commit's signer indices; Settle tx |
| 2 | **2 members down** | stop two | signed by the remaining 3; Settle as usual | the same |
| 3 | **3 members down** | stop three through a close, keep them down for 24 h | no round for the close; after 24 h Void; every holder's Refund returns exactly the Paid they hold | no commit for the slot; Void tx; Refund txs; pool 0 after all refunds |
| 4 | **One member reports a wrong price** | a member run with a manipulated reader (e.g. +3% on BTC) | the other members refuse its value. If it is the proposer, the round waits for the next proposer and is committed with the right root. If not, it is simply not among the signers | the refusal in the members' logs; the committed value equals the honest TWAP |
| 5 | **Trades after the cutoff** | send Buy and Sell 1 minute after close − 30 min (the wallet's 5-minute margin bypassed) | refused by the contract; nothing moves | the refused txs; pool unchanged |
| 6 | **Member rotation** | activate a new `CommitteeOracle` with one member replaced; new markets name it | new markets settle through the new committee; the old markets, still open, settle through the old one; the removed member can sign neither the new ones nor alone the old ones | both contracts' commits; Settle txs of old and new markets |
| 7 | **An empty winning side** | a market where every bet is on one side and the other side wins (e.g. bet only Up on a line far above the price) | no winning shares; Refund pays every Paid back; Redeem is refused | Settle; Refund txs; refused Redeem |
| 8 | **A node restart mid-round** | restart a member's ZP node, then its service, between the proposal and the commit; once with the proposer itself | the round is still committed within its slot (by the next proposer if needed), with the same root; no duplicate commit | the commit; the members' logs |
| 9 | **RPC failure or disagreement** | point one member at a failing RPC, and another at an RPC that returns a different block | those members do not sign; the rest commit if 3 agree; a member never signs a value read at a block other than the agreed one | the logs; the commit |
| 10 | **A late or reordered transaction** | a Buy built on a quote, mined after another Buy moved the pool | refused by MinShares; nothing moves | the refused tx |
| 11 | **The bets service down** | stop it for 2 hours over a close | the markets settle anyway: anyone can send Settle with the committed round; the service catches up on restart without double-sending | Settle by hand, then the service's log |

## 3. The exit criteria for mainnet

All of these, recorded in this document with dates and links to the logs:

1. **At least 30 consecutive markets settled correctly.** For each one:
   - the committed value equals an independent recomputation of the TWAP from Ethereum at the same block;
   - the winner follows the rule;
   - every Redeem and Refund was paid;
   - no manual fix was needed.
   - A failed market restarts the count.
2. **Every drill in section 2 passed.** A drill that fails is fixed and run again, and the 30-market count restarts if
   the fix touched the contract or the committee.
3. **The log shows the contract never paid more than it held**, for every market:
   - redeems + refunds + dust = the pool;
   - `pool² ≥ qUp² + qDown²` after every trade;
   - Paid outstanding = pool until Settle.
   - The script that checks this is part of the deliverable.
4. **The outside review of the contracts** (`UpDownPool`, `CommitteeOracle`) is done, and its findings are fixed or
   accepted in writing.
5. **The legal opinion is done** (docs/ORACLE-SOURCES-TERMS.md, the lawyer's list), including the markets' status,
   the price sources, the RPC and node setup, and publishing the market's chance.
6. **The wallet flows have been used by someone other than us** on the testnet (at least a few people), and their
   problems are fixed.

## After this

1. **Alon chooses the mainnet committee members** from the testnet results: who ran reliably, at which providers.
2. The mainnet `CommitteeOracle` names them.
3. Each member sets up its dedicated Ethereum server a week ahead, for the first sync.
