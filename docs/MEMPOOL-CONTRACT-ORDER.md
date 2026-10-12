# Contract calls that depend on each other in the mempool (fix, 2026-10-12)

Branch `mempool-order-fix`. Node policy only: block validation and consensus are unchanged.

## What went wrong
Two or more calls on one stateful contract waiting in the mempool together, the later built on the state the earlier
one leaves (the wallet runs a call against the mempool state).
1. **Block template (main bug):** `BlockTemplateBuilder.selectOrderedTransactions` checked every transaction against
   the contract states in the database (`ContractStates.asDatabase`), not against the states left by the transactions
   already in the template. Two calls that are each valid alone both went in; block validation, which threads the
   state, refused the second, and the miner retried the same invalid block forever: the chain stops.
   Seen on a devnet: BitZen T4 ("Failed connecting block #429 ... not a valid next Bitcoin header") and the probe
   below ("Failed connecting block #385 ... n is not the next number").
2. **Lost calls:** after each block, `BlockHandler.getMemoryState` re-checked the mempool in hash order (`Map.fold`).
   A call checked before the call it depends on failed and was dropped for good (probe case 3: the third call was
   never mined while the chain went on).
3. **Order in the template:** the template sorted the mempool by weight, which can put a later call before the earlier
   one it was built on; failing calls were dropped instead of tried again.

## The fix
- The template checks each call against `state.contractStates` (the states left by the calls before it).
- The template keeps the mempool's arrival order (`MemPool.toList`), and a call that fails is tried again in the next
  pass (after the calls it may depend on).
- After a block, the mempool is re-checked in arrival order.

## Test (BitZen repo: `contracts/SeqProbe.fst`, `scripts/stall-repro.sh`, on a one-node devnet)
| Node | Case 1 (big first call, then the next) | Case 2 (two chained calls) | Case 3 (three chained calls) |
|---|---|---|---|
| node-upgrade-script | PASS (timing) | PASS | LOST: the third call never mined |
| first fix only (arrival order, retry) | STALL: block #385 refused again and again | | |
| full fix (this branch, ae26d46) | PASS | PASS | PASS |

## Who needs it
- **A node that mines** (or serves block templates to a miner): without fix 1 anyone can stop it with two calls on a
  stateful contract that are each valid alone but not together. Mainnet's only miner is a third party (1.0.13): tell
  its operator; the fix must be in the node release miners run.
- **Any node** (fix 2): keeps such calls in its mempool instead of dropping them.
- The testnet (91.98.3.17) mines: it needs the fix before a BitZen header relayer runs there.
- The mainnet community node (77.42.12.190) does not mine (MINER_THREADS=0): it gets fix 2; fix 1 matters there only
  if someone mines through its block-template API.
