# V1 adversarial review (2026-10-12)

An independent review of the V1 contract path in the node and the toolchain, looking for ways an
attacker or an accident stalls or splits the network. Findings, ranked, with their status. Each
fix lands with a test.

| # | Finding | Severity | Status |
| --- | --- | --- | --- |
| C1 | Work not metered by gas: operations whose time grows with data size run at a fixed price (two equal 20,000-element lists compared 2,000 times: 130,023 gas, 525 ms, 4,036 ns/gas, ~15x normal; the gap grows with size) | critical | fixed in three stages (below); every measured workload within the normal range |
| C2 | Free builds in the mempool: every V1 activation was built (20-30 s) on arrival, before anyone paid; failing variants spending one input could be repeated | critical | fixed (below) |
| C3 | A build that fails for a local reason (disk, memory, offline restore, missing toolchain) rejects the block on that node, permanently: a chain split | critical | fixed (below) |
| C4 | Contract output depending on the machine's locale | — | not applicable: the node runs with invariant globalization (`zen-node.runtimeconfig.json`); hardening of the runtime still useful, low priority |
| H1 | Out-of-memory or thread creation failure during a call treated as the contract failing | high | open |
| H2 | SDK / FSharp.Core not pinned per node; the first FSharp.Core copied is kept for all contracts | high | fixed: pinned in toolchain.lock, checked by every build |
| H3 | Memory grows: every built contract stays loaded, with its own FSharp.Core | high | open; mempool builds removed (C2) took away the unpaid part |
| H4 | No run-time sandbox beyond the elaborator's module allow-list | high | fixed: every built DLL is checked against an allow-list of referenced members (zp-contracts-v1 tools/ilcheck); console, exit and exception catching removed from the runtime |
| H5 | No time limit on a build; slow type-checking not tested | high | fixed: type-level computation forbidden; 10-minute limit counts as an environment failure |
| M1 | Calls validated in the mempool are unpaid (inherited from V0, heavier in V1) | medium | open |
| M2 | Activation cap not applied in the mempool | medium | addressed by C2 |
| M3 | Concurrent builds would share output folders | medium | open (builds are single-threaded today) |
| M4 | A half-copied DLL aborts node start | medium | fixed: written under a temporary name, then renamed |

Checked with no problem found: no build under one contract id is loaded as another (DLL names
are the SHA3 of the source, checked); no injection into the build's project file or command lines;
`maxGasPerCall` and the V1 weight are the same and enforced wherever needed; the size limits cover
every integer and string operation found; the trusted F# compares ordinally, maps case invariantly
and handles byte order explicitly.

## C2: what changed

- The mempool (`TransactionValidation.validateInContextMempool`) checks a V1 activation (fork
  height, source size, UTF-8, sacrifice) but does not build it; the contract is not active in the
  mempool, so calls to it wait in the orphan pool until a block includes the activation.
- V1 source is at most 64 KiB (`maxV1SourceBytes`, draft consensus rule), checked first.
- A source whose build failed is not built again in the same node run (`ContractV1.wasRefused`).
- A block template builds at most two contracts it has not built before; the rest wait.

Remaining exposure: a node building block templates (a miner) can still be made to build up to
two new unpaid sources per template. Relay policy (per-peer limits) or making failed activations
cost something would close it; C3's distinction between "the contract is invalid" and "the build
failed here" comes first.

## C3, H2, H5: what changed

