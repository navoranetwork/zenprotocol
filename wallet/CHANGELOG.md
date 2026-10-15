# ZP Wallet changelog

Every change to the wallet is listed here. A change goes under **Unreleased** when it is made; when the wallet is
published to the site, Unreleased becomes a numbered release with its date, and `version` in `package.json` is set to
the same number (the wallet shows it in Settings; `test/version.test.js` checks they agree).

Numbers: `MAJOR.MINOR.PATCH`. PATCH for fixes, MINOR for new features, MAJOR for a change that breaks saved wallets or
settings. 1.0.0 is kept for the release that runs on mainnet with V1 contracts after an outside review.

## Unreleased

Nothing yet.

## 0.17.1 — 2026-10-15

### Changed
- Named plain addresses: the testnet's market maker (its own key since today) shows as "the market maker" in the
  activity and the confirm screen; sending to it says it is not the USDC bridge (nothing sent there is paid out as
  USDC). Names come from the site's contract-names.json, which can now name plain addresses too.

## 0.17.0 — 2026-10-15

### Added
- Tap a token in the Tokens card to open it: icon, name, balance, Send, Receive and its own activity; for zUSDC also
  Withdraw (Send to the USDC bridge) and a link to deposit USDC on the bridge page.

### Changed
- Send chooses what to send with buttons that show each token's icon and balance (was the browser's list, which
  cannot show icons).

## 0.16.1 — 2026-10-15

