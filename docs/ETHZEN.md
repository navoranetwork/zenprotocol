# EthZen: an Ethereum light client on ZP, so a close's Uniswap TWAP is verified by the contract itself

Status 2026-10-17: a long-term proposal, after DPM and the committee. **Nothing is built.**

Today the committee (docs/ORACLE-HARDENING.md (a)) reads the TWAP from Ethereum and signs it, and the markets trust 3 of
5 signatures. EthZen would let a ZP contract check the TWAP against Ethereum's own consensus, as BitZen checks Bitcoin
headers. Then the committee is needed only to relay, and anyone could relay.

## What the contract must verify

From Ethereum's consensus down to one storage slot:

1. **The beacon chain, via the sync committee** (the Altair light-client protocol).
   - 512 validators, rotated every 256 epochs (about 27 hours), sign each block's header with BLS12-381 aggregate
     signatures.
   - A `LightClientUpdate` carries an attested header, the finalized header with its SSZ Merkle branch, the sync
     aggregate (a 512-bit participation field and one 96-byte G2 signature), and, once per period, the next
     committee with its branch.
   - **The check:**
     - more than 2/3 of the 512 took part;
     - the signing root is right: SSZ `hash_tree_root` (SHA-256) of the header, with the fork's domain;
     - `e(aggregate of the participants' public keys, H(signing root)) == e(g1, signature)`, where H is the
       hash-to-G2 of the BLS spec.
   - The contract keeps the current and the next committee's key-set root, as records, the way BitZen keeps headers.
2. **The execution state root:**
   - The finalized beacon header's `LightClientHeader` (Capella and later) carries the execution payload header and
     its SSZ branch, so it gives the execution `state_root` and block number.
   - The contract stores each verified state root as a record.
3. **The pool's storage:**
   - An `eth_getProof` account proof for the pool's address against the state root: Merkle-Patricia trie nodes in
     RLP, keyed by keccak256.
   - That gives the pool's storage root.
   - Then storage proofs for `slot0` (the current observation index and cardinality) and for the 2–4 `observations[i]`
     slots that bracket the TWAP window: the close, and the close minus 15 minutes.
4. **The TWAP:**
   - Read from the packed observation: `blockTimestamp` (uint32), `tickCumulative` (int56) and
     `secondsPerLiquidityCumulativeX128`, with linear interpolation between the two observations that bracket each
     end, as Uniswap's `observe()` does.
   - `tick = Δ tickCumulative / Δt`.
   - **No exponent in the contract:** the market stores its line as a tick (`lineTick`, computed off-chain, checkable
     by anyone), and the contract compares `tick ≥ lineTick`. The price in dollars is only for display.

## What Zulib has and lacks

| Need | In Zulib / the toolchain today | What it takes |
| --- | --- | --- |
| secp256k1 ECDSA | yes | — (not needed here) |
| SHA3-256 | yes (`Zen.Hash.Sha3`, realized Keccak-f) | — |
| **Keccak256** (MPT keys and nodes) | **no** | the padding byte 0x01 instead of 0x06 on the existing realized Keccak-f. Small, but a consensus change: the V1 session, a new image |
| **SHA-256** (SSZ hashing of beacon headers and branches) | only inside `Zen.Bitcoin.computeHeaderHash` (double SHA-256 of 80 bytes), not as a general hash | `Zen.Hash.Sha256` on arbitrary bytes, realized (the .NET SHA-256). Small, the same consensus change |
| **BLS12-381** (G1 decompression and addition, subgroup checks, hash-to-G2, a 2-pairing check) | **no** | a realized `Zen.Bls.verifyAggregate(pubkeys, bitfield, message, signature)`, or smaller pieces, wrapping a native library such as **blst** in the node. **The largest change:** a native dependency in every node, its build in the image, and costs measured as `docs/MEASUREMENTS.md` does |
| RLP and Merkle-Patricia proofs | no | **either** in contract code (F*), which is costly per byte and adds a lot of proof-handling code, **or** a realized `Zen.Ethereum.verifyStorageProof(stateRoot, address, slot, proof)`, much cheaper and simpler for contracts, at the price of more consensus code |
| int56 and uint160 arithmetic, interpolation | U64 only, plus `Zen.Integers` conversions | signed 56-bit within an int64 is fine; the 160-bit field is not needed for the tick TWAP (only for liquidity), so it can be skipped |

