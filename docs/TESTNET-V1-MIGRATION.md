# Moving the testnet's contracts (oracle, USDC bridge, Dex) to V1: handoff

Written 2026-10-13, the evening before the testnet's V1 fork, so that a new working session can take this over.
Update the "State" sections when something changes. Everything here is about the **testnet**; nothing holds real money.

## How to work with Alon (keep these rules)

- Answer in Hebrew, short and direct. Documents, code, commit messages and messages to other sessions in English.
- For every command, say on which server it runs (testnet server `91.98.3.17`, mainnet server `77.42.12.190`,
  lab `zp-lab-1`).
- Whenever you set a limit or a timeout (a job time limit, a waiting period), also schedule a check before it ends.
- Ask before anything that touches mainnet or real funds.
- The working sandbox cannot reach the servers: Alon runs the commands and pastes the output. Give one block of
  commands at a time; a `read -s` for a secret goes alone on its line (pasting several lines at once feeds the next
  line into it).
- Never `docker compose down -v`; never `--remove-orphans` with the node compose file.
- Other sessions: "the lab" / "V1 session" (zp-contracts-v1, node builds on zp-lab-1) and "the engine session"
  (contract engine). Alon relays messages; write them in English, ready to paste.

## Decision

Move the testnet's own V0 contracts (oracle, zUSDC bridge token, Dex) to V1, but only after the V1 fork (block 2050,
night of 2026-10-13/14) has run stable for a few days and BitZen runs on it. One change at a time: if something breaks
right after the fork, it must be V1, not these contracts. Mainnet's V0 contracts (CGP, Dex, FixedPayout) stay as they
are until a community vote decides otherwise.

Why move at all: V0 contracts cannot be fixed (the 2018 toolchain is frozen), activating a V0 contract blocked the
node's API for 35 minutes on 2026-10-12, V1 has gas that stops any run at its declared cost, and the vote may close
V0 activations after the fork. It is also the rehearsal for moving a live contract with holders on mainnet.

## State of the bridge today (2026-10-13)

- Service: `site/bridge/bridge.mjs` (zenprotocol, branch `node-upgrade-script`), docs `docs/BRIDGE.md`.
  Compose service `bridge` in `~/zenprotocol-testnet/docker-compose.testnet-stack.yml` on 91.98.3.17
  (image `zen-tools`, host network, API on 127.0.0.1:8090). Settings in `~/zenprotocol-testnet/testnet-stack.env`:
  `BRIDGE_CONTRACT` (ctzn1…), `BRIDGE_ASSET` (contract id hex = the zUSDC asset), `BRIDGE_EVM` (Base Sepolia RPC),
  `BRIDGE_EVM_KEY`, `BRIDGE_FUNDERS`.
- State files in the docker volume `zenprotocol-testnet_bridge-data` (`/data` in the container): `links.json`
  (EVM address → ZP address), `done.json` (deposits issued, withdrawals paid, keys `<evmtx>:<log>` and `w:<zptx>`),
  `pending.json` (deposits waiting for a link). Back these up before any change.
