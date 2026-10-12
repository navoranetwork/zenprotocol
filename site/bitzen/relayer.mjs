// BitZen header relayer (testnet): keeps the BitZen header chain contract on the Bitcoin mainnet tip.
// The contract checks every header itself (proof of work, difficulty, links, forks); this service only carries headers
// from a public Bitcoin API to it and cannot make it accept a wrong one. Anyone may run another.
//
// Each loop: read the contract's state from the node (GET /contract/state), compare its tip with Bitcoin's best chain,
// then send the next header ("add"), or a branch from the last common block ("reorg", up to 6 headers) when Bitcoin
// changed its tip. One call at a time: each waits until it is in a block before the next is sent.
// The first call is the checkpoint: a recent Bitcoin block (BITZEN_CHECKPOINT_BACK below the tip).
// Writes the status for the site's /bitzen.html to BITZEN_STATUS.
//
// env: BITZEN_CONTRACT (ctzn1… contract address; empty: idle), BITZEN_NODE, BITZEN_PASSWORD (node wallet),
//      BITZEN_BTC_API (default https://mempool.space/api), BITZEN_STATUS, BITZEN_STATE, BITZEN_LOOP_MS, BITZEN_CHECKPOINT_BACK
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Writer, Data, hex } from '../../wallet/src/serialize.js';

const env = process.env;
const NODE = env.BITZEN_NODE || 'http://127.0.0.1:31567';
const PASSWORD = env.BITZEN_PASSWORD || 'testnet';
const CONTRACT = (env.BITZEN_CONTRACT || '').trim();
const BTC = (env.BITZEN_BTC_API || 'https://mempool.space/api').replace(/\/$/, '');
const STATUS = env.BITZEN_STATUS || '/data/web/bitzen.json';
const STATE = env.BITZEN_STATE || '/data/bitzen-relayer.json';
const LOOP_MS = Number(env.BITZEN_LOOP_MS || 60000);
const CHECKPOINT_BACK = Number(env.BITZEN_CHECKPOINT_BACK || 6);
const MAX_CALLS_PER_LOOP = 6;
const RING = 16, MAX_BRANCH = 6;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => new Date().toISOString();
const log = (...a) => console.log(now(), ...a);
const sha = b => createHash('sha256').update(b).digest();
// a header's block hash as Bitcoin shows it (double SHA-256, byte order reversed)
const blockHash = headerHex => Buffer.from(sha(sha(Buffer.from(headerHex, 'hex')))).reverse().toString('hex');
// the contract keeps hashes in Bitcoin's internal byte order
const shown = internalHex => Buffer.from(internalHex, 'hex').reverse().toString('hex');

