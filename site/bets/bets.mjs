// The market service for FixedPayout V1 (docs/BETS.md), next to the oracle. Each minute it:
//   1. opens markets: one per ticker for the next close (BETS_CLOSE_UTC, default 22:00 UTC, at least 12 h ahead; stocks
//      and gold only on weekdays), the line at the oracle's latest value rounded to 3 digits;
//   2. seeds each new market: Issue BETS_SEED of the collateral (N Up + N Down to the seeding key), then offers both
//      sides on the Dex at BETS_ODDS each (0.55 by default: the two sum to 1.10);
//   3. settles each closed market: the oracle's round stamped with the close -> the Oracle's Attest to the contract ->
//      once the attestation token is in the contract's wallet, Settle with the winner;
//   4. voids a market with no Settle 24 hours after its close.
// A market's state is read from the chain (the markers the contract holds), so a restart loses nothing; markets.json
// keeps the list and what was sent. GET /markets (BETS_LISTEN, 127.0.0.1:8097) lists them for the explorer API.
//
// Environment:
//   BETS_NODE (http://127.0.0.1:31567)  BETS_PASSWORD  BETS_SIGN (the key that issues and offers; not the bridge's
//               m/44'/258'/0'/0/0)   BETS_CONTRACT (FixedPayout address ctzn1…)  BETS_ID (its contract id, 72 hex)
//   BETS_ORACLE (http://127.0.0.1:8085)  BETS_ORACLE_ADDRESS (the V1 Oracle contract ctzn1…)  BETS_ORACLE_ID (72 hex)
//   BETS_ORACLE_KEY (the oracle's compressed public key)  BETS_COLLATERAL (the zUSDC asset id)  BETS_DEX (the Dex ctzn1…)
//   BETS_TICKERS (BTC,ETH,EUR,XAU)  BETS_DAILY (SPY,AAPL,MSFT,XAU: weekdays only)  BETS_CLOSE_UTC (22)
//   BETS_SEED (2000000 = 2 zUSDC per market)  BETS_ODDS (0.55)  BETS_DATA (./data)  BETS_LISTEN (127.0.0.1:8097)
//   BETS_INTERVAL (60 s)  BETS_DRY=1 (only print what it would send)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { tokens, lineOf, priceOf, nextCloses, isWeekday, stateOf, winnerOf, attestSubtype, bodies } from './core.mjs';

