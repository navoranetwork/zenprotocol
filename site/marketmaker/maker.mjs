// Market maker for the ZenDex (testnet): keeps several sell-ZP and buy-ZP orders open around a reference price (levels,
// site/marketmaker/levels.mjs), so the Dex has liquidity and the order book has depth.
//   ask level i: gives ZP, wants zUSDC at  price x (1 + spread + i x step)
//   bid level i: gives zUSDC, wants ZP at  price x (1 - spread - i x step)
// An order that drifted more than MM_REQUOTE_BPS from its nearest level is cancelled and that level re-made; a level
// whose order was taken is re-made. When the price moves by one step, only the level that fell off the end changes.
// Prices are USD per 1 ZP. 1 ZP = 1e8 kalapas, zUSDC has 6 decimals.
//
// Environment:
//   MM_NODE (http://127.0.0.1:31567)  MM_PASSWORD  MM_SIGN (a key of the node wallet, so proceeds show in the wallet; not the
//               main key m/44'/258'/0'/0/0 when a bridge uses that wallet: scripts/v1/mm-key.mjs makes one)
//   MM_DEX      Dex contract address (ctzn1...)       MM_ASSET  zUSDC asset id (hex)
//   MM_PRICE    fixed reference price in USD per ZP (default 0.10)
//   MM_ORACLE   oracle service url + ticker, e.g. http://127.0.0.1:8085/ZPUSD : takes the price from the latest round instead (falls back to MM_PRICE)
//   MM_LEVELS (3 per side)  MM_STEP_BPS (50 = 0.5% between levels)  MM_SPREAD_BPS (100 = 1%: the inner level's distance from the price)
//   MM_REQUOTE_BPS (50, at most half the step)  MM_SIZE_ZP (ZP per order, 100; funds needed: levels x size on each side)  MM_INTERVAL (30 s)
//   MM_MAX_TX (6)  at most this many Make/Cancel per cycle, MM_TX_PAUSE (3 s) between them: the node wallet spends its own
//               unconfirmed change, and a long chain of those in one block is not tested
//   MM_EXPLORER (http://127.0.0.1:11581/explorer/api)   MM_ZO (command that runs zen-oracle, for building message bodies)
//   MM_WAIT (1800 s)  how long a Make/Cancel is assumed to be on its way: the index trails the node by about 10 blocks, so a new order shows up in it only after that
//   MM_DRY=1    only print what it would do
//   MM_CANCEL_ALL=1  cancel every open order of this key (each copy), print what was sent and exit; stop the service first
import { execFileSync } from 'node:child_process';
import { plan, impliedPrice, sideOf } from './levels.mjs';

