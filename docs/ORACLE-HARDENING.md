# Hardening the oracle before mainnet: a proposal

Status 2026-10-17:
- **(a) is approved by Alon**, as a requirement before any mainnet market. It is scheduled after Sunday's wallet move
  and option A, alongside DPM, and starts with 5 servers we run. Independent members can replace them later through a
  new committee contract.
- **(b) is obsolete** (below).
- **(c) is for later.**
- Nothing is built yet.

Today one key signs each round's commit (the oracle's m/44'/258'/0'/3/0), and every market trusts it. Whoever holds
that key, or breaks into its server, settles every market. That is a larger risk than the choice of pricing
(FPMM, DPM or pool).

## (a) A committee: m of n signers on separate servers

**The recommended design (a2): one commit, signed by m of n, checked by a committee Oracle contract.**

- **The Oracle contract:** a new version, `CommitteeOracle.fst`.
  - Its source holds the n members' compressed keys and m, e.g. 3 of 5. The contract id therefore names the committee.
  - **Commit** takes `{ Commit: Hash, Sigs: list of (index, signature) }`. It checks m distinct indices and
    `Zen.Crypto.verify(key[index], sig, Commit)` for each. Zulib already has it, at 800 gas.
  - Commit mints the commitment token as today, with the subtype computed with member 0's key. **Attest is
    unchanged.**
- **The consumers do not change.** FixedPayout and the new UpDown markets name `OracleContractId` = the committee
  contract and `OraclePubKey` = member 0's key. A commitment token for that pair exists only if m members signed.
- **The proof does not change:** the same leaves, Merkle root and audit path.
- **Rotating a member** means a new committee contract, and new markets name it. That is simplest, and rotations are
  rare. A signed rotation inside the contract is possible later.
- **The off-chain protocol:** the members must sign the *same* root. Their sources answer at slightly different
  moments, so:
  1. A proposer, rotating each round, takes the round's values and sends them to the members.
  2. Each member fetches its own sources and checks every value within a per-ticker tolerance, e.g. 3 × the ticker's
     one-minute σ.
  3. If all agree, the member signs the commit hash and sends the signature back.
  4. The proposer publishes the Commit with m signatures.
  5. If a member disagrees, the round waits for the next proposer within the slot, as the retry does today.
- **Servers:** 5 machines at different providers and in different countries, each with its own keys and its own API
  keys for the sources. No two members share a host or an operator account.
- **Cost:** Commit is about 2,650 + m × 800 + list parsing, so about 5,000–6,000 gas for 3 of 5. That is once per
  round (hourly), so it is negligible.
- **Work:**
  - the contract and its tries: 1½–2 days;
  - the member service (proposal, check, sign, publish): 3–4 days;
  - setting up the 5 servers and the keys: 1 day plus hosting.
  - **About 1 week.**

The variant without a contract change (a1), where each member commits its own root and Settle requires m attestations
of the same root, puts the work in every consumer contract instead. It is not recommended.

## (b) Verifying Pyth's prices in a V1 contract: OBSOLETE (2026-10-17)

**Checked on 2026-10-17: the Wormhole-signed path this section was written for is no longer how Pyth publishes.**
- Pyth's "Core upgrade" cut over on **2026-08-26, 16:00 UTC**.
- Since then, updates are signed by **5 independently operated routers, via Pyth Pro, with a quorum of 3 of 5**
  (secp256k1 ECDSA), not by the 19 Wormhole guardians.
- Pythnet is listed only for the old Pyth Core.
- **Hermes needs an API key** for every caller.

So ZP would not gain prices signed by a large independent network. It would gain a permissioned service of 5 signers,
reachable with a key, which is no stronger than our own 3-of-5 committee (a). **Keccak256 is not to be added to an
image for this.**