- Contract: V0 `src/ContractExamples/AuthenticatedSupply.fst`, activated by `scripts/install-testnet-stack.sh` with
  the node wallet's public key at sign path `m/44'/258'/0'/3/0` written into `authenticatedPubKey`. Commands:
  `Issue` (Amount, returnAddress; only that key) and `Destroy` (Amount; only that key). The bridge calls them through
  the node wallet (`/wallet/contract/execute`), building message bodies with `zen-oracle body`.
- Flow: deposit of USDC on Base Sepolia from a linked EVM address → after 12 confirmations `Issue` to the linked ZP
  address. Withdrawal: the user pays zUSDC to the bridge's ZP address and posts `/withdraw {zpTx, evm}` → the bridge
  checks the payer is the linked ZP address, calls `Destroy`, sends USDC. Transfers from `BRIDGE_FUNDERS`
  (Alon's funding address `0xd0c6337e19247373d97a927f50aecc404d51b9db`) top up reserves and issue nothing.
- Numbers on 2026-10-13: 115 USDC held on Base Sepolia, 105 zUSDC outstanding, 2 links, 2 deposits, 1 withdrawal.
- **Closed 2026-10-14.** The services `bridge` and `marketmaker` were stopped (`docker compose stop`, not removed),
  and all 115 test USDC were sent back from the bridge's EVM key to Alon's funding address `0xd0c6…b9db`
  (Base Sepolia tx `0x4ca5ef3d5f6e2d638d8234ad07ff023a9e66467ae058e8e49525cac3a10cc3ed`). The 105 zUSDC still out
  (95.1 in the node wallet, the rest elsewhere) are no longer backed: test tokens with no value, left as they are.
  The V1 bridge starts with empty reserves and its own token; nothing carries over. Do not restart the old `bridge`
  service (it would accept withdrawals it can no longer pay); the market maker's zUSDC orders on the V0 Dex stay
  until the Dex moves.
- Site: `/bridge.html` (live updates over SSE `/bridge/events`), nginx routes `/bridge/status`, `/bridge/lookup`,
  `/bridge/link`, `/bridge/withdraw`, `/bridge/events` (set by `site/setup-testnet-web.sh`). The site is published
  from `~/zp-pow-bitzen` on 91.98.3.17: `cd ~/zp-pow-bitzen && git pull -q && STACK_PROJECT=zenprotocol-testnet bash site/setup-testnet-web.sh`.
- Other users of the zUSDC asset id: the market maker (`site/marketmaker/maker.mjs`, `MM_ASSET`) places zUSDC orders
  on the V0 Dex (`src/ContractExamples/Dex.fst`); the wallet and explorer name the asset from `assets.json` /
  `site/contract-names.json`; the bridge page shows zUSDC outstanding.

## State of V1 on the testnet

- Fork: V1 contracts from block 2050; longer CGP phases from interval 22 (block 2101): snapshot 70, nominations
  71-80, voting 81-100.
- Node image: `zen-node:testnet-v1`, image id `sha256:f59abc5ad731022ab2d6e5719d9d2d5cefcdfcaec291d853233efe15a50f6009`
  (zp-pow `testnet-v1` 11df57fe, zp-contracts-v1 toolchain aec63af with the gas fix). `bash /root/testnet-v1-switch.sh status`
  on 91.98.3.17 shows what runs. **Do not activate any V1 contract on a node without this build.**
- **Done 2026-10-14.** zp-switch installed the image at block 2011 (21:41 UTC); smoke test OK (SDK 10.0.112,
  F* 2026.09.27, token template 248da313…332c). The fork at 2050 and the CGP-phase change at 2101 passed with no
  errors; the lab's second node (zp-rehearsal) follows the same tip. zp-switch shows "failed" only because its last
  log grep found nothing (fixed in the script). Rollback image `zen-node:testnet-pre-v1` is kept.
- `/root/zenprotocol-testnet/.env` pinned the node to the old image (`zen-node:testnet-randomx-bitzen`); set to
  `ZEN_TESTNET_IMAGE=zen-node:testnet-v1` (old file `.env.bak`). Any `docker compose up` of the node now keeps V1.
  The node container `zen-testnet` shows as an "orphan" of the stack project: **never `--remove-orphans`**.
- The server has no Node.js: run scripts with `docker run --rm --network host -v "$PWD":/b -w /b node:22-alpine node …`.
- First V1 contracts on the testnet (2026-10-14, `bitzen/scripts/testnet-v1-deploy.mjs`, run as above):
  - BitZenChain `000000012381250f80f6501d4d09bde5a7a37720d9bed556e2f0bb21387591682d7b07a8`,
    `ctzn1qqqqqqqfrsyjslq8k2qw56zdaukn6xaeqmxld24hz7zajzwr4j95z67c84qr80uy7`
  - BitZenSwap `00000001e1c6b091bcffdee607f1ef0ba5422b4bbf325f8c070c6166a87085a0544a7726`,
    `ctzn1qqqqqqq0pc6cfr08lmmnq0u00pwj5y26thue9lrq8p3skd2rssks9gjnhycfzmf97` (init tx 349a5967…ab1e)
  - 20,000 blocks each. `testnet-stack.env` has `BITZEN_CONTRACT`/`PROVER_CHAIN` (the chain), `BITZEN_BATCH=6`,
    `PROVER_SWAP` (old file `testnet-stack.env.bak-v0`). Relayer reset; first checkpoint Bitcoin block 971,346.
    Prover on 127.0.0.1:8096; `https://testnet.navora.network/swap/status` answers.
  - 2026-10-14 11:30: BitZenSwap replaced (holds 20/30/60 blocks, 10-block take-back lock; `docs/BITZEN-TESTNET.md`):
    `000000015841b86a8cbf153edc849e3abc9109457794177f50573f90ef2c06548ad60e20`,
    `ctzn1qqqqqqqq2cgxux4r9lz5ldepy7827fzz29w72pwl6s2ulepmevqe2g44swyqsrfgrk` (`PROVER_SWAP`). The chain contract and
    relayer were kept. The first swap (`…0544a7726`) still holds a 150 ZP test offer, no longer seen by the wallet.
