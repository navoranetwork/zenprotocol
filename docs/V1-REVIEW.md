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

