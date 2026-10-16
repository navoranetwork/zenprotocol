// The market service for FixedPayout V1 (docs/BETS.md), next to the oracle. Each minute it:
//   1. opens markets: for each ticker and the next close (BETS_CLOSE_UTC, default 22:00 UTC, at least 12 h ahead;
//      stocks, gold and FX only on weekdays), one market per line: the oracle's latest value moved by each of
//      BETS_OFFSETS (0, ±1 %, ±3 %), rounded to 3 digits. The lines of a ticker and close are set once;
//   2. quotes every open market on the Dex: Up and Down, a bid and an ask each, around the fair price of Up
//      (N(d2) from the live price, the line, the time to the close and BETS_VOL of the ticker). The live price of BTC
//      and ETH is read each minute from Coinbase, Binance and CoinGecko (the median); other tickers use the latest
//      round. The spread is BETS_SPREAD, wider when the price moved fast in the last 5 minutes, near the close, or
//      with one source (core.mjs spreadFor). The most mispriced orders are cancelled first.
//      An order more than BETS_MOVE from its target, or with less than a quarter of BETS_QUOTE left, is cancelled and
//      made again; a taken one is made again. It stops
//      quoting (cancels its orders) BETS_STOP_MIN before the close, or when the latest round is older than
//      BETS_STALE_MIN. Tokens for the asks come from Issue (BETS_QUOTE at a time, at most BETS_MAX_ISSUE per market);
//      the bids together lock at most BETS_BID_BUDGET of the collateral;
//   3. settles each closed market: the oracle's round stamped with the close -> the Oracle's Attest to the contract ->
//      once the attestation token is in the contract's wallet, Settle with the winner;
//   4. voids a market with no Settle 24 hours after its close;
//   5. redeems the tokens it holds of a settled market's winner (both sides of a void one).
// A market's state is read from the chain (the markers the contract holds, our orders from the explorer), so a restart
// loses nothing; markets.json keeps the list and what was sent. GET /markets (BETS_LISTEN, 127.0.0.1:8097) lists them.
//
// Environment:
//   BETS_NODE (http://127.0.0.1:31567)  BETS_PASSWORD  BETS_SIGN (the key that issues and quotes; not the bridge's
//               m/44'/258'/0'/0/0)   BETS_CONTRACT (FixedPayout address ctzn1…)  BETS_ID (its contract id, 72 hex)
//   BETS_ORACLE (http://127.0.0.1:8085)  BETS_ORACLE_ADDRESS (the V1 Oracle contract ctzn1…)  BETS_ORACLE_ID (72 hex)
//   BETS_ORACLE_KEY (the oracle's compressed public key)  BETS_COLLATERAL (the zUSDC asset id)  BETS_DEX (the Dex ctzn1…)
//   BETS_EXPLORER (http://127.0.0.1:11581/explorer/api: our open Dex orders, with the newest blocks and the mempool)
//   BETS_TICKERS (BTC,ETH,EUR,XAU)  BETS_DAILY (SPY,AAPL,MSFT,XAU: weekdays only)  BETS_CLOSE_UTC (22)
//   BETS_OFFSETS (0,-0.01,0.01,-0.03,0.03)  BETS_VOL (annual volatility per ticker, TICKER:0.5,…; defaults below)
//   BETS_SPREAD (0.06: bid to ask)  BETS_MOVE (0.02: requote when an order is this far from its target)
//   BETS_QUOTE (10000000 = 10 tokens per order)  BETS_MAX_ISSUE (30000000 per market)  BETS_BID_BUDGET (30000000)
//   BETS_LIVE (1)  BETS_LIVE_STALE_S (180: no live price this long -> no quotes on a live ticker)
//   BETS_STOP_MIN (20)  BETS_STALE_MIN (150)  BETS_SEEN_MIN (20: our own Makes count as open this long until listed)  BETS_MAX_TX (20 per cycle)  BETS_TX_PAUSE (1 s)
//   BETS_DATA (./data)  BETS_LISTEN (127.0.0.1:8097)  BETS_INTERVAL (60 s)  BETS_DRY=1 (only print what it would send)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { refuseTestWallet } from '../known-wallets.mjs';
import { tokens, linesOf, priceOf, nextCloses, isWeekday, stateOf, winnerOf, attestSubtype, bodies, fairUp, quotesFor, planQuotes, spreadFor, medianOf } from './core.mjs';