- Writing V1 contracts (lessons from BitZen): no list literals (`[]` → `Nil`, cons is fine); `exists` is a keyword;
  qualify `Zen.Prelude.OK/ERR`; annotate equality as `(a = b <: bool)`; the costliest branch first in an `if`, the
  others padded with `autoInc`; the cost function must equal main's elaborated cost (the F* error shows `(N + 19)`);
  `build-contract.sh` takes the source without a `module` line. Contract id = SHA3-256(BE32(1) ‖ UTF-8 source).
- The contract engine (zp-contracts-v1 branch `engine-check`, `docs/ENGINE.md`, `docs/SERVICE.md`) has families
  token, timelock-vault, swap, escrow. None is an authenticated-supply token yet: ask the engine session for an
  "authenticated supply" family, or write it by hand.
- The ZP Wallet can activate a V1 contract signed in the browser (`wallet/src/wallet.js` `prepareActivateV1`), and
  calls contracts with a PK sender (`prepareSignedCall`). The bridge itself signs through the node wallet.

## Plan (simple path: the testnet has no users but Alon)

Only Alon uses the testnet, so there are no holders to protect and no transition period is needed: no parallel
contracts for weeks, no migration endpoint. Order: oracle, then bridge, then Dex, each after the previous one works.
The old V0 contracts stay on the chain until they expire; nothing calls them any more.

### 1. Oracle (no funds held)

