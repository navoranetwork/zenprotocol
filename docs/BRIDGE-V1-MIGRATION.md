# Moving the USDC bridge (zUSDC) to a V1 contract: handoff

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

Move zUSDC from the V0 contract to a V1 contract, but only after the V1 fork (block 2050, night of 2026-10-13/14) has
run stable for a few days and BitZen runs on it. One change at a time: if something breaks right after the fork, it
must be V1, not the bridge.

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
- First V1 contracts on the testnet: BitZenChain and BitZenSwap (bitzen repo, `contracts/v1/`, deployed with
  `scripts/testnet-v1-deploy.mjs` after 2050).
- Writing V1 contracts (lessons from BitZen): no list literals (`[]` → `Nil`, cons is fine); `exists` is a keyword;
  qualify `Zen.Prelude.OK/ERR`; annotate equality as `(a = b <: bool)`; the costliest branch first in an `if`, the
  others padded with `autoInc`; the cost function must equal main's elaborated cost (the F* error shows `(N + 19)`);
  `build-contract.sh` takes the source without a `module` line. Contract id = SHA3-256(BE32(1) ‖ UTF-8 source).
- The contract engine (zp-contracts-v1 branch `engine-check`, `docs/ENGINE.md`, `docs/SERVICE.md`) has families
  token, timelock-vault, swap, escrow. None is an authenticated-supply token yet: ask the engine session for an
  "authenticated supply" family, or write it by hand.
- The ZP Wallet can activate a V1 contract signed in the browser (`wallet/src/wallet.js` `prepareActivateV1`), and
  calls contracts with a PK sender (`prepareSignedCall`). The bridge itself signs through the node wallet.

## Plan

### 1. The V1 zUSDC contract

- Port `AuthenticatedSupply` to V1: `Issue` (Amount, returnAddress) and `Destroy` (Amount), only the bridge key
  (the same public key as today, `m/44'/258'/0'/3/0` of the node wallet). Same asset rules: the contract's default
  asset, 6 decimals by convention (amounts in USDC base units).
- Tests like BitZen's (`tests/v1/` with the ZenAbi harness): issue by the key, issue by another key refused, destroy
  more than sent refused, cost equals the declared cost, gas. Then on the lab devnet (V1 node) before the testnet.
- Activate on the testnet with the node wallet (`/wallet/contract/activate` with `version: 1`), enough blocks.

### 2. Migration of existing zUSDC (1:1)

A V1 contract cannot destroy the V0 asset (only the V0 contract can), so the bridge does the swap:

- New endpoint `POST /migrate {zpTx}`: the holder pays old zUSDC to the bridge's ZP address; the bridge checks the
  transaction (like a withdrawal), calls `Destroy` on the **V0** contract for that amount, then `Issue` on the **V1**
  contract for the same amount to the paying ZP address. Recorded in `done.json` as `m:<zptx>`; idempotent.
- Invariant after every step: USDC held ≥ old zUSDC outstanding + new zUSDC outstanding. Show both on the bridge page.
- No link to an EVM address is needed for migration (the payer gets the new token at the same ZP address).

### 3. Switch the bridge to the new token

- `BRIDGE_CONTRACT`/`BRIDGE_ASSET` become the V1 contract; keep the V0 ones as `BRIDGE_OLD_CONTRACT`/`BRIDGE_OLD_ASSET`
  for migration and for withdrawals of old zUSDC during the transition.
- Deposits issue only the new token. Withdrawals accept both.
- Market maker: `MM_ASSET` → the new asset; cancel its old zUSDC orders on the Dex first.
- Wallet, explorer, assets page: name the new asset "zUSDC" and the old one "zUSDC (old)" with a hint to migrate.
- Bridge page: "Migrate old zUSDC" button (wallet payment + `/migrate`), both supplies shown.

### 4. End of the transition

- After an announced date: withdrawals only in the new token; old zUSDC can still be migrated, then withdrawn.
- Update `docs/BRIDGE.md`, the community document's tables if relevant, and this file.

## Checks before each step

- Back up `bridge-data` (on 91.98.3.17): `docker run --rm -v zenprotocol-testnet_bridge-data:/d -v /root/backups:/b alpine tar czf /b/bridge-data-$(date +%F-%H%M).tgz -C /d .`
- After each step: `/bridge/status` numbers, the invariant above, the bridge log
  (`docker compose -f docker-compose.testnet-stack.yml logs --tail 20 bridge` in `~/zenprotocol-testnet`), a test
  deposit of 1 USDC from a linked account (not the funder), a test withdrawal, and one migration.

## Open questions for later

- Should the Dex also move to V1 (it holds zUSDC orders)? Separate step, after the bridge.
- Custody: one key holds the reserves and the issuing key. Multi-key custody and a pause switch are listed as "not
  done" in `docs/BRIDGE.md`; a V1 contract is the natural place to add them, but not in this move.