const env = (k, d) => process.env[k] ?? d;
const NODE = env('MM_NODE', 'http://127.0.0.1:31567'), PW = env('MM_PASSWORD', 'testnet'), SIGN = env('MM_SIGN', "m/44'/258'/0'/0/0");
const DEX = env('MM_DEX', ''), USDC = env('MM_ASSET', ''), EXPLORER = env('MM_EXPLORER', 'http://127.0.0.1:11581/explorer/api');
const FIXED = Number(env('MM_PRICE', '0.10')), ORACLE = env('MM_ORACLE', '');
const SPREAD = Number(env('MM_SPREAD_BPS', '100')) / 1e4;
const SIZE = Number(env('MM_SIZE_ZP', '100')), EVERY = Number(env('MM_INTERVAL', '30')) * 1000, DRY = env('MM_DRY', '') === '1';
const LEVELS = Math.max(1, Math.floor(Number(env('MM_LEVELS', '3')))), STEP = Number(env('MM_STEP_BPS', '50')) / 1e4;
const REQUOTE = Math.min(Number(env('MM_REQUOTE_BPS', '50')) / 1e4, LEVELS > 1 ? STEP / 2 : Infinity);   // with levels: at most half a step, so an order is never between two levels
const MAX_TX = Math.max(1, Number(env('MM_MAX_TX', '6'))), PAUSE = Number(env('MM_TX_PAUSE', '3')) * 1000;
const ZO = env('MM_ZO', 'dotnet /app/zen-oracle.dll').split(' ');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function node(path, body) {
  const r = await fetch(NODE + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const t = await r.text(); try { return JSON.parse(t); } catch { return t; }
}
const zoBody = specs => execFileSync(ZO[0], [...ZO.slice(1), 'body', ...specs], { encoding: 'utf8' }).trim();
const orderSpecs = o => [`UnderlyingAsset:s=${o.underAsset}`, `UnderlyingAmount:u=${o.underAmount}`, `PairAsset:s=${o.pairAsset}`, `OrderTotal:u=${o.pairTotal}`, `MakerPubKey:k=${o.maker}`];

async function execute(command, o, spends) {
  if (DRY) { log('DRY', command, JSON.stringify(o)); return 'dry'; }
  const r = await node('/wallet/contract/execute', { address: DEX, command, messageBody: zoBody(orderSpecs(o)), options: { sign: SIGN, returnAddress: false }, spends, password: PW });
  if (typeof r !== 'string' || !/^"?[0-9a-f]{64}"?$/.test(r.trim())) throw new Error(`${command}: ${JSON.stringify(r).slice(0, 200)}`);
  return r.replace(/"/g, '').trim();
}

async function referencePrice() {
  if (ORACLE) {
    try {
      const i = ORACLE.lastIndexOf('/'), url = ORACLE.slice(0, i), ticker = ORACLE.slice(i + 1);
      const r = await (await fetch(url + '/rounds/latest')).json();
      const tk = r.tickers ?? r.Tickers, vs = r.values ?? r.Values, j = tk?.indexOf(ticker);
      if (j >= 0 && Number(vs[j]) > 0) return Number(vs[j]);
    } catch (e) { log('oracle price unavailable:', e.message); }
  }
  return FIXED;
}
const balance = async asset => (await node('/wallet/balance')).filter?.(b => b.asset === asset).reduce((s, b) => s + b.balance, 0) ?? 0;

// what we have open now: the explorer's rows whose maker is our key (amounts there are what is left after partial fills), one entry per
// distinct order, with the number of identical copies the Dex still holds (read live from the node: the index trails it by ~10 blocks)
async function myOrders(pk) {
  const r = await (await fetch(EXPLORER + '/dex/orders')).json();
  const held = await node('/addressdb/balance', { addresses: [DEX] });
  const units = a => (Array.isArray(held) ? held : []).filter(x => x.asset === a).reduce((n, x) => n + Number(x.balance), 0);
  const seen = new Map();
  for (const o of (r.orders ?? []).filter(o => (o.maker ?? '').toLowerCase() === pk)) {
    if (seen.has(o.order_asset)) continue;
    const n = units(o.order_asset);
    if (n > 0) seen.set(o.order_asset, { id: o.order_asset, underAsset: o.under_asset, underAmount: o.under_amount, pairAsset: o.pair_asset, pairTotal: o.pair_total, maker: pk, units: n });
  }
  return [...seen.values()];
}
const pending = {};          // key -> time of a Make (ask0, bid2, …) or Cancel (c:<order asset>) not yet seen: do not repeat it while it waits to be mined
const WAIT = Number(env('MM_WAIT', '1800')) * 1000, CWAIT = 240000;   // a Make is seen in the index only after ~10 blocks; a Cancel shows in the node's balance within a block or two
const waiting = k => Date.now() - (pending[k] ?? 0) < (k.startsWith('c:') ? CWAIT : WAIT);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function cycle(pk) {
  const price = await referencePrice();
  const open = await myOrders(pk);
  const p = plan(price, open, { levels: LEVELS, spread: SPREAD, step: STEP, requote: REQUOTE });
  for (const { side, level } of p.kept) delete pending[side + level];                // seen: no longer pending
  for (const k of Object.keys(pending)) if (k.startsWith('c:') && !p.cancels.some(o => 'c:' + o.id === k)) delete pending[k];   // done, or no longer to cancel
  let sent = 0;
  const send = async (command, o, spends) => { if (sent++) await sleep(PAUSE); return execute(command, o, spends); };
  const busy = { ask: false, bid: false };                                          // a side with a cancel on its way makes nothing: its funds come back first
  for (const o of p.cancels) {
    const side = sideOf(o); busy[side] = true;
    if (waiting('c:' + o.id) || sent >= MAX_TX) continue;
    pending['c:' + o.id] = Date.now();
    log(`cancel ${side} at ${impliedPrice(o).toFixed(5)}${o.units > 1 ? ` (copy 1 of ${o.units})` : ''}:`, await send('Cancel', o, []));
  }
  const free = { '00': await balance('00') - 1e6, [USDC]: await balance(USDC) };    // ZP keeps 0.01 for fees
  const short = new Set();
  for (const m of p.makes) {
    if (busy[m.side] || waiting(m.side + m.level) || sent >= MAX_TX) continue;
    const o = m.side === 'ask'
      ? { underAsset: '00', underAmount: Math.round(SIZE * 1e8), pairAsset: USDC, pairTotal: Math.round(SIZE * m.price * 1e6), maker: pk }
      : { underAsset: USDC, underAmount: Math.round(SIZE * m.price * 1e6), pairAsset: '00', pairTotal: Math.round(SIZE * 1e8), maker: pk };
    if (free[o.underAsset] < o.underAmount) { short.add(m.side); continue; }
    free[o.underAsset] -= o.underAmount;
    pending[m.side + m.level] = Date.now();
    log(`make ${m.side} level ${m.level}: ${m.side === 'ask' ? 'sell' : 'buy'} ${SIZE} ZP at ${m.price.toFixed(5)} zUSDC:`,
      await send('Make', o, [{ asset: o.underAsset, amount: o.underAmount }]));
  }
  for (const side of short) log(`not enough ${side === 'ask' ? 'ZP' : 'zUSDC'} for every ${side} level (${LEVELS} x ${SIZE} ZP)`);
}

if (!DEX || !USDC) { console.error('MM_DEX and MM_ASSET are required'); process.exit(1); }
// the node wallet's main key (m/44'/258'/0'/0/0) is the bridge's ZP address: a Take pays the maker's key, and the bridge
// would pay a linked taker's zUSDC out as USDC. Give the market maker its own key (scripts/v1/mm-key.mjs) unless no
// bridge runs on this wallet (MM_MAIN_KEY_OK=1).
if (SIGN === "m/44'/258'/0'/0/0" && env('MM_MAIN_KEY_OK', '') !== '1') {
  console.error("MM_SIGN is the node wallet's main key, which is the bridge's ZP address: run scripts/v1/mm-key.mjs and set MM_SIGN (or MM_MAIN_KEY_OK=1 when no bridge uses this wallet)");
  process.exit(1);
}
const pk = String(await node('/wallet/publickey', { path: SIGN, password: PW })).replace(/"/g, '').toLowerCase();
log(`market maker: key ${pk.slice(0, 12)}…, ${LEVELS} levels per side of ${SIZE} ZP, spread ${SPREAD * 1e4} bps, step ${STEP * 1e4} bps${DRY ? ', DRY RUN' : ''}`);
if (env('MM_CANCEL_ALL', '') === '1') {
  const open = await myOrders(pk);
  log(`cancel all: ${open.length} open order(s)` + (open.length ? '' : ' (orders made in the last ~10 blocks are not in the index yet)'));
  for (const o of open) for (let i = 0; i < o.units; i++) {
    log('cancel', o.underAsset === '00' ? 'ask' : 'bid', 'at', impliedPrice(o).toFixed(5), `copy ${i + 1}/${o.units}:`, await execute('Cancel', o, []));
    await new Promise(r => setTimeout(r, 5000));
  }
  log('done; run again after a block or two: it should find no open orders');
  process.exit(0);
}
for (;;) {
  try { await cycle(pk); } catch (e) { log('cycle failed:', e.message); }
  await new Promise(r => setTimeout(r, EVERY));
}
