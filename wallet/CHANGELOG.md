# ZP Wallet changelog

Every change to the wallet is listed here. A change goes under **Unreleased** when it is made; when the wallet is
published to the site, Unreleased becomes a numbered release with its date, and `version` in `package.json` is set to
the same number (the wallet shows it in Settings; `test/version.test.js` checks they agree).

Numbers: `MAJOR.MINOR.PATCH`. PATCH for fixes, MINOR for new features, MAJOR for a change that breaks saved wallets or
settings. 1.0.0 is kept for the release that runs on mainnet with V1 contracts after an outside review.

## Unreleased

Nothing yet.

## 0.27.5 — 2026-10-16

### Fixed
- Activity: a transfer between the wallet's own addresses (nothing in or out) shows as "Moved within this wallet",
  0 ZP, instead of "Sent −0 ZP".

## 0.27.4 — 2026-10-16

### Fixed
- A contract call (an offer, a Dex order, a bet…) that would need more than 50 small outputs now says how many it
  needs and offers "Combine my ZP now": Send opens with all the wallet's ZP to its own address, explained. One
  transfer (no fee) gathers the pieces; after its block the call works.

## 0.27.3 — 2026-10-16

### Changed
- The new-offer form shows the ZP and Bitcoin logos next to "ZP to sell", the BTC price and "Where the bitcoin goes".

## 0.27.2 — 2026-10-16

### Fixed
- Selling ZP for bitcoin: more ZP than the wallet has is said at once, as you type, and refused on Review with the
  amount that fits (the fee is 1 kalapa); a Max button fills it. Before, the form took any amount and failed later.

## 0.27.1 — 2026-10-15

### Fixed
- An order made here is no longer kept locally once the site lists it, and a cancel forgets it at once: before, a
  cancelled order could come back faded for up to 30 minutes after it left the book.
- A faded row says why on hover (new, being taken, or being cancelled) and the note under the book says so too.

## 0.27.0 — 2026-10-15

### Changed
- A cleaner order book, as exchanges show it (Alon): compact rows in a fixed-width face, Price / Size / Sum, flat
  depth bars; the last trade price large in the middle (green up, red down) with the spread beside it; your orders
  marked with a dot, orders waiting for their block faded, with the details on hover. Trades as a table with the time.

## 0.26.1 — 2026-10-15

### Fixed
- Order book: a sent order is marked "Yours · sent" so the row stays on one line; Your orders still says it waits for
  its block.
- The Buy / Sell form is cleared after an order is sent, so it is not sent twice by mistake.

## 0.26.0 — 2026-10-15

### Added
- A limit order made here shows in the book at once, "Yours · waiting for its block", and under Your orders with a
  spinner, until the site lists it (at most 30 min). The book also asks the site for mempool orders (pending=1),
  shown as pending and never taken.

## 0.25.2 — 2026-10-15

### Changed
- Order book: each side is labelled, "Asks · selling ZP: tap to buy" and "Bids · buying ZP: tap to sell".

## 0.25.1 — 2026-10-15

### Fixed
- Order book: prices line up on the left under "Price", as the header (they were pushed right by the depth bar).

## 0.25.0 — 2026-10-15

### Added
- Markets → Dex is an order book for ZP / zUSDC, from the site's new /dex/book (fresh to one block; mempool orders
  shown as pending and not takeable), or built from /dex/orders on an older site:
  - asks (red) above, bids (green) below, best prices next to the spread, price levels by 0.0001 zUSDC with size,
    running total and a depth bar; the own orders marked "Yours", orders being taken marked;
  - tap a price to take its best order (part or whole, as before); before signing, the wallet checks the order is
    still open on the chain ("Someone took it first" otherwise);
  - Buy ZP / Sell ZP limit orders (price and amount, at least 1 ZP and 0.01 zUSDC), with what you pay or get as you
    type, and a warning when the price crosses the other side or is more than 5% from the middle of the book;
  - recent trades (green: someone bought ZP, red: sold), the last price, and Your orders with Cancel;
  - the full order list and orders of any pair stay under "All orders and other pairs"; the tab refreshes every 20 s.

### Fixed
- Sizes set through the DOM instead of style attributes, which the page's CSP refuses: the Bitcoin confirmations bar
  had one column per confirmation only in tests without the CSP.

## 0.24.0 — 2026-10-15

### Changed
- Buying ZP with bitcoin says first how long it takes when paid at once: "About 30 min in all" (2 confirmations;
  40, 50 or 70 min for larger amounts), on each offer and on the reserve screen, with the steps and their times. The
  longest times (up to 32 min to pay, held 1 h 20 min) are one small line. The price shows in dollars too.

### Added
- One click: with a Bitcoin wallet that can pay (when switched on), the button reads "Reserve and pay", and once the
  reservation is in a block the wallet's pay screen opens by itself (once; the QR code stays).

## 0.23.0 — 2026-10-15

