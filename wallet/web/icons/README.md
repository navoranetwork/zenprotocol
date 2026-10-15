# Icons bundled with the ZP Wallet

Each file is the owner's original, unchanged. They go inside app.js as data URIs (build.mjs).

| File | What | Source | Licence / terms |
|---|---|---|---|
| `usdc.svg` | USDC token logo | Circle's brand kit (circle.com/pressroom, "Download USDC logos") | Trademark of Circle Internet Financial. Only for real USDC, never zUSDC; never altered; at least 24 px high. |
| `zusdc.svg` | zUSDC, the testnet bridge token | Navora's own icon | Kept distinct from the USDC logo on purpose. |
| `btc.svg` | The Bitcoin logo | Paths copied unchanged from bitcoin.org `img/icons/logotop.svg`, https://github.com/bitcoin-dot-org/Bitcoin.org/blob/15f399d370f5d28669f479f5bcca2f19a5161c9b/img/icons/logotop.svg (the viewBox shows the symbol without the wordmark) | The Bitcoin logo is public domain; that folder of bitcoin.org is MIT. |
| `unisat.png` | UniSat Wallet logo | The extension's own icon, https://github.com/unisat-wallet/wallet/blob/acca8c1b7bff0870f55948444dd2874c198ad401/apps/extension/build/_raw/images/logo/logo@128x.png | Repository MIT. Name and logo are UniSat's trademarks; used only on UniSat's connect button. |
| `okx.webp` | OKX logo | OKX's own repository, https://github.com/okx/js-wallet-sdk/blob/8d5e8089d8e7cabff732d181433dd2d6884273d7/docs/media/logo.png (a WebP file despite the name) | Repository MIT. Name and logo are OKX's trademarks; used only on OKX Wallet's connect button, on a white tile as OKX shows it. |

Bitcoin wallets that announce their own icon (WBIP004 `btc_providers`: Xverse, Leather, Magic Eden…) and Ethereum
wallets (EIP-6963, on the bridge page) show the icon they give; nothing is bundled for them.

Not bundled: the Zen Protocol coin logo. It is in Zen Protocol's original repositories (zenwallet `app/assets/img`,
explorer `src/assets`), but the Zen Protocol Software License grants no trademark rights (section 8) and forbids
using its trademarks or symbols without written consent (section 6). The wallet keeps its own ZP mark until that
is decided.
