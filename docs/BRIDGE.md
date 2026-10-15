# USDC bridge prototype (testnet only)

ZP has no value of its own, so markets and bets need a unit that has. This prototype shows how USDC (on an EVM chain such as Base) can be used on ZP as the token **zUSDC**, 1:1, in 6 decimals like USDC. It runs on the ZP testnet with the USDC of an EVM *test* network (Circle's faucet gives free test USDC on Base Sepolia and Ethereum Sepolia). Nothing here holds real money.

## How it works

| Step | EVM chain | ZP testnet |
|---|---|---|
| Link | The depositor signs `Link <evm address> to <zp address>` with the EVM key; `POST /link` | The bridge stores the pair |
| Deposit | Send USDC to the bridge's EVM address | After N confirmations the bridge calls `Issue` on the AuthenticatedSupply contract (only the bridge key can) and the zUSDC lands in the linked ZP address |
| Withdraw | The bridge sends USDC to the linked EVM address | The user sends zUSDC from the linked ZP address to the bridge's ZP address. The bridge reads it from the node (`/blockchain/transaction`, not the explorer index, which stays 10 blocks behind) and, after `BRIDGE_ZP_CONFIRMATIONS` blocks (2), calls `Destroy` and pays out by itself; no claim needed. `POST /withdraw {zpTx, evm}` stays for a ZP address linked to several EVM addresses (the automatic payout goes to the latest link) |
| Reserves | The bridge's USDC balance | zUSDC outstanding = issued − destroyed (`GET /status`) |

A deposit from an address that has not linked yet waits (it is kept in `pending.json`) and is issued as soon as the link arrives.

## Pieces

- `site/bridge/bridge.mjs`: the service (Node 22 + `ethers` for the EVM side). `BRIDGE_EVM=mock:<file>` replaces the EVM chain with a JSON list of deposits, which is how CI tests it.
- `contracts/v1/AuthenticatedSupply.fst`: the token contract on the testnet since 2026-10-15 (V1; tests `scripts/v1/zusdc-try.mjs`, activation `scripts/v1/testnet-v1-zusdc.mjs`); the bridge's public key (sign path `m/44'/258'/0'/3/0`) is the only key that may issue or destroy, and Destroy refuses more than the call brings in. The V0 contract (`src/ContractExamples/AuthenticatedSupply.fst`) was closed on 2026-10-14: its reserves went back to the funder and its 105 zUSDC are abandoned. `/status` counts only the current `BRIDGE_ASSET`.
- `zen-oracle body ... returnAddress:p=<pkhash>`: builds the issue message with a chosen recipient (type `p`, a public key hash lock).
- CI: `scripts/testnet-bridge.sh` (workflow `testnet`) activates the contract, starts the bridge with a mock deposit, links, and checks that 25,000,000 units arrive.

## Run it against Base Sepolia

```bash
cd site/bridge && npm install
BRIDGE_NODE=http://127.0.0.1:31567 BRIDGE_CONTRACT=<ctzn1…> BRIDGE_ASSET=<contract id hex> \
BRIDGE_EVM=https://sepolia.base.org BRIDGE_EVM_KEY=<test key, never a real one> \
node bridge.mjs
```

The EVM test key needs a little test ETH for withdrawals. The default USDC address is Circle's Base Sepolia test USDC.

## What is and is not done

- Done and tested in CI: link, deposit, issue to a chosen address (mock EVM).
- Done and tested on the live testnet server with Base Sepolia (2026-10-08): link by signature, a real USDC deposit issued as zUSDC, and a withdrawal that burned zUSDC and paid USDC back. See VERIFICATION.md.
- Not done: pause switch, limits, proof of reserves page, multi-key custody.
- Custody: one key holds the reserves and the issuing key. The plan is to move both to a community vote (multi-signature) before any real use. Real money, regulation and an independent audit come before that.
- Site page `/bridge.html`: live reserves (the bridge's USDC balance read from the EVM chain) against zUSDC outstanding, connect a browser wallet (switches it to Base Sepolia), link by signature, deposit USDC, claim a withdrawal, and the history of one EVM address (`GET /lookup?evm=`). nginx exposes `/bridge/status`, `/bridge/lookup` (GET) and `/bridge/link`, `/bridge/withdraw` (POST, rate-limited); re-run `site/setup-testnet-web.sh` to publish the new routes.
- Reserve top-ups: USDC sent to the bridge from an address listed in `BRIDGE_FUNDERS` (in `testnet-stack.env`) adds to the reserves and issues nothing. Used on 2026-10-12 to cover the 100 zUSDC of the early mock deposit `0xmm1` (market maker seed), which had no USDC behind it.
- 2026-10-15: withdrawals are automatic (see the table); the ZP Wallet sends zUSDC (0.15.0) and names the bridge (0.16.0). Waiting times are shown on the page: deposit about 5 minutes (12 Base confirmations, then the next ZP block), withdrawal about 8-10 minutes (2 ZP blocks).
- The bridge's ZP address is the node wallet, which the market maker also uses: zUSDC sent there from a linked address is a withdrawal. Do not fund the market maker by sending zUSDC to that address from a linked ZP address.
- Needed next: pause switch, limits per user, a separate key for the market maker.

## Trying it on Base Sepolia (test network, test keys only)
1. Make two keys: `node site/bridge/evm-tools.mjs newkey` twice (the bridge's key and a depositor's key).
2. Faucets (free): the depositor needs test USDC (faucet.circle.com, network Base Sepolia) and a little test ETH; the bridge key needs a little test ETH for the gas of withdrawals (any Base Sepolia ETH faucet).
3. In `testnet-stack.env` set `BRIDGE_EVM=https://sepolia.base.org` and `BRIDGE_EVM_KEY=<bridge private key>`, then recreate the `bridge` service. `/bridge/status` then shows `bridgeEvm` (the address to send USDC to).
4. Link: `node site/bridge/evm-tools.mjs link <depositor key> <your ZP address>` and POST the printed JSON to `/link`.
5. Send USDC: `node site/bridge/evm-tools.mjs send <depositor key> <bridge address> 5`. After the confirmations the bridge issues the zUSDC to the linked ZP address.
