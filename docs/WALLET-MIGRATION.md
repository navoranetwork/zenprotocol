# Moving the testnet off the public wallet phrase (planned 2026-10-18)

The node wallet of the public testnet was made from the public phrase "abandon … art"
(docs/DEPLOY.md, "The node wallet"). These keys of that wallet were derivable by anyone:
- the bridge's ZP address (0/0);
- zUSDC's issuer and the oracle's commit key (3/0);
- the market maker (2/0) and the bets service (2/1).

This is the plan, agreed with the wallet session on 2026-10-17.

## What stays and what changes
- **They stay:**
  - FixedPayout `000000010accfe38…d472c`. It holds no key: a market names its collateral and oracle key in the body.
  - The V1 Oracle `00000001cbcf4ef4…`. The key is given per message.
  - The Dex.
- **They change:**
  - the node wallet's phrase, made on the server and kept only in `.env`;
  - the oracle's key;
  - the zUSDC contract and its asset (a new AuthenticatedSupply with the new 3/0 key);
  - the bridge's ZP address;
  - the market maker's and bets service's keys.

## Order
1. **Before:**
   - From 2026-10-17 00:20 Israel the bets service opens no new markets (`BETS_TICKERS=` empty).
   - Nothing tops up the node wallet.
   - Alon cancels his own orders and collects.
   - The bridge has been stopped since 2026-10-17 00:37 Israel, so nobody can withdraw USDC against zUSDC issued with
     the public key. Withdrawals sent meanwhile wait for step 3. Do not `up -d` the whole stack before the move: that
     would start the bridge again.
2. **The night's markets close** at 2026-10-17 22:00 UTC and settle with the old key.
3. **The bridge processes every pending withdrawal:** old zUSDC at 0/0 from a linked sender is paid out in USDC and
   burned.
4. **We cancel our own Dex orders** (market maker, bets).
5. **Snapshot**, then the plan, the asserts, the issue (below).
6. **The services move to the new keys:**
   - the new wallet, the new zUSDC contract and asset, the new oracle key;
   - new markets name the new zUSDC.
   - The bridge refuses withdrawals of the old zUSDC.
   - `site/asset-names.json` and `contract-names.json` name the old asset "zUSDC (old)".
7. **Send the wallet session:** the new zUSDC asset id, the oracle key, the bridge address and the service addresses.
   It updates its tests, its mock, BETS.md, ORACLE.md, TESTNET-V1-MIGRATION.md and site/test/bridge.test.mjs.

## The scripts
- `scripts/v1/wallet-move.mjs snapshot` writes `snapshot.json` and `issue-plan.json`, and runs the asserts.
- `scripts/v1/wallet-move.mjs issue` issues once from the plan, keeping `issued.json`.
- The rules are in `site/wallet-move-core.mjs`, tested in `site/test/wallet-move.test.mjs`.
- Both run in the zen-tools image with the index database mounted; the commands are in the script's header.
- The new phrase is read from a file and never printed.
- The snapshot refuses to run when:
  - the mempool holds a call to zUSDC, FixedPayout or the Dex;
  - the bridge's asset is not the old zUSDC;
  - the Dex holds a different amount than its open orders say;
  - the old zUSDC found at all addresses is not the supply (a holder the index has not seen yet).

## The snapshot (`snapshot.json`)
Each owner (a PK address) is credited with:
- old zUSDC held at the owner's address;
- old zUSDC in open Dex orders, credited to the order's MakerPubKey;
- position tokens of the settled markets, at the owner's address or in open Dex orders by MakerPubKey, valued at the
  payout: winner 1, loser 0, void 0.5 rounded down per owner. A Redeem done or not done gives the same result;
- old zUSDC at the bridge's 0/0 that is still there after step 3. It goes to its sender, read from the inputs of the
  transaction that brought it.
  - If those inputs come from a contract or from more than one PK, the sender is not guessed. The coin is listed under
    `manual`, left out of the issue until Alon decides, and counted as a known difference.

Balances at contract addresses (FixedPayout, Dex, any other) are skipped: they are owed through the orders and tokens
above.

## The plan (`issue-plan.json`) and its asserts
- **Our own old addresses are mapped to the new keys:**
  - 0/0 to the bridge;
  - 2/0 to the market maker;
  - 2/1 to bets;
  - 3/0 to the issuer and oracle;
  - any other key the old wallet used, from `/wallet/keys`.
- **The reserve surplus goes to the bets service's new key.** That is USDC held minus zUSDC out: 272 − 212, including
  Alon's 40 USDC funder deposit.
- **Assert 1:** credits + void rounding dust + `manual` = the old supply (212,000,000 units). The dust is less than
  one unit per owner of a void market, and goes to the bets service.
- **Assert 2:** no address in the plan is derived from a phrase in `site/known-wallets.mjs`. The check covers
  0/0..0/49, 1/0..1/49, 2/0..2/49 and 3/0..3/9 of each phrase.
- If an assert fails, nothing is issued and the difference is printed by category.
- The issue follows the plan once: a re-run skips the owners already issued.
