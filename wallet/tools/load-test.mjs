#!/usr/bin/env node
// Load test of a ZP node and its network: ZP transfers at rising rates, measured.
// The wallet first splits its ZP into many small outputs (one transfer each, so transfers never wait on each other),
// then sends one transfer back to itself every 60/rate seconds, step after step (default 1, 5, 20, 60 a minute,
// 30 minutes each). Every 15 s it records the tip, the mempool and the transactions of each new block.
// It stops by itself at --max-min, or early when the node stops answering, refuses most transfers, or the mempool
// passes --max-mempool. Results: <out>/load.csv (one line per transfer), <out>/blocks.csv, <out>/summary.json.
//
//   TESTNET_MNEMONIC="..." node tools/load-test.mjs [--node http://127.0.0.1:31567] [--rates 1,5,20,60] [--step-min 30]
//        [--max-min 150] [--outputs 800] [--unit 0.01] [--max-mempool 5000] [--out ./load-out] [--dry]
// Node 20+. On the testnet server (91.98.3.17), from ~/zenprotocol-testnet:
//   docker run -d --name zp-load --network host -v "$PWD:/r" -v "$HOME/zp-load:/out" -w /r/wallet -e TESTNET_MNEMONIC node:22-alpine \
//     sh -c "npm ci --no-audit --no-fund >/dev/null && node tools/load-test.mjs --out /out"
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { NodeClient } from '../src/node.js';
import { openWallet, discover, readState, publish, receiveAddress } from '../src/wallet.js';
import { buildTransaction, maturityFor, parseZP, formatZP } from '../src/tx.js';
import { decodeAddress } from '../src/keys.js';
import { hex, ZEN_ASSET } from '../src/serialize.js';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1]; };
const NODE = arg('node', 'http://127.0.0.1:31567'), NET = arg('net', 'test');
const RATES = arg('rates', '1,5,20,60').split(',').map(Number), STEP_MS = Number(arg('step-min', '30')) * 60000;
const MAX_MS = Number(arg('max-min', '150')) * 60000, OUTPUTS = Number(arg('outputs', '800')), UNIT = parseZP(arg('unit', '0.01'));
const MAX_MEMPOOL = Number(arg('max-mempool', '5000')), OUT = arg('out', './load-out'), DRY = process.argv.includes('--dry');
const phrase = process.env.TESTNET_MNEMONIC; if (!phrase) { console.error('Set TESTNET_MNEMONIC'); process.exit(2); }
if (RATES.some(r => !(r > 0 && r <= 600))) { console.error('--rates: transfers per minute, 1 to 600'); process.exit(2); }
mkdirSync(OUT, { recursive: true });
const t0 = Date.now(), now = () => new Date().toISOString().slice(11, 19);
const say = (...a) => { const l = [now(), ...a].join(' '); console.log(l); appendFileSync(`${OUT}/log.txt`, l + '\n'); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const node = new NodeClient(NODE, { timeoutMs: 60000 });
const get = async p => { const r = await fetch(NODE + p, { signal: AbortSignal.timeout(60000) }); if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`); return r.json(); };

const w = openWallet({ id: 'load', name: 'load', network: NET, kind: 'mnemonic' }, phrase);
await discover(w, node);
const me = decodeAddress(receiveAddress(w)).hash;
const keyFor = u => w.keys.get(hex(u.lock.type === 'PK' ? u.lock.hash : u.lock.pkHash));
let lastTip = null, lastBlockAt = null, mempoolNow = 0;
const pending = new Map();   // our transaction hash -> time sent; its outputs are not used until it is in a block
const used = new Set();      // outpoints already spent by a transfer we sent
const op = u => hex(u.outpoint.txHash) + ':' + u.outpoint.index;

async function pool() {
  const st = await readState(w, node);
  const free = st.utxos.filter(u => u.spend.asset === '00' && u.lock.type === 'PK' && keyFor(u) && !used.has(op(u)) && !pending.has(hex(u.outpoint.txHash)));
  return { st, free };
}
const sign = (st, utxos, payments) => buildTransaction({ utxos: utxos.map(u => ({ ...u, spend: { asset: ZEN_ASSET, amount: u.spend.amount }, key: keyFor(u) })),
  tipBlockNumber: st.tip, maturity: maturityFor(NET), payments, changeLock: { type: 'PK', hash: me } });

// ---- 1. outputs to spend: split the largest outputs into OUTPUTS outputs of UNIT ZP, at most 200 per transaction
{
  let { st, free } = await pool();
  const small = free.filter(u => u.spend.amount <= UNIT * 2n).length;
  say(`wallet ${receiveAddress(w)}, tip ${st.tip}, ${free.length} outputs (${small} small), ${formatZP(st.assets.find(a => a.asset === '00')?.spendable ?? 0n)} ZP`);
  let need = OUTPUTS - small;
  while (need > 0) {
    ({ st, free } = await pool());
    const big = free.filter(u => u.spend.amount > UNIT * 2n).sort((a, b) => (b.spend.amount > a.spend.amount ? 1 : -1));
    const batches = [];
    // too few large outputs for parallel batches: first split the largest into one chunk per batch of 200, so the
    // whole split takes 2-3 blocks instead of one block per 200 outputs
    const chunks = Math.ceil(need / 200), chunk = 201n * UNIT;
    if (big.length && big.length < chunks) {
      const k = Math.min(200, chunks - big.length + 1, Number(big[0].spend.amount / chunk));
      if (k >= 2) {
        batches.push(sign(st, [big[0]], Array.from({ length: k }, () => ({ lock: { type: 'PK', hash: me }, spend: { asset: ZEN_ASSET, amount: chunk } }))));
        used.add(op(big[0])); big.shift();
      }
    }
    for (const u of big) {
      if (need <= 0) break;
      const n = Math.min(200, need, Number((u.spend.amount - 1n) / UNIT));
      if (n < 1) continue;
      batches.push(sign(st, [u], Array.from({ length: n }, () => ({ lock: { type: 'PK', hash: me }, spend: { asset: ZEN_ASSET, amount: UNIT } }))));
      used.add(op(u)); need -= n;
    }
    if (!batches.length) { say(`not enough ZP for ${OUTPUTS} outputs of ${formatZP(UNIT)} ZP: ${need} missing`); process.exit(1); }
    for (const b of batches) { if (DRY) { say(`dry run: split transaction ${b.hash} not sent`); continue; } await publish(node, b); pending.set(b.hash, Date.now()); say(`split ${b.hash} sent`); }
    if (DRY) process.exit(0);
    for (let i = 0; pending.size && i < 90; i++) { await sleep(20000); await confirm(); }   // up to 30 minutes for the split to be in blocks
    if (pending.size) { say('the split transactions are not in a block after 30 minutes: stopping'); process.exit(1); }
  }
}

// ---- 2. measuring: tip, mempool, each block's transactions
const steps = [];
writeFileSync(`${OUT}/load.csv`, 'time,step_rate,tx,ok,latency_ms,error\n');
writeFileSync(`${OUT}/blocks.csv`, 'time,block,txs,ours,seconds_since_previous,mempool\n');
async function confirm() {
  const mp = await get('/blockchain/mempool');
  const inPool = new Set((Array.isArray(mp) ? mp : []).flatMap(x => Object.keys(x)));
  mempoolNow = inPool.size;
  for (const [h] of pending) if (!inPool.has(h)) pending.delete(h);   // in a block (or dropped: its outputs then show as unspent again)
}
async function measure(step) {
  const info = await get('/blockchain/info');
  await confirm();
  if (step) { step.mempool.push(mempoolNow); step.maxMempool = Math.max(step.maxMempool, mempoolNow); }
  if (lastTip !== null) for (let n = lastTip + 1; n <= info.blocks; n++) {
    const bk = await get(`/blockchain/block?blockNumber=${n}`);
    const txs = Object.keys(bk.transactions || {}), ours = txs.filter(h => step?.sent.has(h)).length;
    const ts = bk.header?.timestamp, secs = lastBlockAt && ts ? Math.round((ts - lastBlockAt) / 1000) : '';
    appendFileSync(`${OUT}/blocks.csv`, `${now()},${n},${txs.length},${ours},${secs},${mempoolNow}\n`);
    if (step) step.blocks.push({ n, txs: txs.length, ours, secs });
    lastBlockAt = ts || lastBlockAt;
  }
  lastTip = info.blocks;
}
await measure(null);

// ---- 3. the steps
let stopReason = null;
for (const rate of RATES) {
  if (stopReason) break;
  const step = { rate, start: new Date().toISOString(), sent: new Set(), ok: 0, failed: 0, latency: [], errors: {}, mempool: [], maxMempool: 0, blocks: [] };
  steps.push(step);
  say(`--- step: ${rate} transfers a minute for ${STEP_MS / 60000} minutes`);
  const stepEnd = Date.now() + STEP_MS, every = 60000 / rate;
  let free = [], refreshedAt = 0, nextMeasure = Date.now() + 15000, recent = [];
  for (let next = Date.now(); Date.now() < stepEnd; next += every) {
    if (Date.now() - t0 > MAX_MS) { stopReason = `time limit (${MAX_MS / 60000} minutes)`; break; }
    if (Date.now() >= nextMeasure) {
      try { await measure(step); } catch (e) { stopReason = 'the node stopped answering: ' + e.message; break; }
      nextMeasure = Date.now() + 15000;
      say(`rate ${rate}/min: sent ${step.ok + step.failed}, accepted ${step.ok}, refused ${step.failed}, mempool ${mempoolNow}, tip ${lastTip}, free outputs ${free.length}`);
      if (mempoolNow > MAX_MEMPOOL) { stopReason = `mempool above ${MAX_MEMPOOL}`; break; }
    }
    if (!free.length || Date.now() - refreshedAt > 60000) { ({ free } = await pool()); refreshedAt = Date.now(); }
    const u = free.shift();
    if (!u) { step.errors['no free output'] = (step.errors['no free output'] || 0) + 1; await sleep(Math.max(0, next + every - Date.now())); continue; }
    const tx = sign({ tip: lastTip }, [u], [{ lock: { type: 'PK', hash: me }, spend: { asset: ZEN_ASSET, amount: u.spend.amount } }]);
    used.add(op(u));
    const s = Date.now();
    try {
      await publish(node, tx); const ms = Date.now() - s;
      step.ok++; step.latency.push(ms); step.sent.add(tx.hash); pending.set(tx.hash, Date.now()); recent.push(1);
      appendFileSync(`${OUT}/load.csv`, `${now()},${rate},${tx.hash},1,${ms},\n`);
    } catch (e) {
      const ms = Date.now() - s, m = String(e.message).slice(0, 80).replace(/,/g, ';');
      step.failed++; step.errors[m] = (step.errors[m] || 0) + 1; recent.push(0);
      appendFileSync(`${OUT}/load.csv`, `${now()},${rate},${tx.hash},0,${ms},${m}\n`);
    }
    recent = recent.slice(-50);
    if (recent.length >= 20 && recent.filter(x => !x).length / recent.length > 0.5) { stopReason = 'more than half of the last transfers refused'; break; }
    const wait = next + every - Date.now();
    if (wait > 0) await sleep(wait);
  }
  step.end = new Date().toISOString();
  writeSummary();
}
// let the last transfers reach blocks (up to 10 minutes), measuring
for (let i = 0; pending.size && i < 40; i++) { await sleep(15000); try { await measure(steps.at(-1)); } catch { break; } }
writeSummary();
say(stopReason ? `stopped: ${stopReason}` : 'done: all steps ran', `- results in ${OUT}/summary.json`);

function writeSummary() {
  const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  const out = { node: NODE, started: new Date(t0).toISOString(), stopReason, steps: steps.map(s => {
    const secs = s.blocks.map(b => b.secs).filter(Number.isFinite);
    return { rate_per_min: s.rate, start: s.start, end: s.end || null, sent: s.ok + s.failed, accepted: s.ok, refused: s.failed, errors: s.errors,
      publish_ms: { median: pct(s.latency, 0.5), p95: pct(s.latency, 0.95), max: s.latency.length ? Math.max(...s.latency) : null },
      mempool: { avg: s.mempool.length ? Math.round(s.mempool.reduce((a, b) => a + b, 0) / s.mempool.length) : null, max: s.maxMempool },
      blocks: s.blocks.length, txs_per_block: { avg: s.blocks.length ? +(s.blocks.reduce((a, b) => a + b.txs, 0) / s.blocks.length).toFixed(1) : null, max: s.blocks.length ? Math.max(...s.blocks.map(b => b.txs)) : null },
      ours_in_blocks: s.blocks.reduce((a, b) => a + b.ours, 0), block_seconds_avg: secs.length ? Math.round(secs.reduce((a, b) => a + b, 0) / secs.length) : null };
  }) };
  writeFileSync(`${OUT}/summary.json`, JSON.stringify(out, null, 2));
}
