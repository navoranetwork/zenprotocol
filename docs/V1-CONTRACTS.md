# V1 contracts in the node

V1 contracts are written in current F* with the V1 contract library
([navoranetwork/zp-contracts-v1](https://github.com/navoranetwork/zp-contracts-v1), `docs/V1-SPEC.md`).
V0 contracts are unchanged.

## Activation

A transaction activates a V1 contract with `contract = HighV (1, source)`, where `source` is the
contract's F* source as canonical UTF-8 (no module line). The contract ID is
`(1, SHA3-256(BE32(1) ‖ source))`. Activation is accepted from `v1ContractsHeight`
(`Chain.ChainParameters`): local chain 1; testnet and mainnet not set yet (`UInt32.MaxValue`),
to be set by the upgrade vote. Sacrifice and extension work as for V0. Activation weight: draft
10,000 per source byte.

## Building

The node builds the contract with the V1 toolchain (`scripts/build-contract.sh --lax`: the
contract rules, cost elaboration and F* type checking, without Z3) into `<contracts>/v1/`, next
to the FSharp.Core the contracts use. The toolchain is a checkout of zp-contracts-v1 with Zulib
verified (`scripts/verify-zulib.sh`):

- `ZP_V1_TOOLCHAIN`: the checkout (default: `contract-tool-v1` next to the node);
- `FSTAR_HOME`: the pinned F* (default: `fstar/` inside the toolchain).

## Running

Each V1 contract is loaded in its own load context with its own FSharp.Core (the build copies it
next to the contract; a contract without it is refused at load); the context is kept alive with
the contract, and ZenAbi in it is always the node's own copy (version 1.0.0.0). The node talks to
it only through ZenAbi (`src/ZenAbi`, vendored from zp-contracts-v1 `abi/`, keep identical).
`Consensus/ContractV1.fs` converts between node types and ZenAbi and gives the contract the same
main/cost functions as V0, so call validation (`InputValidation/ContractV0.fs`) is shared:
cost commitment, state commitment, prefix and mask checks. On top of that, the V1 rule
(`ZenAbi.Rules.Rejection`): a call fails when it runs out of gas (main runs with exactly the
declared cost as budget), declares more than `MaxGasPerCall`, or overflows an asset total.

## Wallet and API

`POST /wallet/contract/activate` with `"version": 1` activates a V1 contract from the node's wallet:

```json
{ "code": "<F* source>", "numberOfBlocks": 100, "password": "…", "version": 1 }
```

The wallet builds `HighV (1, UTF-8 source)` with the sacrifice (`sacrificePerByteBlock` × source
length × blocks, as V0) and a fee equal to the activation weight, signs and publishes it; the
node builds the contract when it validates the transaction. The response is the same as for V0
(`address`, `contractId`, `txHash`, `numberOfBlocks`). Without `version` (or with 0) the request
is the V0 activation; `rlimit` applies to V0 only. Extension (`/wallet/contract/extend`) and calls
(`/wallet/contract/execute`, `/blockchain/contract/execute`) take a V1 contract's address like
any other contract. In code: `Messaging.Services.Wallet.activateContractV1`.

From a request to an active contract: the contract engine in zp-contracts-v1
(`tools/engine/zp-engine`, docs/ENGINE.md) makes or verifies a contract (check, test, proof),
then `zp-engine publish` sends it to this API from the author's own node, and `zp-engine call`
calls it. The signing stays in the author's node wallet.

## Trying it on a local node

A Debug node runs the local chain (`--local 0`, genesis paid to the test wallet, V1 from block 1).
`ZP_NODE_V1_ONLY=1` (Debug builds only) starts it without the V0 tooling (Z3, Mono, the contract
tool); such a node cannot activate V0 contracts. `scripts/v1-local-e2e.sh` does the whole path
on a real node: start it with its miner, import the wallet, `zp-engine make token`, `publish
--wait`, `call buy` with 500 ZP, and check that the wallet holds 500 of the contract's token.
It runs outside the test runner on purpose: the runner's host has FSharp.Core 10 and resolves
assemblies for the contract, which once hid three loading bugs that only a node shows.

## Tests

`src/Consensus.Tests/ContractV1Tests.fs` (needs `ZP_V1_TOOLCHAIN`; skipped otherwise): fork
height, invalid UTF-8, activation and build, cost and result, a valid call validated in context,
a wrong cost commitment, an under-declared cost stopped by gas, reload from disk, weight; and
loading: ZenAbi's version, FSharp.Core next to the contract, a relative contracts path, a call
after garbage collections.
`src/Api.Tests/ContractV1ApiTests.fs`: request parsing (version, rlimit), and end to end: activate
through the wallet API, check the transaction, call the contract through the API.

Run one module: `ZP_V1_TOOLCHAIN=… FSTAR_HOME=… dotnet fsi scripts/run-test-module.fsx
src/Api.Tests/bin/Release Api.Tests.ContractV1ApiTests` (the API tests need liblmdb).