const env = (k, d) => process.env[k] ?? d;
const NODE = env('BETS_NODE', 'http://127.0.0.1:31567'), PW = env('BETS_PASSWORD', 'testnet'), SIGN = env('BETS_SIGN', '');
const CONTRACT = env('BETS_CONTRACT', ''), ID = env('BETS_ID', ''), DEX = env('BETS_DEX', '');
const ORACLE = env('BETS_ORACLE', 'http://127.0.0.1:8085').replace(/\/$/, ''), ORACLE_ADDRESS = env('BETS_ORACLE_ADDRESS', ''), ORACLE_ID = env('BETS_ORACLE_ID', '');
const ORACLE_KEY = env('BETS_ORACLE_KEY', ''), COLLATERAL = env('BETS_COLLATERAL', '');
const EXPLORER = env('BETS_EXPLORER', 'http://127.0.0.1:11581/explorer/api').replace(/\/$/, '');
const list = s => s.split(',').map(x => x.trim()).filter(Boolean);
const TICKERS = list(env('BETS_TICKERS', 'BTC,ETH,EUR,XAU')), DAILY = new Set(list(env('BETS_DAILY', 'SPY,AAPL,MSFT,XAU')));
const CLOSE_UTC = Number(env('BETS_CLOSE_UTC', '22')), OFFSETS = list(env('BETS_OFFSETS', '0,-0.01,0.01,-0.03,0.03')).map(Number);
const VOL = { BTC: 0.55, ETH: 0.75, EUR: 0.08, GBP: 0.09, JPY: 0.1, CHF: 0.08, AUD: 0.1, XAU: 0.16, SPY: 0.18, AAPL: 0.28, MSFT: 0.25,
  ...Object.fromEntries(list(env('BETS_VOL', '')).map(s => s.split(':')).map(([t, v]) => [t, Number(v)])) };
const SPREAD = Number(env('BETS_SPREAD', '0.06')), MOVE = Number(env('BETS_MOVE', '0.02'));
const QUOTE = Number(env('BETS_QUOTE', '10000000')), MAX_ISSUE = Number(env('BETS_MAX_ISSUE', '30000000')), BID_BUDGET = Number(env('BETS_BID_BUDGET', '30000000'));
const STOP = Number(env('BETS_STOP_MIN', '20')) * 60000, STALE = Number(env('BETS_STALE_MIN', '150')) * 60000;
const MAX_TX = Number(env('BETS_MAX_TX', '20')), PAUSE = Number(env('BETS_TX_PAUSE', '1')) * 1000;
const DATA = env('BETS_DATA', './data'), [HOST, PORT] = env('BETS_LISTEN', '127.0.0.1:8097').split(':');
const EVERY = Number(env('BETS_INTERVAL', '60')) * 1000, DRY = env('BETS_DRY', '') === '1', GRACE = 86400000;
const log = (...a) => console.log(new Date().toISOString().slice(0, 19), ...a);

for (const [k, v] of Object.entries({ BETS_SIGN: SIGN, BETS_CONTRACT: CONTRACT, BETS_ID: ID, BETS_DEX: DEX, BETS_ORACLE_ADDRESS: ORACLE_ADDRESS, BETS_ORACLE_ID: ORACLE_ID, BETS_ORACLE_KEY: ORACLE_KEY, BETS_COLLATERAL: COLLATERAL }))
  if (!v) { console.error(`${k} is required`); process.exit(1); }
if (SIGN === "m/44'/258'/0'/0/0") { console.error("BETS_SIGN is the node wallet's main key, the bridge's ZP address: use a key of its own (scripts/v1/mm-key.mjs makes one)"); process.exit(1); }

fs.mkdirSync(DATA, { recursive: true });
const FILE = path.join(DATA, 'markets.json');
let markets = (() => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; } })();
const save = () => { fs.writeFileSync(FILE + '.tmp', JSON.stringify(markets, null, 1)); fs.renameSync(FILE + '.tmp', FILE); };

