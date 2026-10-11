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

Each V1 contract is loaded in its own load context with its own FSharp.Core; the node talks to
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

## Tests

`src/Consensus.Tests/ContractV1Tests.fs` (needs `ZP_V1_TOOLCHAIN`; skipped otherwise): fork
height, invalid UTF-8, activation and build, cost and result, a valid call validated in context,
a wrong cost commitment, an under-declared cost stopped by gas, reload from disk, weight.
`src/Api.Tests/ContractV1ApiTests.fs`: request parsing (version, rlimit), and end to end: activate
through the wallet API, check the transaction, call the contract through the API.

Run one module: `ZP_V1_TOOLCHAIN=… FSTAR_HOME=… dotnet fsi scripts/run-test-module.fsx
src/Api.Tests/bin/Release Api.Tests.ContractV1ApiTests` (the API tests need liblmdb).