### Fixed
- The zUSDC icon showed as a broken image on the site (the site copies only the top of the wallet's build); the icons
  are now inside app.js.
- zUSDC issued for a USDC deposit shows as "Received from the USDC bridge (deposit)", with Withdraw (Send to the
  bridge) and Copy id, instead of an unnamed address.

## 0.16.0 — 2026-10-15

### Added
- zUSDC shows its icon (Navora's own, distinct from the USDC logo) in the Tokens card, the activity, Send and the
  confirm screen.
- The site's USDC bridge is recognised (read from its /bridge/status): its ZP address shows as "the USDC bridge" in the
  activity and the confirm screen. Sending zUSDC there says it is a withdrawal, that the bridge pays the USDC to the
  linked EVM address by itself, and how long it takes (2 ZP blocks, about 8 to 10 minutes); sending any other asset
  there is warned against.
- "Copy id" on each transfer in the activity, and "Copy" for the transaction id when a transfer is sent.

## 0.15.0 — 2026-10-15

### Added
- Send tokens, not only ZP: when the wallet holds a token, Send asks what to send (ZP or the token, with its balance);
  the unit, Available and Max follow the choice; zUSDC with its 6 decimals. Only that token is spent (no fee); the
  change stays in the token. Used to withdraw from the USDC bridge: send zUSDC to the bridge's ZP address.
- Token names known when the wallet is built (the site's asset-names.json), so the testnet's zUSDC is named even
  where the site publishes no assets.json.

### Fixed
- Activity: a token received or sent shows its amount and unit ("+2.00 zUSDC", was "+2000000"); Send back and Send
  again keep the token.
- Contract forms: a token chosen from the wallet was read in the wrong form and could be taken for ZP; it is now read
  as the node names it (version, then contract hash).

## 0.14.0 — 2026-10-15

### Added
- Try it: when a call would pay out more than goes in (the engine's `unbalanced`), the result says "A node would reject this transaction" with the amount, is marked "Not valid", and the next call does not build on it.

### Fixed
- zUSDC shows with its own 6 decimals in the Tokens card and the contract forms' asset picker (was shown with ZP's 8).

### Changed
- When a node would refuse a contract and the checker can only guess the line, it says "near line N" (was "line N").

## 0.13.0 — 2026-10-14

The contract flow as in the design "ZP Wallet: Create a contract".

### Added
- Activate is its own screen: keep it active for 1 week, 1 month (the default), 1 year or a number of blocks, with
  the date it runs until; the cost (characters × blocks × 1 kalapa), no network fee, and the balance ("enough", or
  "Not enough ZP" with how much more, "Fewer blocks" and "Receive ZP"; Sign stays off); the id check; signed and sent
  from this screen.
- After activation: the contract's address and id, Share, Show QR, and "How it is used" (each command and who may
  call it); sent until its block, then active until block N.
- My contracts at the top of Contracts: the contracts activated here (active, ending soon, waiting for its block, or
  ended), with Open and Extend; a contract made but not activated yet, with Review and Activate.

### Changed
- Result: "Made and checked: a node accepts it" and "N of N tests pass" as badges; the id with "computed in your
  wallet"; each call's gas; the cost to activate per block; Tests and Source as two tabs; Try it and Activate… at the
  bottom.
- While a contract is made: three steps (made, checked like a node with its tests, ready to review).
- When the contract service cannot answer: "busy" (503), "today's descriptions are used up" (429), "can't reach the
  contract service" (no answer, your coins are not affected) and "couldn't check it right now" (the checker's own
  problem, not your contract).
- "All active contracts" for the network's list.

## 0.12.0 — 2026-10-14

### Added
- Contract forms: what a contract holds, sells or is voted with is chosen, not typed: ZP, the tokens this wallet holds
  (name or short id, with the balance), or "Other token…", which opens the contract-hash field with its check.
- Public key fields: Paste, and Scan QR where the browser can read QR codes (the camera opens in a window; the first
  public key in the code fills the field), next to "Use my key".

### Changed
- "Use my key" / "Use my address" without the wallet's name (it shows on hover).

## 0.11.0 — 2026-10-14

### Changed
- Contract forms in plain words: "What it does" in a few lines per family; fields with names people use ("Buyer's
  public key", "Refund to the buyer from block", "Voting closes at block") and one line of help, without types such as
  "u32"; examples in the empty fields shown in italics so they do not look filled in; the engine's own text under
  "Technical description". An error names the field and outlines it.
- Filled in for you: your address as the vault's owner, your key as the swap's owner, "zp" where the asset is ZP, and
  a block about 2 hours ahead; under each block field the time it means ("About 2 hours from now") and buttons for in
  1 hour / 1 day / 1 week. The Token form says there is nothing to fill in.

## 0.10.0 — 2026-10-14

### Changed
- Create a contract: each family is a full-width card (icon, plain name, one line on what it does, chevron) instead of
  a small chip: Escrow, Token, Time-locked vault, Fixed-rate swap, Holders' vote. "Describe it…" is its own card
  with a dashed border, dimmed and marked "Not available yet" while the engine has it off.
- Active contracts: a contract activated from this wallet keeps the name of its family; the testnet's BitZen chain and
  ZP ⇄ BTC swap contracts are named; any other shows as "Contract" with its short address (was "Unnamed").
- The note under Active contracts no longer says that running contracts come later.

## 0.9.1 — 2026-10-14

### Changed
- Errors cannot be missed: a red box with an icon, the main point in bold and the details under it, larger text, a
  short shake when it appears (not when the system asks for reduced motion), the screen moves to it; the field it is
  about is outlined in red (the Bitcoin addresses of an offer). Warnings are larger too.

## 0.9.0 — 2026-10-14

The first numbered release. It contains everything the wallet does today, built from 2026-10-06 on.

### Keys, wallets and safety
- Several wallets in one app: new 24-word phrase, or import an existing phrase, a private key, an xprv, or a
  watch-only address.
- Keys and addresses derived as zen-node does (checked against the node for the test phrase).
- An encrypted vault in the browser, unlocked with a password; it locks by itself after inactivity. Show/Hide on
  password fields.
- Transactions serialized and signed in the browser, checked byte for byte against 202 mainnet transactions.
- Every answer from the node is checked before signing: a node that changes the transaction, or answers with a
  different hash, is refused.
- Mainnet and testnet; any node (https, or http on this computer); a default node from the site (`config.json`). A busy
  node is asked up to 3 times before "Node offline".

### Wallet
- Balance as soon as it is read; both address branches discovered in parallel; mining rewards shown as maturing until
  they can be spent.
- Send ZP; activity with "Send back".

### Vote (Common Goods Pool)
- Allocation votes (only the allowed range around the value in force), payout nominations and payout votes, from one or
  several wallets; one ballot per wallet and phase.
- The vote screen follows the chain: every 20 s it reads the tip and opens the forms when nominations or voting start.
- CGP phases by interval, including the testnet's longer phases from interval 22 (snapshot 70, nominations 71–80,
  voting 81–100).
- The CGP fund and the per-block amount read from the node.

### Contracts
- Active contracts with their end date and an expiry warning; names by full address (CGP, VCGP, FPC, DEX-V2).
- Extend a contract: blocks, cost, what the contract does, a warning for a large payment.
- Create a contract with the contract engine: ready families (token, time-locked vault, fixed-rate swap, escrow,
  holders' vote) or "Describe it" (experimental, with a daily limit). The engine checks the contract as a node will;
  the wallet computes the contract id itself and refuses to sign when it differs.
- Read and edit the source; an edited source is checked again before it can be activated.
- Try a contract's calls without real money (signer, money sent in, body fields, block windows), with the net effect
  per recipient and the raw transaction behind Details; calls in a row build on each other.
- Activate a V1 contract, signed in the wallet; the job being made survives a reload.

### Markets
- Three tabs, the chosen one remembered: Oracle (prices with source agreement), Dex (open orders), ZP ⇄ BTC.
- ZP ⇄ BTC (BitZen): sell ZP for bitcoin. Offers with the price as a total in BTC, dollars per ZP (the oracle's Bitcoin
  price, the default when there is one) or satoshis per ZP; the price per ZP shown in BTC, sat and dollars.
- Each offer's Bitcoin addresses must be new: refused when used in an earlier offer here, by any offer in the market,
  or when they already received bitcoin (asked from mempool.space).
- A sent offer shows at once as waiting for its block; a take-back shows as "Taking back"; no take-back while an offer
  is reserved and for 10 blocks after (as the contract).
- The tab refreshes the market every 30 s while it is open.
- Contract calls (offers, take-backs, votes) can spend mature mining rewards.

### Build
- One bundled page; style and script linked with a version from their content, so an update is never hidden by the
  browser's cache.
- Tests: unit tests (`npm test`) and browser tests against a mock node (`tools/ui-test/`).
