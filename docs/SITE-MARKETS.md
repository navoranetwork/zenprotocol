# The site for the DPM markets: agreed plan

Status: agreed by Alon, 2026-10-17. Built after the DPM API is live on the testnet ([BETS-DPM.md](BETS-DPM.md)); the menu
changes in the same release as the pages, so no link points to a page that does not exist yet. A design mockup of the
first three pages (markets, one market, results) exists as a private artifact of Alon's.

## Pages

| Page | Content |
| --- | --- |
| Markets | Cards per open market: logo, question, the Market's chance (or "Not enough bets yet" below the minimum pool), Up/Down price per token, pool and bettors, trading cutoff, a live sparkline ("updated N min ago"); a Crypto/Forex filter; markets waiting for their result; a "Bet with USDC" strip |
| One market (own URL) | The chance with a chart (1H, 6H, 1D, All; updated each ZP block), the Uniswap price, latest trades (pending ones marked), the market rules text, a bet panel that quotes with the shared DPM maths (tokens, average price, at least if right, if it closed now, chance after) and opens the ZP Wallet; pay with zUSDC or USDC (the bridge converts 1:1, then the wallet offers the bet) |
| Results | Settled markets with the settlement price, result, payout per winning token, signers; Verify opens the evidence: the TWAP window, the Ethereum block, each pool's price, which members signed, a JSON download |
| Transparency | Fees collected, the operator's monthly fee income against the published $650 budget, the streak towards the CGP share |
| Oracle (updated) | The committee members, who signed each round, the sources; later EthZen's proofs |

The site only shows; the wallet signs ([VISION.md](VISION.md), principle 3). On mainnet the site shows no CEX prices,
only the Uniswap price (`dexPrice`).

## Logos

Only those allowed in `wallet/web/icons/README.md`: Bitcoin (bitcoin.org), ETH (cryptocurrency-icons, CC0), flags
(flag-icons, MIT; the EU flag for the euro), Circle's original USDC logo only next to real USDC, the zUSDC icon next to
zUSDC. No company or fund logos.

## Menu

**Trade**
- Markets: "Up or down on prices, settled on-chain"
- Dex: "Trade ZP, zUSDC and tokens"
- Bridge: "USDC in and out" (marked prototype until the new bridge)
- ZP ⇄ BTC: as today

**Explore**
- Explorer, Stats
- Oracle: "Prices, signers and evidence" (moved from Trade)
- Transparency: "Fees, budget and the CGP share" (new)
