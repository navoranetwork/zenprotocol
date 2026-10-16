# Icons bundled with the ZP Wallet

Each file is the owner's original, unchanged. They go inside app.js as data URIs (build.mjs).

| File | What | Source | Licence / terms |
|---|---|---|---|
| `usdc.svg` | USDC token logo | Circle's brand kit (circle.com/pressroom, "Download USDC logos") | Trademark of Circle Internet Financial. Only for real USDC, never zUSDC; never altered; at least 24 px high. |
| `zusdc.png` | zUSDC, the testnet bridge token | Navora's own icon (2026-10-16, approved by Alon): the original ZP cube (`zp.png`) unchanged, with a light-blue coin and a dollar sign at its centre | Kept distinct from Circle's USDC logo: no USDC glyph, not Circle's artwork. |
| `btc.svg` | The Bitcoin logo | Paths copied unchanged from bitcoin.org `img/icons/logotop.svg`, https://github.com/bitcoin-dot-org/Bitcoin.org/blob/15f399d370f5d28669f479f5bcca2f19a5161c9b/img/icons/logotop.svg (the viewBox shows the symbol without the wordmark) | The Bitcoin logo is public domain; that folder of bitcoin.org is MIT. |
| `unisat.png` | UniSat Wallet logo | The extension's own icon, https://github.com/unisat-wallet/wallet/blob/acca8c1b7bff0870f55948444dd2874c198ad401/apps/extension/build/_raw/images/logo/logo@128x.png | Repository MIT. Name and logo are UniSat's trademarks; used only on UniSat's connect button. |
| `zp.png` | The ZP coin logo | Zen Protocol's own explorer, https://github.com/zenprotocol/explorer/blob/45c2cc4fb8a8287e9fd4952e350c12b4b06f943d/src/assets/logo_big.png | Zen Protocol's mark, used unchanged for the ZP coin. Its licence (Zen Protocol Software License, sections 6 and 8) grants no trademark rights; Alon decided to use it (2026-10-15): the project closed in 2024, with no team left. |
| `okx.webp` | OKX logo | OKX's own repository, https://github.com/okx/js-wallet-sdk/blob/8d5e8089d8e7cabff732d181433dd2d6884273d7/docs/media/logo.png (a WebP file despite the name) | Repository MIT. Name and logo are OKX's trademarks; used only on OKX Wallet's connect button, on a white tile as OKX shows it. |
| `eth.svg`, `sol.svg` | Ether and Solana logos (round, in their colours) | cryptocurrency-icons 0.18.1 (npm), `svg/color/eth.svg` and `sol.svg`, unchanged | Package CC0-1.0. The marks belong to their projects; shown only next to the ETH and SOL prices and markets. |
| `fl-eu.svg`, `fl-gb.svg`, `fl-jp.svg`, `fl-ch.svg`, `fl-au.svg`, `fl-ca.svg`, `fl-cn.svg`, `fl-il.svg` | Flags for the currencies (EUR, GBP, JPY, CHF, AUD, CAD, CNY, ILS) | flag-icons 7.2.3 (npm), `flags/1x1/*.svg`, unchanged (shown in a circle) | Package MIT. National flags and the EU flag; the EU flag is shown for the euro only, implying no endorsement. |

Stocks, funds and metals have no bundled logo: company and fund logos are their owners' trademarks. They show a plain
disc with the ticker's symbol, drawn in the wallet (`tickerBadge` in web/app.js).

Bitcoin wallets that announce their own icon (WBIP004 `btc_providers`: Xverse, Leather, Magic Eden…) and Ethereum
wallets (EIP-6963, on the bridge page) show the icon they give; nothing is bundled for them.