async function node(p, body) {
  const r = await fetch(NODE + p, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(900000) });
  const t = await r.text(); try { return JSON.parse(t); } catch { return t; }
}
let sent = 0;
async function execute(address, command, messageBody, spends = [], sign = null) {
  if (sent++) await new Promise(r => setTimeout(r, PAUSE));
  if (DRY) { log('DRY', command, address.slice(0, 16), messageBody.slice(0, 40) + '…', JSON.stringify(spends)); return 'dry'; }
  const r = await node('/wallet/contract/execute', { address, command, messageBody, options: { returnAddress: false, ...(sign ? { sign } : {}) }, spends, password: PW });
  if (typeof r !== 'string' || !/^"?[0-9a-f]{64}"?$/.test(r.trim())) throw new Error(`${command}: ${JSON.stringify(r).slice(0, 300)}`);
  return r.replace(/"/g, '').trim();
}
const held = async address => new Set((await node('/addressdb/balance', { addresses: [address] }) || []).filter(x => Number(x.balance) > 0).map(x => x.asset));
const walletBalances = async () => { const b = new Map(); for (const x of (await node('/wallet/balance')) || []) b.set(x.asset, (b.get(x.asset) || 0) + Number(x.balance)); return b; };
const latestRound = async () => { const r = await (await fetch(ORACLE + '/rounds/latest')).json(); const T = r.tickers ?? r.Tickers, V = r.values ?? r.Values;
  return { ts: Number(r.timestamp ?? r.Timestamp), values: Object.fromEntries(T.map((t, i) => [t, Number(V[i])])) }; };
// our Makes of the last BETS_SEEN_MIN (20) minutes: counted as open orders until the explorer shows them, so a slot is not
// made twice while its order travels (seen on the testnet 2026-10-16: a second Issue and copies of each order a minute later)
const SEEN = Number(env('BETS_SEEN_MIN', '20')) * 60000;
const RECENT = path.join(DATA, 'recent-makes.json');        // kept across restarts: a restart must not make them again
let recentCancels = [];
let recentMakes = (() => { try { return JSON.parse(fs.readFileSync(RECENT, 'utf8')); } catch { return []; } })();
const saveRecent = () => { try { fs.writeFileSync(RECENT, JSON.stringify(recentMakes)); } catch { /* best effort */ } };
const sameOrder = (a, b) => a.under_asset === b.under_asset && String(a.under_amount) === String(b.under_amount) && a.pair_asset === b.pair_asset && String(a.pair_total) === String(b.pair_total);
const keyOf = m => `${m.ticker}-${m.close}-${m.price}`;
const fmt = n => (n / 1e6).toFixed(2);

// 1: open the lines of each ticker for the next close, once
async function open(now) {
  const { values } = await latestRound();
  for (const close of nextCloses(now, CLOSE_UTC, 1)) for (const ticker of TICKERS) {
    if (DAILY.has(ticker) && !isWeekday(close)) continue;
    if (!(values[ticker] > 0) || markets.some(x => x.ticker === ticker && x.close === close && x.lineSet)) continue;
    for (const line of linesOf(values[ticker], OFFSETS)) {
      const m = { ticker, line, price: priceOf(line), close, oraclePubKey: ORACLE_KEY, oracleId: ORACLE_ID, collateral: COLLATERAL, lineSet: true, issued: 0 };
      if (markets.some(x => keyOf(x) === keyOf(m))) { markets.find(x => keyOf(x) === keyOf(m)).lineSet = true; continue; }
      m.tokens = tokens(ID, m); m.opened = now;
      markets.push(m);
      log(`open ${ticker} >= ${line} at ${new Date(close).toISOString()}`);
    }
    save();
  }
}

// the live price of the crypto tickers, about every minute, from the same exchanges the oracle reads; the hourly round
// stays for Settle only. A ticker without a live source (FX, gold, stocks) is priced from the latest round.
const LIVE = { BTC: ['BTC-USD', 'BTCUSDT', 'bitcoin'], ETH: ['ETH-USD', 'ETHUSDT', 'ethereum'] };
const LIVE_ON = env('BETS_LIVE', '1') === '1', LIVE_STALE = Number(env('BETS_LIVE_STALE_S', '180')) * 1000;
const history = {}, noLive = {};                                      // ticker -> [{ at, p }] of the last 15 minutes
const getJson = async url => { try { const r = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'zp-bets' } }); return r.ok ? await r.json() : null; } catch { return null; } };
async function livePrices(now) {
  const want = TICKERS.filter(t => LIVE[t]); if (!LIVE_ON || !want.length) return;
  const gecko = await getJson(`https://api.coingecko.com/api/v3/simple/price?ids=${want.map(t => LIVE[t][2]).join(',')}&vs_currencies=usd`);
  for (const t of want) {
    const [cb, bn, cg] = LIVE[t];
    const got = [Number((await getJson(`https://api.coinbase.com/v2/prices/${cb}/spot`))?.data?.amount),
      Number((await getJson(`https://api.binance.com/api/v3/ticker/price?symbol=${bn}`))?.price), Number(gecko?.[cg]?.usd)].filter(x => x > 0);
    const p = medianOf(got);
    if (!p) { if (!(now - (noLive[t] || 0) < 600000)) { noLive[t] = now; log(`no live price for ${t} (Coinbase, Binance, CoinGecko): its markets are not quoted`); } continue; }
    history[t] = [...(history[t] || []).filter(h => now - h.at < 900000), { at: now, p, n: got.length }];
  }
}