Sources:
- [Pyth: how the Core upgrade works](https://docs.pyth.network/price-feeds/core/upgrade/how-it-works)
- [Pyth: completing the Core upgrade](https://docs.pyth.network/price-feeds/core/upgrade/preparing)
- [CryptoSlate on the Hermes migration](https://cryptoslate.com/pyth-networks-api-overhaul-threatens-to-freeze-unpatched-smart-contracts-across-300-defi-protocols/)

The analysis below is kept for the record. It describes the Wormhole path as it was before the upgrade.

### As written before the check

The question: can ZP settle on prices signed by Pyth's large independent network instead of only our own?

**What a Pyth update is.** Hermes serves accumulator updates. Each one is a Wormhole VAA, signed by the guardian set,
over a Merkle root of the price messages of one Pythnet slot. Each price message comes with its Merkle proof, and
carries:
- a feed id (e.g. BTC/USD);
- price and exponent;
- confidence;
- `publish_time`.

**What a contract must check:**
1. The VAA's guardian signatures: a quorum of 13 of the 19 guardians. They sign with secp256k1 over keccak256 of
   keccak256 of the body.
2. That the body is Pyth's Merkle-root message, from Pyth's emitter.
3. The price message's Merkle proof against that root. The proof uses keccak160 (the first 20 bytes of keccak256),
   with leaves prefixed 0x00 and nodes 0x01.
4. The feed id, and `publish_time` against the market's close.

These facts are from Wormhole's core contract and the Pythnet SDK, as of mid-2026. Wormhole's guardian page now also
mentions t-Schnorr for delegated guardians. **Before building, confirm the scheme and the byte layout on a live update
from Hermes**, against pyth-crosschain's `wire.rs`.

**What Zulib has and lacks:**

| Need | In Zulib today | What it takes |
| --- | --- | --- |
| secp256k1 ECDSA verify | yes: `Zen.Crypto.verify`, 800 gas, public key + signature in libsecp's internal form | there is no ecrecover. The 19 guardians' public keys go into the contract, recovered once off-chain from their addresses and any signature. The relayer converts each signature to the internal form. libsecp requires low-s, which the guardians' signatures have. |
| keccak256 | **no**, only SHA3-256 (different padding) | Zen.Hash.Keccak256: the realized Keccak-f already exists (`realized/Sha3.fs`), and only the padding byte differs (0x01 instead of 0x06). **A toolchain change: consensus boundary, the V1 session, a new image.** Keccak written in F* contract code would cost tens of thousands of gas per block of input, too much for a VAA plus a proof. |
| the guardian set changes (rare) | — | a new verifier contract per guardian set; markets name it |

**Cost with a realized Keccak256:**
- 13 × 800 for the signatures, plus about 15 keccak hashes for the body and the proof, plus parsing;
- **about 20,000–40,000 gas per price check**, within a V1 call.

**One open rule: which update settles a market.** Pyth publishes several updates a second. A market would settle on
an update whose `publish_time` is the close second. With two such updates of different prices, the first Settle
wins. The difference is a fraction of a second of movement, but it should be stated in the market rules.

**Work:**
- Keccak256 in the toolchain, by the V1 session: 1 day plus an image cycle;
- the verifier contract (VAA parse, 13 signatures, Merkle proof, price message) with tries on real updates: 4–5 days;
- the Hermes relayer in the bets service: 1 day.
- **About 6–8 days, plus the image.**


## (c) An optimistic oracle for non-price markets (outline only)

For questions with no price feed ("will X happen by date Y").

1. **Propose:** anyone proposes an answer with a bond, e.g. 100 zUSDC.
2. **Dispute window,** e.g. 24 h: anyone may dispute with an equal bond. With no dispute, the answer stands, and the
   proposer gets the bond back plus a fee from the market.
3. **Vote:** a dispute goes to a ZP stake-weighted vote.
   - CGP's weighting is a consensus feature of the node and is not open to contracts.
   - So the voters lock ZP in the vote contract for the voting period (e.g. 48 h), and one locked ZP is one vote.
4. **Outcome:** the side with the majority wins the other side's bond, minus a share for the voters of the majority.
   The market settles on the result. A vote without a quorum makes the market Void.
5. **Risks:**
   - a whale outvotes the truth: the bonds and the voters' locked stake must make that costly;
   - low turnout;
   - questions that can be read two ways: they need a precise wording.

**Work:** contracts (propose, dispute, lock-and-vote, payout) and tries, about 2–3 weeks; the UI is extra. **Not
before the price markets are proven on mainnet.**

## Order (decided 2026-10-17)

1. (a) the committee: after Sunday's wallet move and option A, alongside DPM. It is required before any mainnet
   market. It starts with 5 servers we run.
2. (b) obsolete.
3. (c) later.

Sources:
- [Wormhole: Guardians](https://docs.wormhole.com/protocol/infrastructure/guardians/)
- [Pyth dev forum: new chain integration, data format and validation](https://dev-forum.pyth.network/t/new-chain-integration-data-format-and-validation/191)
