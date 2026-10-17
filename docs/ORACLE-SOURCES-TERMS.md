# The oracle's price sources: their terms of use (for review before mainnet)

Status 2026-10-17: a summary for Alon's legal review. **It is not legal advice.**
- The terms change. Read each one at its link on the day of the review, and keep a dated copy.
- Each line says what the published terms appeared to say on 2026-10-17.

## What ZP does with the prices
1. **The oracle** fetches prices hourly (`src/Oracle`, `site/oracle-sources.json`). It commits a Merkle root of them
   on-chain, publishes the values through its API (`/rounds`, `/auditpath`) and the explorer, and the wallet and
   site show them.
2. **The bets service** reads BTC and ETH each minute, from Coinbase, Binance and CoinGecko, to price its quotes.
3. **Markets settle on the committed values,** so a third party's financial product depends on them.

In most data licences, all three are **redistribution or display of derived data to third parties**, and settlement
is **use as a benchmark or valuation**. Only publishing to our own team counts as internal use.

## The current sources

| Source | Used for | Commercial use | Redistribution / publishing derived prices | Attribution | Verdict |
| --- | --- | --- | --- | --- | --- |
| **Coinbase** (`api.coinbase.com`, spot price) | BTC, ETH: oracle and live quotes | personal or internal research only; no app for end users outside the organisation | **prohibited without written consent**, including derived works. Also prohibited: using it to create indexes, benchmarks or valuations of financial products | none; no use of their marks | **not allowed** without a written licence |
| **Binance** (`api.binance.com`, ticker price) | BTC, ETH: oracle and live quotes | the product terms of use govern the live API. Archived versions bar data feeding services and services profiting from Binance market data without written consent. The archive files are CC BY-NC-SA, non-commercial | **needs written consent** | for the archive files only | **not allowed** without a written licence. The current product terms are to be read on the day |
| **CoinGecko** (`api.coingecko.com`) | BTC, ETH: oracle and live quotes | allowed within the plan's scope (paid plans; the free plan's scope is on its pricing page) | no redistribution or syndication of access without an executed agreement; no copying or deriving from the data except as the terms allow; cache for 24 h at most | "Powered by CoinGecko", prominent | **not allowed** for publication on-chain without an agreement. Ask for their enterprise licence |
| **Frankfurter** (`api.frankfurter.dev`, which serves the **ECB**'s euro reference rates) | EUR, GBP, JPY, CHF | the ECB's statistics reuse policy: **free, commercial or not** | reuse allowed. The statistics must not be modified; disclaimers apply. The ECB says the reference rates are for information only | "Source: ECB statistics" | **allowed**, with attribution. But the rates are once a day (about 16:00 CET), so there are no hourly FX rounds from this source alone. Frankfurter itself is a free open-source mirror; for mainnet read the ECB directly |
| **ExchangeRate-API open access** (`open.er-api.com`) | EUR, GBP, JPY, CHF (second source) | allowed, for currency conversion | **not allowed**: the data may not be passed on | link "Rates By Exchange Rate API" | **not allowed** for an oracle. Daily updates only |
| **Twelve Data** (`api.twelvedata.com`, with our key) | SPY, AAPL, MSFT, XAU | individual plans: personal or internal only. **Business plans** (Venture and up): commercial display | redistribution needs a separate agreement, even on business plans; exchange licensing applies; non-US data needs extra approval | per agreement | **not allowed** on our plan. A business plan plus a redistribution agreement plus the exchanges' licences |
| **Yahoo Finance** (`query1.finance.yahoo.com`, unofficial) | SPY, AAPL, MSFT, XAU (second source) | an undocumented endpoint, not offered as an API. Yahoo's terms allow personal use only | not allowed | — | **not allowed.** Drop it before mainnet |

## What does allow publishing derived prices (to evaluate)

**FX:**
- **ECB** reference rates are free with attribution, but daily only.
- For hourly FX, a licensed provider with a redistribution clause.
- Or markets that close only at the ECB fixing (one FX close a day at about 14:15 UTC, settled on the ECB rate).

**Crypto:** a licence with explicit redistribution and benchmark rights. To ask:
- CoinGecko enterprise ("executed agreement");
- Kaiko;
- CoinMetrics;
- CF Benchmarks;
- the exchanges' own data licences (Coinbase and Binance both say "written consent").

Also to check: the public terms of Kraken, Bitstamp and Gemini market data, for exchanges whose terms permit display
with attribution.

**Stocks and gold:**
- Real-time US stock prices need the exchanges' redistribution licences, usually through a vendor.
- End-of-day or delayed data is cheaper and simpler.
- Gold: the LBMA price is licensed; COMEX futures are CME data.
- Until a licence is in place: **no stock or gold markets on mainnet.**

**Pyth:** not viable.
- Its free tier has no API access.
- Starter ($500 a month) has no redistribution rights.
- Pro (from $2,500 a month) has limited ones.
- Publishing on-chain is redistribution (docs/ORACLE-HARDENING.md, (b)).

## Open questions for the lawyer (Alon's legal review, before any mainnet market)

1. **RPC and light-client terms.**
   - Alchemy (v2.0, 2025-06-27): "solely for your internal business purposes", no resale, no automated
     downloading or scraping, no competing products. Do a few `eth_call`s an hour that feed a published oracle
     value fall within that? The same question for Infura, QuickNode and any other provider.
   - Helios: its licence, and the terms of the RPC it verifies against.
   - Until answered: Ethereum from each member's own node only.
2. **Publishing derived prices.**
   - The committee publishes Uniswap TWAPs computed from public chain state: the oracle API, the explorer, and the
     wallet and site labelled "Uniswap TWAP / spot". Is there any right in such data (database rights in the EU,
     terms of the pools' front ends) that needs a licence or an attribution?
   - Is it a "benchmark" under the EU Benchmarks Regulation (BMR) or a similar rule once markets settle on it, and
     what follows (administrator, methodology publication)?
3. **ECB forex.** Is "Source: ECB statistics" next to each rate enough? The ECB says the reference rates are for
   information only, and its statistics "must not be modified": may we round them, or store them as integers × 1000?
   May markets settle on them, given the information-only purpose?
4. **Chainlink.** Read chain.link/terms. May a Chainlink feed be used as a private cross-check, or as an input that
   never enters the committed value?
5. **The testnet today.** It shows and commits CEX prices (Coinbase, Binance, CoinGecko, Twelve Data, Yahoo), with
   no value at stake. Is that acceptable as is, or should the testnet move to the same sources as mainnet now?
6. **The markets themselves** (outside the data question, but for the same review): whether Up/Down markets on
   prices are betting or financial instruments in the jurisdictions the service is offered in, what that requires,
   and which users must be excluded.
   Within this question: **publishing the market's chance** (the implied probability from the bets) on the site and
   in the wallet: whether it counts as a forecast, advice or promotion, and what wording it needs. The planned label
   is "Market's chance", "from how participants have bet so far, not our forecast", shown only above a minimum pool.
7. **Attribution in the product:** the exact source lines the wallet, the site and the explorer must show for each
   ticker.

## For the review
1. For each source we keep: the licence, its scope (display, redistribution, derived data, benchmark use), the price,
   and the attribution text.
2. Attribution: the wallet, the site and the explorer show the source line of each ticker, e.g. "Source: ECB
   statistics".
3. The committee (docs/ORACLE-HARDENING.md (a)): every member needs its own licence for the sources it reads, or the
   licence must cover all members.

Sources:
- [Coinbase Market Data Terms](https://Www.coinbase.com/legal/market_data)
- [CoinGecko API Terms of Service](https://Coingecko.com/en/api_terms)
- [Binance API: review, pricing and terms (cryptomarkets.tools)](https://cryptomarkets.tools/tools/binance-api)
- [Binance Vision Terms of Use](https://data.binance.vision/Binance_Vision-Terms_of_Use.pdf)
- [ESCB statistics reuse terms (Bundesbank)](https://www.bundesbank.de/en/homepage/user-information/terms-of-use-regarding-the-reuse-of-escb-statistics-621188)
- [ExchangeRate-API open access endpoint](https://www.exchangerate-api.com/docs/free)
- [Twelve Data: commercial and personal usage](https://support.twelvedata.com/en/articles/5332349-commercial-and-personal-usage)
- [yfinance (Yahoo Finance, personal use)](https://github.com/ranaroussi/yfinance)