async function get(url, json = true) {
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${url.replace(/\?.*/, '')}: ${r.status}`);
  return json ? r.json() : (await r.text()).trim();
}
const btc = {
  tip: () => get(`${BTC}/blocks/tip/height`, false).then(Number),
  hashAt: h => get(`${BTC}/block-height/${h}`, false),
  header: hash => get(`${BTC}/block/${hash}/header`, false),
  headerAt: async h => btc.header(await btc.hashAt(h)),
  block: hash => get(`${BTC}/block/${hash}`),
};

// node JSON data ({ dict: [[key, { type: value }], …] }) → plain object
function plain(d) {
  if (d == null) return null;
  const [t, v] = Object.entries(d)[0];
  if (t === 'dict') return Object.fromEntries(v.map(([k, x]) => [k, plain(x)]));
  if (t === 'list' || t === 'array') return v.map(plain);
  return v;
}
const S = v => ({ t: 'String', v }), U = v => ({ t: 'U64', v: BigInt(v) });
function body(entries) { const w = new Writer(); Data.write(w, { t: 'Dict', v: entries }); return hex(w.out()); }

async function mined(tx) {
  for (let i = 0; i < 600; i++) {
    try { const t = await get(`${NODE}/blockchain/transaction?hash=${tx}`); if (t && Number(t.confirmations) > 0) return; } catch { }
    await sleep(2000);
  }
  throw new Error(`call ${tx} not in a block after 20 minutes`);
}
async function call(command, entries) {
  const r = await fetch(`${NODE}/wallet/contract/execute`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(180000),
    body: JSON.stringify({ address: CONTRACT, command, messageBody: body(entries), options: { returnAddress: true }, spends: [], password: PASSWORD }),
  });
  const text = (await r.text()).trim();
  let res; try { res = JSON.parse(text); } catch { res = text; }
  if (typeof res !== 'string' || !/^[0-9a-f]{64}$/.test(res)) throw new Error(`${command} refused: ${String(text).slice(0, 200)}`);
  await mined(res);   // one call at a time: the next is built on the state this one leaves
  return res;
}

// ---- persistent bits: the checkpoint's Bitcoin height and the recent actions ----
let saved = { checkpointHeight: null, history: [] };
try { saved = { ...saved, ...JSON.parse(readFileSync(STATE, 'utf8')) }; } catch { }
const save = () => { try { mkdirSync(dirname(STATE), { recursive: true }); writeFileSync(STATE, JSON.stringify(saved)); } catch (e) { log('state not saved:', e.message); } };
const remember = a => { saved.history = [{ time: now(), ...a }, ...saved.history].slice(0, 40); save(); log(a.kind, JSON.stringify(a)); };

// one step: true when a call was made (the loop then goes on at once)
async function step(view) {
  const st = plain(await get(`${NODE}/contract/state?address=${CONTRACT}`));
  const btcTip = await btc.tip();
  view.bitcoinTip = btcTip;
  if (!st) {
    const h0 = btcTip - CHECKPOINT_BACK, pos = h0 % 2016;
    const header = await btc.headerAt(h0), first = await btc.headerAt(h0 - pos);
    const tx = await call('add', [['header', S(header)], ['first', S(first)], ['pos', U(pos)]]);
    saved.checkpointHeight = h0;
    remember({ kind: 'checkpoint', height: h0, hash: blockHash(header), tx });
    return true;
  }
  const tipN = Number(st.height), tipHash = blockHash(st.lastHex);
  if (saved.checkpointHeight == null) {   // learn it from the tip (once), if Bitcoin still knows the block
    const b = await btc.block(tipHash);
    saved.checkpointHeight = b.height - tipN; save();
  }
  const h0 = saved.checkpointHeight, tipHeight = h0 + tipN;
  const ring = Object.entries(st).filter(([k]) => /^h\d+$/.test(k))
    .map(([slot, v]) => ({ slot, n: Number(v.n), height: h0 + Number(v.n), hash: shown(v.hash) }))
    .sort((a, b) => b.n - a.n);
  Object.assign(view, { checkpointHeight: h0, tip: { height: tipHeight, hash: tipHash, placeInPeriod: Number(st.pos) }, ring });

  const best = tipHeight <= btcTip ? await btc.hashAt(tipHeight).catch(() => null) : null;
  if (best === tipHash) {
    if (btcTip <= tipHeight) return false;   // up to date
    const header = await btc.headerAt(tipHeight + 1);
    const tx = await call('add', [['header', S(header)]]);
    remember({ kind: 'add', height: tipHeight + 1, hash: blockHash(header), tx });
    return true;
  }
  if (best === null && tipHeight > btcTip) return false;   // the Bitcoin API is behind the contract: wait

  // Bitcoin's best chain left the contract's tip: find the last common block in the ring and send the branch from it
  let fork = null;
  for (const s of ring) if (s.height <= btcTip && (await btc.hashAt(s.height).catch(() => null)) === s.hash) { fork = s; break; }
  if (!fork) throw new Error(`no block of the contract's last ${RING} is on Bitcoin's best chain: a reorg deeper than the ring`);
  const k = Math.min(MAX_BRANCH, btcTip - fork.height);
  if (fork.n + k <= tipN) throw new Error(`Bitcoin's branch from ${fork.height} is not longer than the contract's within ${MAX_BRANCH} headers: waiting`);
  const headers = [];
  for (let i = 1; i <= k; i++) headers.push(await btc.headerAt(fork.height + i));
  const tx = await call('reorg', [['at', S(fork.slot)], ...headers.map((h, i) => ['b' + (i + 1), S(h)])]);
  remember({ kind: 'reorg', from: fork.height, to: fork.height + k, replaced: tipHeight - fork.height, hash: blockHash(headers[k - 1]), tx });
  return true;
}

async function contractInfo(view) {
  try {
    const active = await get(`${NODE}/contract/active`);
    const c = (active || []).find(x => x.address === CONTRACT);
    const info = await get(`${NODE}/blockchain/info`);
    Object.assign(view, { contractActive: !!c, contractId: c ? c.contractId : null, expiry: c ? c.expire ?? c.expiry ?? null : null, zpTip: info.blocks });
  } catch { }
}

function writeStatus(view) {
  try {
    mkdirSync(dirname(STATUS), { recursive: true });
    const tmp = STATUS + '.tmp';
    writeFileSync(tmp, JSON.stringify({ ...view, contract: CONTRACT || null, history: saved.history, updated: now() }));
    renameSync(tmp, STATUS);
  } catch (e) { log('status not written:', e.message); }
}

log(`BitZen relayer: contract ${CONTRACT || '(none)'}, node ${NODE}, Bitcoin ${BTC}`);
while (true) {
  const view = { error: null };
  if (!CONTRACT) view.error = 'No contract configured (BITZEN_CONTRACT).';
  else {
    // each call waits for its block, which can take many minutes: write the status after every call, not only at the end
    await contractInfo(view); writeStatus(view);
    try { for (let i = 0; i < MAX_CALLS_PER_LOOP && await step(view); i++) { await contractInfo(view); writeStatus(view); } }
    catch (e) { view.error = e.message; log('error:', e.message); }
    await contractInfo(view);
  }
  writeStatus(view);
  await sleep(LOOP_MS);
}