const env = (k, d) => process.env[k] ?? d;
const NODE = env('BETS_NODE', 'http://127.0.0.1:31567'), PW = env('BETS_PASSWORD', 'testnet'), SIGN = env('BETS_SIGN', '');
const CONTRACT = env('BETS_CONTRACT', ''), ID = env('BETS_ID', ''), DEX = env('BETS_DEX', '');
const ORACLE = env('BETS_ORACLE', 'http://127.0.0.1:8085').replace(/\/$/, ''), ORACLE_ADDRESS = env('BETS_ORACLE_ADDRESS', ''), ORACLE_ID = env('BETS_ORACLE_ID', '');
const ORACLE_KEY = env('BETS_ORACLE_KEY', ''), COLLATERAL = env('BETS_COLLATERAL', '');
const TICKERS = env('BETS_TICKERS', 'BTC,ETH,EUR,XAU').split(',').map(s => s.trim()).filter(Boolean);
const DAILY = new Set(env('BETS_DAILY', 'SPY,AAPL,MSFT,XAU').split(',').map(s => s.trim()));
const CLOSE_UTC = Number(env('BETS_CLOSE_UTC', '22')), SEED = Number(env('BETS_SEED', '2000000')), ODDS = Number(env('BETS_ODDS', '0.55'));
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
async function execute(address, command, messageBody, spends = [], sign = null) {
  if (DRY) { log('DRY', command, address.slice(0, 16), messageBody.slice(0, 40) + '…'); return 'dry'; }
  const r = await node('/wallet/contract/execute', { address, command, messageBody, options: { returnAddress: false, ...(sign ? { sign } : {}) }, spends, password: PW });
  if (typeof r !== 'string' || !/^"?[0-9a-f]{64}"?$/.test(r.trim())) throw new Error(`${command}: ${JSON.stringify(r).slice(0, 300)}`);
  return r.replace(/"/g, '').trim();
}
const held = async address => new Set((await node('/addressdb/balance', { addresses: [address] }) || []).filter(x => Number(x.balance) > 0).map(x => x.asset));
const walletHas = async (asset, amount) => (await node('/wallet/balance') || []).filter(b => b.asset === asset).reduce((s, b) => s + Number(b.balance), 0) >= amount;
const latestValues = async () => { const r = await (await fetch(ORACLE + '/rounds/latest')).json(); const T = r.tickers ?? r.Tickers, V = r.values ?? r.Values; return Object.fromEntries(T.map((t, i) => [t, Number(V[i])])); };
const keyOf = m => `${m.ticker}-${m.close}`;

// 1 + 2: open and seed
async function open(now, makerKey) {
  const values = await latestValues();
  for (const close of nextCloses(now, CLOSE_UTC, 1)) for (const ticker of TICKERS) {
    if (DAILY.has(ticker) && !isWeekday(close)) continue;
    const line = lineOf(values[ticker]); if (!line) continue;
    const m = { ticker, line, price: priceOf(line), close, oraclePubKey: ORACLE_KEY, oracleId: ORACLE_ID, collateral: COLLATERAL };
    if (markets.some(x => keyOf(x) === keyOf(m))) continue;
    m.tokens = tokens(ID, m);
    m.opened = now;
    markets.push(m); save();
    log(`open ${ticker} >= ${line} at ${new Date(close).toISOString()}`);
  }
  for (const m of markets.filter(m => !m.issueTx && m.close > now)) {
    if (!(await walletHas(COLLATERAL, SEED))) { log(`not enough collateral to seed ${keyOf(m)}`); continue; }
    m.issueTx = await execute(CONTRACT, 'Issue', bodies.issue(m), [{ asset: COLLATERAL, amount: SEED }], SIGN); save();
    log(`seed ${keyOf(m)}: Issue ${SEED} -> ${m.issueTx}`);
  }
  for (const m of markets.filter(m => m.issueTx && !m.offerTx && m.close > now)) {
    if (!(await walletHas(m.tokens.bull, SEED)) || !(await walletHas(m.tokens.bear, SEED))) continue;   // the Issue is not in a block yet
    const total = Math.round(SEED * ODDS);
    const a = await execute(DEX, 'Make', bodies.make(m.tokens.bull, SEED, COLLATERAL, total, makerKey), [{ asset: m.tokens.bull, amount: SEED }], SIGN);
    const b = await execute(DEX, 'Make', bodies.make(m.tokens.bear, SEED, COLLATERAL, total, makerKey), [{ asset: m.tokens.bear, amount: SEED }], SIGN);
    m.offerTx = [a, b]; save();
    log(`offer ${keyOf(m)}: Up and Down at ${ODDS} -> ${a}, ${b}`);
  }
}

// 3 + 4: settle and void, from what the contract holds
async function settle(now) {
  const inContract = await held(CONTRACT);
  for (const m of markets) {
    const st = stateOf(m, inContract, now, GRACE);
    m.status = st.status; m.result = st.result;
    if (st.status === 'voidable' && !m.voidTx) { m.voidTx = await execute(CONTRACT, 'Void', bodies.void(m)); log(`void ${keyOf(m)} -> ${m.voidTx}`); continue; }
    if (st.status !== 'closing' || m.settleTx) continue;
    const p = await (await fetch(`${ORACLE}/auditpath?ticker=${encodeURIComponent(m.ticker)}&timestamp=${m.close}`)).json().catch(() => null);
    if (!p || Number(p.timestamp) !== m.close) continue;                 // no round stamped with the close yet
    m.settlePrice = Number(p.value); m.settleValue = String(p.valueScaled);
    const att = ORACLE_ID + attestSubtype(p.root, m.close, ORACLE_KEY);
    if (!inContract.has(att)) {
      if (!m.attestTx) { m.attestTx = await execute(ORACLE_ADDRESS, 'Attest', bodies.attest(p.root, m.close, ORACLE_KEY, ID)); log(`attest ${keyOf(m)} -> ${m.attestTx}`); }
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
      settlePrice: m.settlePrice ?? null, bull: m.tokens.bull, bear: m.tokens.bear,
      event: { OraclePubKey: m.oraclePubKey, OracleContractId: m.oracleId, Ticker: m.ticker, Price: m.price, Start: m.close, Expiry: m.close, Collateral: m.collateral } })) }));
});
// listen first: if the port is taken (another bets, e.g. a dry run left behind), stop before sending anything
await new Promise((ok, fail) => server.once('error', fail).listen(Number(PORT), HOST, ok)).catch(e => { console.error(`cannot listen on ${HOST}:${PORT}: ${e.code}; is another bets running (docker ps)?`); process.exit(1); });
log(`bets on ${HOST}:${PORT}`);

const makerKey = String(await node('/wallet/publickey', { path: SIGN, password: PW })).replace(/"/g, '');
log(`markets for ${CONTRACT} (${TICKERS.join(', ')}), close ${CLOSE_UTC}:00 UTC, seed ${SEED}, odds ${ODDS}, key ${makerKey.slice(0, 12)}…${DRY ? ', DRY' : ''}`);
for (;;) {
  const now = Date.now();
  try { await open(now, makerKey); } catch (e) { log('open failed:', e.message); }
  try { await settle(now); } catch (e) { log('settle failed:', e.message); }
  await new Promise(r => setTimeout(r, EVERY));
}