- `build-contract.sh` says why it failed: exit 10 = the contract is refused (checks,
  elaboration, an F* error or internal error on the source, F# compilation of its code), the same
  on every node; exit 20 = the environment (toolchain missing or not the pinned one, restore, too
  little disk, a process killed by a signal). Anything not clearly environmental counts as
  refused, so that no source can stop the nodes that build it. The elaborator returns 10/20 too.
- The toolchain is pinned in zp-contracts-v1 `toolchain.lock` (.NET SDK 10.0.112, FSharp.Core
  10.0.112, F* 2026.09.27): a build with anything else fails as environment. FSharp.Core is
  restored offline from the SDK's own packages; the SDK is held by a global.json. The shared
  FSharp.Core next to the contracts must be byte-identical to the pinned one.
- The node (`ContractV1.compile`): refused -> the activation is invalid (BadContract), and the
  source is remembered as refused; environment -> one retry, then the node stops with a clear
  message (exit 3) instead of rejecting a block other nodes may accept. Never remembered as
  refused.
- The elaborator forbids type-level computation (`normalize_term`, `normalize`, `norm`,
  `assert_norm`, `reveal_opaque`, tactics), so type-check time follows the source size (at most
  64 KiB); a build has 10 minutes, past which it counts as environment.
- DLLs and FSharp.Core are written under a temporary name and renamed.

## C1: plan and what changed

Fixed at compile time, in three stages (each with measurements that show the gap closing):

1. **Equality** (done, zp-contracts-v1 9f81ba4). In code a contract runs, `=` / `<>` are
   Zulib's `Zen.Eq` operators (the elaborator rewrites them and opens `Zen.Eq`), defined only
   for types whose comparison is bounded: numbers, booleans, strings up to 1,024 characters,
   byte arrays up to 64 bytes (hashes, keys), contract ids, assets, locks, spends, outpoints,
   outputs, senders, and options, tuples and refinements of these. Comparing lists, `data`,
   dictionaries or transactions does not type-check: the activation is invalid. An overlong
   value (a lax-built "hash" of 1,000 bytes) fails the call after 64 steps. The attack
   measured above is now refused; the costliest allowed comparison runs at 456 ns/gas, about
   the normal rate.
2. **Zulib functions** (done, zp-contracts-v1 stage 2). Plain functions that walk a value
   (`length`, array indexing, `Wallet.size`, the skeleton's totals, `Asset.zeros`, SHA3
   `absorb`, raw crypto) may not be called by code a contract runs (the cost function may use
   `length` and `Wallet.size`). Priced functions that did more than their price: a transaction
   skeleton has at most 256 inputs and 256 outputs; `isValid` costs 64 + m*m; the SHA3 state
   is a sponge, so `finalize` is constant time (same hashes as V0); array copies walk once;
   fixed-size values longer than their type stop the call. Measured: every workload within
   the normal 100-500 ns/gas on the test machine.
3. **Strings** (done). Strings a contract receives (command, message body, state, dictionary
   keys) have at most 1,024 characters, like those it makes; a longer one fails the call
   before the contract runs. FStar.String's copying functions are replaced by `Zen.String`'s,
   priced by length; the rest take one step on at most 1,024 characters (185-548 ns/gas).

What C1 leaves open: the numbers are from one 2-vCPU machine; the testnet should repeat the
measurement suite (`tests/measure`) on the nodes' real hardware before the limits are final.


## V0 replay with the V1 node (2026-10-12): passed

A node built from v1-contracts (d567f7e) synced mainnet from genesis on the lab server
(zp-lab-1: 8 cores, 15 GB) in about 4 hours, validating and re-compiling every V0 contract,
to block 1,055,090. All 1,053 checkpoint block hashes (one per 1,000 blocks) match the stored
reference of the official 1.0.13 node, and at block 1,055,093 the CGP, total supply and winner
match the live community node. No errors. Report: branch `replay-results`,
`replay/v1-d567f7e1-20261012-1133/`. Changes since d567f7e are in the contract toolchain,
which V0 contracts do not use.

## Lab testnet, three nodes (2026-10-12): passed here

`scripts/lab-testnet-v1.sh` on a 2-core cloud machine: three Debug nodes on the local chain,
V1 fork at block 60. A V1 activation at block 1 does not enter the mempool; after the fork it
makes the contract active on A and B, each building it itself, with byte-identical DLLs
(SHA-256 a36ac9b4...713c for the token template); a call is mined. Then C, which mined its own
chain from genesis, overtakes and joins: A and B switch to C's chain (no activation), the
activation and the call return to A's mempool, are mined again, and all three nodes end on one
tip with the contract active and the call's result in A's wallet.

Found on the way and fixed: a node built the same activation three times (two block templates
and the block, 14 s each, the blockchain actor blocked meanwhile); now built and loaded once.
Seen, not changed (V0 behaviour): a transaction a reorg puts back in the mempool is not relayed
to peers again; only a node that has it can mine it.
Next: the same script on zp-lab-1 (another machine and CPU: the DLL hash must match).

## Byte-identical contract builds on two machines (2026-10-13)

The token template, built by build-contract.sh on zp-lab-1 (AMD EPYC, Microsoft's .NET SDK
10.0.112) and on the cloud workspace (Intel Xeon, Ubuntu's .NET SDK 10.0.112): the same DLL,
SHA-256 c36acbaf...4dde (toolchain c9b085d). Before c9b085d they differed (d5e48cb9 vs 8690181c)
with identical IL: the F# optimization data embedded in each DLL names the source path of the
inlined FSharp.Core code, which differs between the two vendors' FSharp.Core builds. Contract
DLLs no longer carry F# signature or optimization data (nothing compiles against them).
The three-node lab testnet also passed on zp-lab-1 (tests/testnet-d5a8761d-20261012-2118 on
branch replay-results), and BitZen's T5b (a real Bitcoin payment proved in a V1 contract) passed
there (tests/testnet-56a313ad-20261012-2132).

## Open: environment failures that still count as a refusal (found 2026-10-13)

- **E1 (fixed, zp-contracts-v1 944f6d1):** a stale Zulib cache (sources changed after `verify-zulib.sh`)
  made `build-contract.sh` refuse a valid contract (exit 10, `Module ContractEntry.fst was not checked`).
  `verify-zulib.sh` now stamps the cache with the SHA-256 of the Zulib sources; the build checks it (exit 20).
- **E2 (open, after the testnet settles):** after a successful build, `ContractV1.load` failing
  (DLL missing, `FSharp.Core.dll` or `libsecp256k1` missing next to the node) is mapped to `BadContract`
  in `TransactionValidation` like a refusal. These are environment conditions: they should stop the node
  (`onEnvironmentFailure`) instead of rejecting the activation. On a working node the files are always
  present, so the risk is low; fix together with H1, H3, M1, M3.
- Testnet image for the switch at 2011: zp-pow testnet-v1 3dfd394a + toolchain 944f6d1
  (sha256 of the saved image fa06fada…3403); unit tests Consensus 238/0, Blockchain 80/0; lab testnet,
  T5b and T7 passed on that code.

## G1: gas created by a negative charge in lax builds (found and fixed 2026-10-13, before the testnet fork)

Found by the engine session, confirmed here: `autoInc` is `inc (n - m)` with the refinement `m <= n`,
which a lax build (option B) does not check. With `m > n`, `incE` ran the work with `g - k`, `k < 0`:
it *gave* gas. Probe `NegativePadding` built a 2,000,000-element list on a declared cost of 20 and
succeeded. `cf` could also return a negative value (`cast nat` unchecked), which the node took as the
call's cost (a negative weight). Fix in zp-contracts-v1 aec63af (Zulib, consensus): `incE` treats
`k < 0` or `g < 0` as out of gas, `runGas` refuses a negative budget and a gas-left outside
`[0, budget]`, `Zen.Entry` refuses a negative declared cost. Node (ContractV1.fs): a negative declared
cost, or gas used outside `[0, declared]`, is refused whatever the contract's Zulib does. Regression:
`scripts/run-security-test.sh`. Every V1 DLL changed: token template 248da313…332c (was c36acbaf…4dde).
The testnet image is rebuilt with it before the fork at 2050.

## E3: an unreadable toolchain refused contracts (found and fixed 2026-10-14)

Found by the engine service: `zen-node:testnet-v1` run with `--cap-drop ALL` refused the token template
(exit 10, `Module ContractEntry.fst was not checked`). The F* release unpacks with owner uid 1001 and mode
0600: root reads it only through CAP_DAC_OVERRIDE. A node run as another user or with fewer capabilities
would have refused every V1 contract other nodes accept. The public testnet node runs as root with
Docker's default capabilities (smoke test passed), so it was not affected. The elaborator also wrote a
fixed `/tmp/ZpMainTemplate.fst` and mapped `UnauthorizedAccessException` to "refused".
Fix in zp-contracts-v1 c86a2c4 (no DLL change, token template still 248da313...332c, also built as an
unprivileged user): `build-contract.sh` stops as the environment (exit 20) when a checked file of F* or
the Zulib cache is unreadable, or when an F* step fails on unreadable/unwritable checked files (Error 317,
Warning 247, permission denied); `verify-zulib.sh` makes the cache readable by all; the elaborator uses a
private temp folder and maps access errors and a killed F* to exit 20. The image (Dockerfile.testnet-v1)
gives F* and the toolchain root ownership, readable by all. Deploy with the next testnet image.

## Testnet upgrade to toolchain 87b24e2 (2026-10-15)

The public testnet node (91.98.3.17) moved from image f59abc5a (toolchain aec63af) to **zen-node:testnet-v1
sha256:9a4d8bf465780eca45d64988b3d730273005f03b4fb1c0822cfd175f1ee685af** at 08:07 Israel time, block 2389,
without leaving the chain. The image: zp-pow testnet-v1 d47b1c76 + zp-contracts-v1 **87b24e2**; saved as
zen-node-testnet-v1.tar.gz, sha256 fa766d863d2b05eab056413f791987ad1ea1074bcab9030e0c64ce6c37944d1c (676 MB).

What it brings (no change for contracts already active; their DLLs are rebuilt with the same behaviour):
- **Zen.Asset.parse / fromSubtypeString / fromSubtypeInt, Zen.ContractId.parse**, realized after V0's Zulib
  code; **Zen.Hash.Sha3** as V0's subset of Zen.Sha3.Realized (same bytes and costs). Checked against V0's own
  code on 654 inputs (zp-contracts-v1 tests/asset/compare-v0.fsx): 611 identical, 40 different by design (an
  asset string with a 2-62 character subtype: V0 made a hash shorter than 32 bytes that no output can hold, V1
  returns None), 3 V1-only. Contracts that use them (the testnet Dex) now build.
- **Rule 4.9:** code that runs Zen.MerkleTree or Zen.Set (declared, no V1 realization) is refused at the check
  with an explanation, not at extraction.
- 4dd5ad9: the elaborator's 4.5 messages name the top-level let (the engine shows the right line).
- **E3** (c86a2c4, above) is now deployed.
- Node: a **libsecp256k1 self-test at start** (ContractV1.secp256k1SelfTest): the library V1 contracts load
  (/zen/libsecp256k1.so) parses libsecp256k1's own test key to V0's internal form, verifies its signature and
  rejects another message; its sha256 is logged (2889daf9...ac9b). A failure stops the node.
- Token template DLL: a81bccb314d95e65c612dc11521c90e7ffced0a76c9243aa7595102c686c262f (Zen.Asset's extracted
  code changed; DLL bytes are local, not consensus). Image gates: Zulib verifies, token DLL hash, the asset test.

Tests before it: every real-toolchain test of zp-contracts-v1 (elaborator, check with 36 refusals, sha3, crypto,
bitcoin, token, mint, semantics, gas, security, asset, ilcheck, try, service, engine). Lab rehearsal on zp-lab-1
(lab-testnet-v1-rehearsal.sh): the image built and was saved; the rehearsal node, started on its old data
(synced on 2026-10-13 with older images), crashed in the CGP tally ("balance for key ... is 0 and you tried to
remove 4500045200"); the tally code is the same as in f59abc5a, so its stored tallies were stale. With a fresh
volume the same image synced the testnet **from genesis** to the tip (2389), built every active V1 contract
(zUSDC 5ab27aa3... among them) with no error, and the testnet Dex (pow-bitzen contracts/v1/Dex.fst) built in it
(exit 0). Lesson: rehearse an upgrade on a node synced from genesis with the new image, not on old data.

The upgrade on 91.98.3.17: `testnet-v1-switch.sh upgrade /root/zen-node-testnet-v1.tar.gz` (systemd unit
zp-upgrade): checksum, load, the running image kept as **zen-node:testnet-v1-prev** (f59abc5a; back with
`testnet-v1-switch.sh upgrade-rollback`), the node recreated from its compose project (same volume and
environment, MINER_THREADS=0), at block 2389 one minute later; smoke OK (SDK 10.0.112, F* 2026.09.27, Zulib
stamp 1a819900..., token DLL a81bccb3, self-test passed); 10 minutes following: block 2392, no errors.

After it: the engine container is reinstalled from this image (engine session); the engine's testnet pin is
87b24e2 (zp-contracts-v1 bd23cb2); the testnet-migration session runs dex-try and activates the Dex. Still open:
E2 (a ContractV1.load failure maps to BadContract), H1, H3, M1, M3.