// 2: quote every open market around its fair price
async function quote(now, makerKey) {
  const { ts, values } = await latestRound();
  await livePrices(now);
  const listed = ((await (await fetch(EXPLORER + '/dex/orders?pending=1')).json()).orders || []).filter(o => (o.maker || '').toLowerCase() === makerKey);
  recentMakes = recentMakes.filter(r => now - r.at < SEEN && !listed.some(o => sameOrder(o, r))); saveRecent();
  // our Cancels of the last 10 minutes: the order counts as being cancelled (its slot waits) until it leaves the list
  recentCancels = recentCancels.filter(r => now - r.at < 600000 && listed.some(o => sameOrder(o, r)));
  const mineAll = [...listed.map(o => recentCancels.some(r => sameOrder(o, r)) ? { ...o, pendingCancel: o.pendingCancel || 'ours' } : o),
    ...recentMakes.map(r => ({ ...r, pending: true }))];
  const bal = await walletBalances();
  const has = a => bal.get(a) || 0, take = (a, n) => bal.set(a, has(a) - n), give = (a, n) => bal.set(a, has(a) + n);
  let bidLocked = mineAll.filter(o => o.under_asset === COLLATERAL).reduce((s, o) => s + Number(o.under_amount), 0);
  const short = new Set();
  // the plans of every market first, so the most mispriced orders are cancelled first, before any Make
  const cancels = [], makes = [];
  for (const m of markets) {
    const t = m.tokens, mine = mineAll.filter(o => [o.under_asset, o.pair_asset].some(a => a === t.bull || a === t.bear));
    const h = history[m.ticker], last = h?.[h.length - 1];
    const liveSpot = LIVE[m.ticker] && LIVE_ON ? (last && now - last.at < LIVE_STALE ? last.p : null) : undefined;
    const spot = liveSpot === undefined ? (now - ts < STALE ? values[m.ticker] : null) : liveSpot;   // a live ticker never falls back to the round
    const live = now < m.close - STOP && spot > 0 && !m.result;
    const vol = VOL[m.ticker] ?? 0.3;
    m.fair = live ? fairUp(spot, m.line, m.close - now, vol) : null; m.spot = live ? spot : null;
    const old = h?.find(x => now - x.at >= 240000 && now - x.at <= 600000);            // the price about 5 minutes ago
    m.spread = live ? spreadFor(SPREAD, { vol, move: old ? Math.log(spot / old.p) : null, minutes: old ? (now - old.at) / 60000 : 5, msLeft: m.close - now, sources: last?.n ?? 3 }) : null;
    m.quoting = live;
    if (!live && !mine.length) continue;
    const plan = planQuotes(live ? quotesFor(m.fair, { spread: m.spread }) : null, mine, { bull: t.bull, bear: t.bear, collateral: COLLATERAL, move: MOVE, minSize: QUOTE / 4 });
    const want = live ? quotesFor(m.fair, { spread: m.spread }) : null;
    for (const o of plan.cancels) {                          // how cheap the order is now: an ask below the target, a bid above it
      const px = o.side === 'ask' ? o.pair_total / o.under_amount : o.under_amount / o.pair_total, target = want?.[o.name]?.[o.side];
      cancels.push({ m, o, px, danger: target == null ? 1 : o.side === 'ask' ? target - px : px - target });
    }
    for (const k of plan.makes) makes.push({ m, k });
  }
  cancels.sort((x, y) => y.danger - x.danger);
  for (const { m, o, px } of cancels) {
    if (sent >= MAX_TX) return;
    recentCancels.push({ under_asset: o.under_asset, under_amount: o.under_amount, pair_asset: o.pair_asset, pair_total: o.pair_total, at: now });
    try { log(`cancel ${keyOf(m)} ${o.name} ${o.side} at ${px.toFixed(2)} (fair Up ${m.fair == null ? '-' : m.fair.toFixed(3)}) -> ${await execute(DEX, 'Cancel', bodies.make(o.under_asset, o.under_amount, o.pair_asset, o.pair_total, o.maker), [], SIGN)}`); }
    catch (e) { log(`cancel ${keyOf(m)} ${o.name} ${o.side}: ${e.message.slice(0, 120)}`); }   // gone already (taken or cancelled): next order
  }
  for (const { m, k } of makes) {
    if (sent >= MAX_TX) return;
    const t = m.tokens;
    try {
      if (k.side === 'ask') {
        if (has(k.token) < QUOTE) {                                        // mint a pair: QUOTE more Up and Down
          if ((m.issued ?? 0) + QUOTE > MAX_ISSUE || has(COLLATERAL) < QUOTE) { if (has(k.token) < QUOTE / 10) { short.add(`tokens for ${keyOf(m)}`); continue; } }
          else {
            m.issueTx = await execute(CONTRACT, 'Issue', bodies.issue(m), [{ asset: COLLATERAL, amount: QUOTE }], SIGN);
            m.issued = (m.issued ?? 0) + QUOTE; take(COLLATERAL, QUOTE); give(t.bull, QUOTE); give(t.bear, QUOTE); save();
            log(`issue ${keyOf(m)}: ${fmt(QUOTE)} pairs -> ${m.issueTx}`);
            if (sent >= MAX_TX) return;
          }
        }
        const size = Math.min(QUOTE, has(k.token)), total = Math.round(size * k.price);
        const tx = await execute(DEX, 'Make', bodies.make(k.token, size, COLLATERAL, total, makerKey), [{ asset: k.token, amount: size }], SIGN);
        take(k.token, size); recentMakes.push({ under_asset: k.token, under_amount: String(size), pair_asset: COLLATERAL, pair_total: String(total), maker: makerKey, at: now, tx }); saveRecent();
        log(`ask ${keyOf(m)} ${k.name}: ${fmt(size)} at ${k.price.toFixed(2)} (fair Up ${m.fair.toFixed(3)}, spot ${m.spot}, spread ${m.spread.toFixed(2)}) -> ${tx}`);
      } else {
        const cost = Math.round(QUOTE * k.price);
        if (bidLocked + cost > BID_BUDGET || has(COLLATERAL) < cost) { short.add('collateral for bids'); continue; }
        const tx = await execute(DEX, 'Make', bodies.make(COLLATERAL, cost, k.token, QUOTE, makerKey), [{ asset: COLLATERAL, amount: cost }], SIGN);
        take(COLLATERAL, cost); bidLocked += cost;
        recentMakes.push({ under_asset: COLLATERAL, under_amount: String(cost), pair_asset: k.token, pair_total: String(QUOTE), maker: makerKey, at: now, tx }); saveRecent();
        log(`bid ${keyOf(m)} ${k.name}: ${fmt(QUOTE)} at ${k.price.toFixed(2)} (fair Up ${m.fair.toFixed(3)}, spot ${m.spot}, spread ${m.spread.toFixed(2)}) -> ${tx}`);
      }
    } catch (e) { log(`${k.side} ${keyOf(m)} ${k.name}: ${e.message.slice(0, 160)}`); }   // a refused call: the next slot
  }
  for (const s of short) log(`short of ${s}`);
}