### Added
- The original ZP coin logo (from Zen Protocol's explorer repository, unchanged) next to the ZP balance, in the token
  and send pickers, on ZP ⇄ BTC offers and on the Markets tab. Alon decided to use it: the project closed in 2024 with
  no team left (its licence grants no trademark rights; web/icons/README.md).

## 0.22.0 — 2026-10-15

### Added
- Original logos (Alon): the Bitcoin logo (public domain, from bitcoin.org) next to BTC amounts, on the ZP ⇄ BTC tab
  and the pay screens; UniSat's and OKX's own logos, unchanged, on their connect buttons only (they announce no icon;
  wallets that do, such as Xverse and Leather, keep showing their own). Sources and terms in web/icons/README.md.
- Settings and the Bitcoin wallet picker: "Wallet names and logos are trademarks of their owners."

### Not changed
- ZP keeps its own mark: the Zen Protocol coin logo is in the original repositories, but their licence grants no
  trademark rights and forbids using the marks without written consent. Alon decides.

## 0.21.0 — 2026-10-15

### Added
- Buying ZP with bitcoin: the network fee to pay with, Bitcoin's next-block rate in sat/vB from the Esplora service,
  so the payment confirms while the reservation holds (a slower one may not release the ZP). Shown on the pay step
  and before "Pay with <wallet>", and passed to wallets that take a fee rate (UniSat, OKX).

### Fixed
- Selling: addresses from the account key stay within the gap limit of Bitcoin wallets (20 unused addresses after
  the last one that received bitcoin). Before, every offer took new addresses past the last one handed out, so after a
  few offers a payment could go to an address the seller's Bitcoin wallet does not watch (not lost, but it looked
  unpaid). Now the search starts after the last address used on Bitcoin, refuses past the gap and says why, and an
  offer taken back before anyone reserved it gives its addresses back. New offers default to 2 reservations.
- When a payment arrives on a sale, the steps say which receive address of the account it went to, and to raise the
  gap limit if the Bitcoin wallet does not show it.

## 0.20.0 — 2026-10-15

### Added
- ZP ⇄ BTC as easy as the bridge: two tabs, **Buy ZP** and **Sell ZP**, with a "Real bitcoin, test ZP" banner on the
  testnet.
  - Offers as cards: ZP, total in BTC, price per ZP in BTC and dollars, and "about N min after you pay".
  - One list of steps for a purchase (Reserved → Pay → Bitcoin confirmations → Proof sent → ZP received) and for a sale
    (Reserved by a buyer → The buyer pays you → confirmations → The ZP goes to the buyer), each with its expected time.
  - Selling without typing Bitcoin addresses: paste the Bitcoin account key (zpub, xpub or ypub) once; each offer gets
    new receive addresses from it (BIP84 / BIP49), skipping any used by this browser, by the market or on Bitcoin, and
    continuing where the last offer stopped, also after a reload. The key stays on this device (Settings → Forget).
    Or a connected Bitcoin wallet's one address (one reservation, said so), or typed addresses as before.
  - Bitcoin wallets in the browser (WBIP004 providers such as Xverse and Leather with their own icon and name; UniSat,
    OKX): only asked for an address, or to send an exact amount to an exact address in their own confirm screen. A
    wallet on the wrong Bitcoin network is refused.
  - "Pay with <wallet>" for a purchase, after a screen showing the address and amount match the reservation. Off until
    switched on at build time (`BTC_WALLET_PAY=1`), and limited to 0.01 BTC per purchase; the QR code always works.
  - Settings → Bitcoin data: which Esplora service is asked about addresses (mempool.space by default), what it learns,
    and another one can be set.

### Changed
- Take back stays visible and is disabled with the reason (reserved, paid, or the 10 blocks after a reservation).

## 0.19.0 — 2026-10-15

### Added
- Buy ZP with bitcoin from Markets → ZP ⇄ BTC (BitZenSwap, the buyer's side), as on the site's swap page:
  - others' offers with a Buy button; Reserve holds the offer for this wallet's address (the site's prover sends the
    reservation and pays its fee; the wallet checks it is for its own address);
  - the payment screen: exact amount, the seller's Bitcoin address, a QR code and "Open in my Bitcoin wallet", and how
    long is left to pay (with a warning not to pay when too little time is left for the confirmations);
  - live progress: payment seen, Bitcoin confirmations, proof sent, ZP received. Nothing to trust: the contract checks
    the Bitcoin payment itself. One purchase at a time, kept across reloads; refreshes every 10 s while it runs.

## 0.18.0 — 2026-10-15

### Added
- Trade on the Dex from Markets → Dex (contracts/v1/Dex.fst):
  - Take an order, whole or in part: you choose how much you give, the wallet shows what you get
    (floor(underlying × given / total), as the Dex pays) and what stays in the order. The call is anonymous, as the
    Dex allows; the coins you give can be ZP or a token such as zUSDC.
  - Cancel your own orders (signed with this wallet's key); they show as "Your order".
  - Make an order: what you give and what you want, by token, with both amounts.
  - Before anything is signed the wallet checks what the Dex adds: you get exactly the payout, the maker gets exactly
    what you give, and nothing goes to anyone else (src/dex.js).
- Contract calls can send any asset and can be unsigned (prepareContractCall); offers and votes are unchanged.

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