**Done 2026-10-14.** `contracts/v1/Oracle.fst` (the V0 contract, same commands, bodies, errors and token
derivations; FeeAsset only "00" until Zulib V1 realizes `Zen.Asset.parse`). Tested with
`scripts/v1/oracle-try.mjs` against the engine service on 91.98.3.17: accepted, 44 checks passed, costs as V0
(Commit 2650; Attest 5081 + 128 per coin in the contract's wallet). Activated with
`scripts/v1/testnet-v1-oracle.mjs activate` (20,000 blocks, expires at block 22,233):
`00000001cbcf4ef46cab8303e10d994d06b1820c348e276a7be9edfc7653fefbb9acd741`,
`ctzn1qqqqqqqwtea80gm9tsvp7zrvef5rtrqsvxj8zw6nma8klcajnlmamntxhgyclqt8k`. `testnet-stack.env` updated
(`ORACLE_CONTRACT`, `ORACLE_ID`, `ORACLE_ADDRESS`; old file `testnet-stack.env.bak-oracle-v0`), oracle service
recreated; first round committed (tx 8824ac66…ca43) and a real Attest of it accepted (tx 6a1a11c4…7960, by
`testnet-v1-oracle.mjs attest`). The V0 Oracle (`ctzn1qqqqqqqzzfsly8h…`) gets no more rounds and expires by itself.
Attest grows 128 gas per round committed: about 7,700 rounds (about 320 days hourly) fit under the 1,000,000 gas per
call; replace the contract before that. Lessons: keep V0's expression shapes (the `val`s carry exact costs);
`Zen.Hash.Sha3` and `Zen.Asset.parse` have no V1 realization (use `Zen.Sha3`).


- Port `src/ContractExamples/Oracle.fst` to V1 (same commands and message formats), test (ZenAbi harness, then lab
  devnet), activate on the testnet with the node wallet.
- Point the oracle service at it (`ORACLE_CONTRACT` in `testnet-stack.env`), and every consumer: the FixedPayout
  contract and its pages, the Markets data, the site's `contract-names.json`.
- Check: a new round committed, `/oracle/rounds/latest` and the Markets tab show it.

### 2. USDC bridge (zUSDC)

**Active since 2026-10-15 02:06 (Israel time).** `scripts/v1/crypto-probe.mjs` showed through the node that V1
`parsePublicKey` / `Crypto.verify` work (the node loads `/zen/libsecp256k1.so` for V1 contracts; only the engine's
runner missed it, fixed in engine ff5ddc9). `scripts/v1/zusdc-try.mjs` on the engine: all passed. Destroy now refuses
more than the call brings in ("Destroy Amount is more than was sent", engine finding; V0 left it to the node's balance
check), so Destroy costs 454 (V0 381); Issue 529. Activated by `FORCE=1 scripts/v1/testnet-v1-zusdc.mjs` (bridge key
`m/44'/258'/0'/3/0`, 20,000 blocks, expires at block 22,298): `000000015ab27aa3af287880c1853e3b2e948349ce27cae9e533fd27fbf6520ddad0d577`,
`ctzn1qqqqqqq26kfa28teg0zqvrpf78vhffq6fecnu4609x07j07lk2gxa45x4wuqyc408`. `testnet-stack.env` BRIDGE_CONTRACT /
ASSET / ID / ADDRESS set (old file `testnet-stack.env.bak-zusdc-v0`; `MM_ASSET` waits for the Dex step); bridge
restarted from `~/zenprotocol-testnet` at acc106d2: `/status` 0 reserves, 0 outstanding, the 2 links kept.
sepolia.base.org now limits `eth_getLogs` to 200 blocks: `BRIDGE_LOG_RANGE` defaults to 190. Check pending: a 1 USDC
deposit and a withdrawal.

**State 2026-10-14 16:45: ported, activation on hold.** `contracts/v1/AuthenticatedSupply.fst` (V0 shapes; `val`s use
`Zen.Prelude.result`, since a bare `result` is F*'s own type in F* 2026 and opening `Zen.Prelude` is not allowed) is
accepted by a node with V0's costs (Issue 529, Destroy 381). Its calls could not be tried: the engine container
cannot load `libsecp256k1` for `Zen.Crypto.parsePublicKey` (V1's own DllImport, resolved per assembly). The V1 session
asked the lab to run parsePublicKey / Crypto.verify / ecdsaVerify through the node's real V1 call path in
zen-node:testnet-v1 (which file it loads, sha256); the fix (the V1 loader resolves "secp256k1" to the node's own
library, a start-up self-test, the engine using the node's loader) goes in the next image. **Activate zUSDC only
after the lab confirms the node runs parsePublicKey from V0's library, or after the fixed image is on every testnet
node**; then rerun `scripts/v1/zusdc-try.mjs`. The old zUSDC: see "Before" below (the V0 bridge was closed and its
USDC returned; the 105 old zUSDC are abandoned). `site/bridge/bridge.mjs` counts outstanding, deposits and
withdrawals only for the current `BRIDGE_ASSET` (entries carry `asset`; the old ones have none and stay as history in
`done.json`), so after the switch `/status` starts at 0 without editing `done.json`. The EVM scan continues from
`evm-cursor.json`, so old deposits are not issued again.


- Before: done differently on 2026-10-14 (see "Closed" above): the old bridge is stopped and its 115 USDC went back
  to Alon directly, so the new bridge starts with 0 reserves and 0 outstanding; the old zUSDC is simply abandoned.
  Back up `bridge-data` (links stay valid). Keep the `bridge` service stopped until `BRIDGE_CONTRACT`/`BRIDGE_ASSET`
  point at the V1 contract; the 1 USDC check deposit below then funds the new reserves.
- Port `AuthenticatedSupply` to V1: `Issue` (Amount, returnAddress) and `Destroy` (Amount), only the bridge key (the
  node wallet's `m/44'/258'/0'/3/0`, the same as today). Tests: issue by the key, by another key refused, destroy
  more than sent refused, cost equals the declared cost.
- Activate; set `BRIDGE_CONTRACT`/`BRIDGE_ASSET` to the new contract; restart the `bridge` service
  (`docker compose -f docker-compose.testnet-stack.yml up -d bridge` in `~/zenprotocol-testnet`).
- Check: a 1 USDC deposit from the linked account issues new zUSDC; a withdrawal burns it and pays USDC; the bridge
  page shows reserves ≥ zUSDC outstanding.

### 3. Dex

**State 2026-10-14 17:00: ported, waits for the next node image.** The market maker's orders on the V0 Dex are
cancelled (`MM_CANCEL_ALL=1`, 0 open; Alon had none) and the `marketmaker` service stays stopped. `contracts/v1/Dex.fst`
(V0 shapes; `takeInner`'s failure pads with `RT.autoFailw`, since V0's `RT.incFailw (W.size w * 256 + 6978)` computes
`W.size` at run time, refused by rule 4.5) passes a node's checks and type check with V0's costs (Make 3693; Cancel
4486 and Take 8020, + 256 per coin in the wallet) and stops at extraction: it needs `Zen.Asset.parse` (order assets are
strings), which Zulib V1 realizes only in the next image. `scripts/v1/check.mjs contracts/v1/Dex.fst` gives the
verdict. `scripts/v1/dex-try.mjs` (written, not run yet) tests Make, Cancel, Take (all and half), the
refusals and the costs once the image is in. The Dex uses no secp256k1 (it compares the signer with MakerPubKey), so
it waits only for `Zen.Asset.parse`. **Both zUSDC and the Dex wait for that image** (secp256k1 resolver and self-test, `Zen.Asset.parse`,
`Zen.Hash.Sha3`, c86a2c4) on every testnet node; then: zusdc-try.mjs, activate zUSDC, a Dex test script, activate the
Dex, point the market maker, the Dex page, the explorer and the wallet's Markets tab at the new ids.


- Before: cancel the market maker's and Alon's open orders on the V0 Dex (the ZP comes back).
- Port `src/ContractExamples/Dex.fst` to V1, test, activate; set `ZEN_DEX`, `MM_DEX`, `MM_ASSET` (the new zUSDC);
  restart the market maker; update the Dex page, the explorer's Dex API and the wallet's Markets tab to the new id.
- Check: the market maker places orders, a trade from the Dex page fills.

### Optional rehearsal for mainnet

Mainnet will need the long way (holders, no forced withdrawals): a V1 token next to the V0 one and a bridge
`POST /migrate {zpTx}` that destroys the old token through the V0 contract and issues the new one 1:1, both supplies
shown, then an end date. If wanted, rehearse that on the testnet with a few test holders before doing the simple
path above.

## Checks before each step

- Back up `bridge-data` (on 91.98.3.17): `docker run --rm -v zenprotocol-testnet_bridge-data:/d -v /root/backups:/b alpine tar czf /b/bridge-data-$(date +%F-%H%M).tgz -C /d .`
- After each step: `/bridge/status` numbers, the invariant above, the bridge log
  (`docker compose -f docker-compose.testnet-stack.yml logs --tail 20 bridge` in `~/zenprotocol-testnet`), a test
  deposit of 1 USDC from a linked account (not the funder), a test withdrawal, and one migration.

## Open questions for later

- Custody: one key holds the reserves and the issuing key. Multi-key custody and a pause switch are listed as "not
  done" in `docs/BRIDGE.md`; a V1 contract is the natural place to add them, but not in this move.