So EthZen needs **a toolchain release with new realized functions** at least Keccak256, SHA-256 and BLS12-381 (and
preferably an MPT verifier).
- That release goes into a new node image, with every node upgraded.
- It is a consensus change: the V1 session owns it, and it needs a fork height.

## Cost per verification (estimates; to measure as MEASUREMENTS.md does)

The current per-call cap is `maxGasPerCall` 1,000,000 (draft), and a call weighs 400 per gas.
- **A header update** (once per period, about 27 h, plus each finalized header we need):
  - SSZ branches: about 20 SHA-256;
  - hash-to-G2 and one pairing check, realized: a few ms of CPU, so of the order of 30,000–80,000 gas at today's
    ~40–70 ns per gas;
  - the participants' keys: 512 × 48 bytes = 24 KB of body. Parsing that in F* is the costly part. Better to
    aggregate in the realized function from the key set, verified once per period against the stored root.
  - **Total: of the order of 100,000–300,000 gas.** It fits one call.
- **A TWAP proof** against a stored state root:
  - the account proof: about 8–10 trie nodes, about 5 KB;
  - 3–5 storage proofs, of similar size each;
  - with a realized MPT verifier: about 20,000–50,000 gas;
  - in F* code: several hundred thousand, near the cap, so it would need splitting into several calls.
- **Per market close:** one header for the close's finalized block, plus the TWAP proofs of the pools we use (2–4
  pools). **Roughly 300,000–600,000 gas in 3–5 calls,** each well within a block (8,000 M weight).

## The relayer

- **Anyone can relay:** a service that follows the beacon chain (the light-client API of a beacon node, or Helios),
  and at each close:
  1. waits for finality;
  2. sends the header update (or the period's committee update first, if due);
  3. fetches `eth_getProof` for each pool at that block, and sends the TWAP proofs;
  4. sends Settle.
- **It needs an Ethereum node, or a beacon and execution RPC.** The committee members' Ethereum nodes are the natural
  relayers, and the markets no longer depend on their honesty, only on someone relaying.
- **Liveness:** a market still voids after 24 h without a verified round.
- **Bootstrapping:** the contract starts from a trusted sync committee at a checkpoint, written into its source. That
  is the one trusted input, and it is public and checkable.

## Risks and limits

- **Sync-committee security is weaker than full Ethereum consensus.** A corrupt 2/3 of 512 validators could sign a
  false header. That is a well-studied risk, accepted by most light clients and bridges, and far stronger than 3 of 5
  of our own.
- Ethereum forks change the light-client containers and domains. The contract needs a new version, or data-driven
  fork parameters, at each Ethereum fork that touches them.
- **Pools only on Ethereum mainnet:** Base and Arbitrum need their own proof systems, the L2 output roots on L1, and
  are much more work. EthZen would settle on Ethereum pools alone.
- **The consensus change is the main cost:** native BLS in every ZP node, audited and measured.

## Work, roughly

| Part | Who | Estimate |
| --- | --- | --- |
| Realized Keccak256 and SHA-256 | V1 session | 2–3 days with tests against known vectors |
| Realized BLS12-381 (blst binding, hash-to-G2, aggregate verify), costs measured | V1 session | 2–3 weeks |
| Realized MPT storage-proof verifier (recommended) | V1 session | 1 week |
| Image, fork height, rollout | V1 and testnet | 1 week plus the testnet period |
| The EthZen contract (sync-committee updates, header records, TWAP proof, interpolation, `lineTick`), tries on real mainnet data | contract side | 2–3 weeks |
| The relayer | service side | 1 week |
| Outside review (consensus code and contract) | outside | — |
| **Total** | | **about 2–3 months of work, plus review and a fork** |

## Recommendation

- Keep the committee (approved) for mainnet now.
- Consider EthZen after DPM has run on mainnet and the volume justifies a consensus change.
- If it goes ahead:
  1. Start with the small realized hashes (Keccak256, SHA-256).
  2. Then BLS, measured on the lab.
  3. The committee then becomes the relayer.