// 3 + 4 + 5: settle, void and redeem, from what the contract holds
async function settle(now) {
  const inContract = await held(CONTRACT);
  const bal = await walletBalances();
  for (const m of markets) {
    const st = stateOf(m, inContract, now, GRACE);
    m.status = st.status; m.result = st.result;
    if (st.status === 'settled' || st.status === 'void') {
      const sides = st.status === 'void' ? [['Bull', m.tokens.bull], ['Bear', m.tokens.bear]] : st.result === 'bull' ? [['Bull', m.tokens.bull]] : [['Bear', m.tokens.bear]];
      for (const [pos, a] of sides) {
        const n = bal.get(a) || 0;
        if (!n || now - (m.redeemAt?.[pos] ?? 0) < 600000 || sent >= MAX_TX) continue;
        const tx = await execute(CONTRACT, 'Redeem', bodies.redeem(m, pos), [{ asset: a, amount: n }], SIGN);
        m.redeemAt = { ...(m.redeemAt || {}), [pos]: now }; log(`redeem ${keyOf(m)} ${pos} ${fmt(n)} -> ${tx}`);
      }
      continue;
    }
    if (st.status === 'voidable' && !m.voidTx) { m.voidTx = await execute(CONTRACT, 'Void', bodies.void(m)); log(`void ${keyOf(m)} -> ${m.voidTx}`); continue; }
    if (st.status !== 'closing' || m.settleTx) continue;
    const p = await (await fetch(`${ORACLE}/auditpath?ticker=${encodeURIComponent(m.ticker)}&timestamp=${m.close}`)).json().catch(() => null);
    if (!p || Number(p.timestamp) !== m.close) continue;                 // no round stamped with the close yet
    m.settlePrice = Number(p.value); m.settleValue = String(p.valueScaled);
    const att = ORACLE_ID + attestSubtype(p.root, m.close, ORACLE_KEY);
    if (!inContract.has(att)) {
      if (!m.attestTx) {
        const tx = await execute(ORACLE_ADDRESS, 'Attest', bodies.attest(p.root, m.close, ORACLE_KEY, ID)); log(`attest ${m.close} (${keyOf(m)}) -> ${tx}`);
        for (const x of markets) if (x.close === m.close) x.attestTx = tx;  // one attestation serves every market of this close
      }
      continue;                                                         // wait for the attestation token's block
    }
    const winner = winnerOf(m.price, p.valueScaled);
    m.settleTx = await execute(CONTRACT, 'Settle', bodies.settle(m, winner, p));
    log(`settle ${keyOf(m)}: ${m.ticker} = ${p.value}, ${winner} wins -> ${m.settleTx}`);
  }
  save();
}

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-cache');
  if (req.url.split('?')[0] !== '/markets') { res.statusCode = 404; return res.end('{"error":"unknown path"}'); }
  res.end(JSON.stringify({ contract: CONTRACT, contractId: ID, collateral: COLLATERAL, oracleId: ORACLE_ID, oraclePubKey: ORACLE_KEY, graceMs: GRACE,
    markets: markets.map(m => ({ ticker: m.ticker, line: m.line, price: m.price, close: m.close, status: m.status || 'open', result: m.result || null,
      settlePrice: m.settlePrice ?? null, fair: m.fair == null ? null : Number(m.fair.toFixed(4)), quoting: !!m.quoting, spot: m.spot ?? null, spread: m.spread == null ? null : Number(m.spread.toFixed(3)), bull: m.tokens.bull, bear: m.tokens.bear,
      event: { OraclePubKey: m.oraclePubKey, OracleContractId: m.oracleId, Ticker: m.ticker, Price: m.price, Start: m.close, Expiry: m.close, Collateral: m.collateral } })) }));
});
// listen first: if the port is taken (another bets, e.g. a dry run left behind), stop before sending anything
await new Promise((ok, fail) => server.once('error', fail).listen(Number(PORT), HOST, ok)).catch(e => { console.error(`cannot listen on ${HOST}:${PORT}: ${e.code}; is another bets running (docker ps)?`); process.exit(1); });
log(`bets on ${HOST}:${PORT}`);

await refuseTestWallet(NODE, PW, 'bets');
const makerKey = String(await node('/wallet/publickey', { path: SIGN, password: PW })).replace(/"/g, '').toLowerCase();
log(`markets for ${CONTRACT} (${TICKERS.join(', ')}; lines ${OFFSETS.join(' ')}), close ${CLOSE_UTC}:00 UTC, quote ${fmt(QUOTE)} spread ${SPREAD} move ${MOVE}, key ${makerKey.slice(0, 12)}…${DRY ? ', DRY' : ''}`);
for (;;) {
  const now = Date.now(); sent = 0;
  try { await open(now); } catch (e) { log('open failed:', e.message); }
  try { await settle(now); } catch (e) { log('settle failed:', e.message); }
  try { await quote(now, makerKey); } catch (e) { log('quote failed:', e.message); }
  save();
  await new Promise(r => setTimeout(r, EVERY));
}
