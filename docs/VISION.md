# Vision: ZP as a neutral layer that needs no trusted operator

Status: agreed by Alon, 2026-10-17. **This is the reference for every design decision.** A proposal that adds a trusted
party must say so, say why it is a temporary step, and name what replaces it.

## The goal

ZP is a neutral settlement layer that verifies Bitcoin and Ethereum by itself. Prices, money and markets on ZP need no
trust in any operator, including the project's own founder, operators and services. There is no time pressure: it is
built right, in stages, with every stage tested on the testnet first.

## Principles

1. **No trusted operator in the end state.** Whatever a user relies on (a price, a balance, a payout) is checked by a
   contract against data it can verify: ZP's own chain, Bitcoin headers (BitZen), Ethereum headers (EthZen).
   A key held by a person or a service is acceptable only as a temporary, documented step, and never decides a result
   on its own.
2. **Anyone can check.** Every price, settlement and payout can be recomputed by anyone from public data. The site
   shows the evidence, not just the result.
3. **Users sign everything themselves.** The site never touches keys; the wallet checks every transaction before
   signing (build-and-compare, expect checks).
4. **No capital at risk by design.** Markets do not depend on a market maker or a seeded reserve (DPM), so nobody has
   to fund or can drain liquidity.
5. **Testnet first, always.** Every component runs on the testnet exactly as it would on mainnet and passes its
   acceptance drills ([TESTNET-ACCEPTANCE.md](TESTNET-ACCEPTANCE.md)) before mainnet.
6. **Clean data and clean money.** Only sources whose terms allow publishing; no new token sold to the public; the
   project is funded through the CGP, per milestone.

## The limit no design removes

A bridge or an oracle on a proof-of-work chain is never safer than that chain
([BRIDGE-TRUSTLESS.md](BRIDGE-TRUSTLESS.md), finding 3). Whatever verifies ZP, a result can be faked by rewriting ZP
blocks, so the value at stake must stay below the cost of rewriting the confirmation depth required. ZP's hashrate is
small today, and RandomX hashrate can be rented. Therefore:
- limits per withdrawal, per day and on total reserves stay in every stage, not only the first;
- the size of markets and of the bridge grows with ZP's hashrate, not ahead of it;
- growing the mining base (more independent miners) is part of the security plan, not only of decentralisation.

## The end state

| Layer | End state | Trust | Reference |
| --- | --- | --- | --- |
| Prices | The contract verifies the 15-minute Uniswap TWAP against Ethereum itself (EthZen) | Ethereum's sync committee, maths | [ETHZEN.md](ETHZEN.md), [ORACLE-DEX-PRICES.md](ORACLE-DEX-PRICES.md) |
| Deposits (USDC → zUSDC) | A ZP contract verifies the lock on Ethereum L1 through the same light client | Ethereum's sync committee | [BRIDGE-TRUSTLESS.md](BRIDGE-TRUSTLESS.md) §1 |
| Withdrawals (zUSDC → USDC) | An EVM contract follows ZP headers (SHA3 proof of work: SPV; RandomX: an optimistic relay with bonded watchers) | ZP's proof of work, one honest watcher | [BRIDGE-TRUSTLESS.md](BRIDGE-TRUSTLESS.md) §2 (**open research**) |
| Bitcoin | BitZen: Bitcoin headers in a ZP contract, swaps without an intermediary | Bitcoin's proof of work | [BITZEN-TESTNET.md](BITZEN-TESTNET.md) |
| Markets | DPM: no market maker, no seed, winners never lose; fees split to relayers, operator and CGP | The contract | [BETS-DPM.md](BETS-DPM.md) |
| Experience | Site shows markets and evidence; wallet signs; USDC in one flow | The user | site mockup, [WALLET.md](WALLET.md) |
| Funding | CGP grants per milestone; fees | Public on the chain | [BETS-DPM.md](BETS-DPM.md) (fees, CGP rule) |

With EthZen, proofs can be relayed by anyone, so the oracle committee is not part of the end state. The committee's
fee share becomes a reward for whoever relays the proofs (to be redesigned when EthZen is built).

## Interim steps (scaffolding, each with what replaces it)

| Interim step | Trusted party | Replaced by |
| --- | --- | --- |
| The single oracle key (today) | the operator | the committee (testnet), then EthZen |
| 3-of-5 oracle committee, Uniswap via RPC | m of n members, the RPC providers | EthZen |
| Custodial bridge with one key (today) | the operator | an M-of-N bridge committee with limits, pause and timelocks, then the light clients |
| CEX prices on the testnet | the exchanges (and their terms) | Uniswap TWAP, then EthZen |

## Roadmap

| Phase | Content | Trust level |
| --- | --- | --- |
| 1. Testnet now | wallet migration to fresh keys; option A; DPM; oracle committee and Uniswap via RPC; site and wallet flows | scaffolding |
| 2. Research | EthZen (assessed); trustless withdrawals (SHA3 SPV is feasible; RandomX dispute game is open research); confirmation depths and limits from ZP's hashrate | — |
| 3. Library and fork | Keccak256, general SHA-256, BLS12-381, an MPT verifier in Zulib; a node image; lab replay and timing; a fork | — |
| 4. EthZen on the testnet | prices verified against Ethereum; trustless deposits; the acceptance drills again | Ethereum only |
| 5. Trustless withdrawals on the testnet | per phase 2's result; limits sized to hashrate | ZP's proof of work |
| 6. Mainnet | markets and bridge, sized to ZP's security; outside reviews; legal opinion; CGP grants per milestone | no operator |

## Open questions

1. **Withdrawals with RandomX.** The EVM cannot check a RandomX hash. An optimistic relay where RandomX is checked only
   in a dispute has no known implementation. Is mainnet staying on SHA3 proof of work for the bridge's sake an option,
   or is the dispute game built? (V1 session, research.)
2. **Security budget.** How much value can markets and the bridge hold for a given ZP hashrate and confirmation depth?
   A formula and a live figure on the site.
3. **Relayer incentives with EthZen.** Who relays sync-committee updates (~every 27 h) and proofs, and how they are
   paid from fees.
4. **Legal.** The open items in [ORACLE-SOURCES-TERMS.md](ORACLE-SOURCES-TERMS.md), including the markets' status and
   the fee.
