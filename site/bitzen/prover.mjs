// Copy of navoranetwork/bitzen services/prover.mjs (tested there: tests/prover/run.sh). Keep the two identical.
// BitZen prover: makes the swap automatic. Watches the BitZenSwap contract's reserved offers, finds on Bitcoin the
// payment to each reservation's script, and as soon as its block has the confirmations the offer's price needs (2 up
// to 0.01 BTC, 3 up to 0.1, 4 up to 1, else 6) and is in BitZenChain's ring, sends the proof (`pay` to the chain
// contract with notify = the swap and ref = the offer): the buyer receives the ZP without doing anything.
// Anyone can run it; it only carries public data, and the contracts check everything (a wrong proof is refused).
// The node's wallet pays the call's fee. Node 18+, no packages.
//
// env: PROVER_NODE (http://127.0.0.1:31567)  PROVER_PASSWORD  PROVER_CHAIN, PROVER_SWAP (contract addresses ctzn1…)
//      PROVER_BTC_API (https://mempool.space/api)  PROVER_LOOP_MS (30000)  PROVER_STATE (./prover-state.json)
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
const env = process.env;
const NODE = env.PROVER_NODE || 'http://127.0.0.1:31567', PW = env.PROVER_PASSWORD || 'testnet';
const CHAIN = env.PROVER_CHAIN, SWAP = env.PROVER_SWAP, BTC = env.PROVER_BTC_API || 'https://mempool.space/api';
const LOOP_MS = Number(env.PROVER_LOOP_MS || 30000), STATE = env.PROVER_STATE || './prover-state.json';
const RING = 16;
const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = b => createHash('sha256').update(b).digest();
const rev = h => h.match(/../g).reverse().join('');
const blockHash = hex => rev(sha(sha(Buffer.from(hex, 'hex'))).toString('hex'));
export const confsFor = sats => sats <= 1_000_000 ? 2 : sats <= 10_000_000 ? 3 : sats <= 100_000_000 ? 4 : 6;

async function get(url, json = true) {
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${url.replace(/\?.*/, '')}: ${r.status}`);
  return json ? r.json() : (await r.text()).trim();
}
function plain(d) {
  if (d == null) return null;
  const [t, v] = Object.entries(d)[0];
  if (t === 'dict') return Object.fromEntries(v.map(([k, x]) => [k, plain(x)]));
  if (t === 'list' || t === 'array') return v.map(plain);
  return v;
}
// message bodies: the node's Data serialization (as in scripts/v1-pay.mjs) for Dict, String, U32, U64, Hash, Lock
function varint(n) { const t = []; let len = 0; for (;;) { t[len] = (n & 0x7f) | (len ? 0x80 : 0); if (n <= 0x7f) break; n = Math.floor(n / 128) - 1; len++; } return Buffer.from(t.reverse()); }
const bytes = b => Buffer.concat([varint(b.length), b]);
function data(d) {
  switch (d.t) {
    case 'U32': { const b = Buffer.alloc(5); b[0] = 4; b.writeUInt32BE(d.v, 1); return b; }
    case 'U64': { const b = Buffer.alloc(9); b[0] = 5; b.writeBigUInt64BE(BigInt(d.v), 1); return b; }
    case 'String': return Buffer.concat([Buffer.of(6), bytes(Buffer.from(d.v, 'latin1'))]);
    case 'Hash': return Buffer.concat([Buffer.of(7), d.v]);
    case 'Lock': { const p = Buffer.concat([varint(parseInt(d.v.slice(0, 8), 16)), Buffer.from(d.v.slice(8), 'hex')]); return Buffer.concat([Buffer.of(8), varint(4), varint(p.length), p]); }
    case 'Dict': {
      const es = [...d.v].sort((a, b) => a[0].length - b[0].length || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      return Buffer.concat([Buffer.of(12), varint(es.length), ...es.flatMap(([k, v]) => [bytes(Buffer.from(k, 'latin1')), data(v)])]);
    }
  }
  throw new Error('data kind ' + d.t);
}
// the transaction without witness data (its txid form)
export function stripWitness(h) {
  const b = Buffer.from(h, 'hex'); if (b[4] !== 0 || b[5] !== 1) return h;
  let p = 6; const vi = () => { const f = b[p++]; if (f < 0xfd) return f; const k = f === 0xfd ? 2 : f === 0xfe ? 4 : 8; let v = 0; for (let i = k - 1; i >= 0; i--) v = v * 256 + b[p + i]; p += k; return v; };
  const start = p; const nin = vi(); for (let i = 0; i < nin; i++) { p += 36; const l = vi(); p += l + 4; }
  const nout = vi(); for (let i = 0; i < nout; i++) { p += 8; const l = vi(); p += l; }
  return Buffer.concat([b.subarray(0, 4), b.subarray(start, p), b.subarray(b.length - 4)]).toString('hex');
}

let sent = {};   // offer id + txid -> ZP transaction already sent
try { sent = JSON.parse(readFileSync(STATE, 'utf8')); } catch { }
const save = () => { try { writeFileSync(STATE, JSON.stringify(sent)); } catch (e) { log('state not saved:', e.message); } };

async function round() {
  const chain = plain(await get(`${NODE}/contract/state?address=${CHAIN}`));
  const swap = plain(await get(`${NODE}/contract/state?address=${SWAP}`));
  if (!chain || !swap) return;
  const chainId = (await get(`${NODE}/contract/active`)).find(c => c.address === CHAIN)?.contractId;
  const swapId = (await get(`${NODE}/contract/active`)).find(c => c.address === SWAP)?.contractId;
  if (!swapId) throw new Error('the swap contract is not active');
  // the chain contract's ring: Bitcoin block hash (as shown) -> slot and height from the checkpoint
  const tipN = Number(chain.height);
  const slots = Object.entries(chain).filter(([k]) => /^h\d+$/.test(k)).map(([k, v]) => ({ slot: k, n: Number(v.n), hash: rev(v.hash) }));
  for (const [id, o] of Object.entries(swap)) {
    if (!o || typeof o !== 'object' || !o.buyer || !o.cur || !o[o.cur]) continue;   // not an offer, or not reserved
    const script = o[o.cur], sats = Number(o.sats), need = confsFor(sats);
    const shash = rev(sha(Buffer.from(script, 'hex')).toString('hex'));        // electrum script hash
    const txs = await get(`${BTC}/scripthash/${shash}/txs`);
    for (const t of txs) {
      if (!t.status?.confirmed) continue;
      const vout = t.vout.findIndex(x => x.scriptpubkey === script && x.value >= sats);
      if (vout < 0 || sent[id + ':' + t.txid]) continue;
      const slot = slots.find(s => s.hash === t.status.block_hash);
      if (!slot) { log(`offer ${id}: payment ${t.txid} in block ${t.status.block_height}, not in the chain contract's ring yet (or already out of it)`); continue; }
      const confs = tipN - slot.n + 1;
      if (confs < need) { log(`offer ${id}: payment ${t.txid}: ${confs} of ${need} confirmations`); continue; }
      const raw = stripWitness(await get(`${BTC}/tx/${t.txid}/hex`, false));
      const proof = await get(`${BTC}/tx/${t.txid}/merkle-proof`);
      const header = await get(`${BTC}/block/${t.status.block_hash}/header`, false);
      if (blockHash(header) !== t.status.block_hash || proof.merkle.length > 14 || raw.length > 1024) { log(`offer ${id}: payment ${t.txid} cannot be proved here (path or size)`); continue; }
      const e = [['at', { t: 'String', v: slot.slot }], ['header', { t: 'String', v: header }], ['tx', { t: 'String', v: raw }],
                 ['vout', { t: 'U32', v: vout }], ['index', { t: 'U32', v: proof.pos }], ['depth', { t: 'U32', v: proof.merkle.length }],
                 ['script', { t: 'String', v: script }], ['amount', { t: 'U64', v: sats }], ['confs', { t: 'U64', v: need }],
                 ['notify', { t: 'Lock', v: swapId }], ['ref', { t: 'String', v: id }],
                 ...proof.merkle.map((m, i) => ['p' + i, { t: 'Hash', v: Buffer.from(rev(m), 'hex') }])];
      const r = await fetch(`${NODE}/wallet/contract/execute`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(180000),
        body: JSON.stringify({ address: CHAIN, command: 'pay', messageBody: data({ t: 'Dict', v: e }).toString('hex'), options: { returnAddress: true }, spends: [], password: PW }) });
      const text = (await r.text()).trim();
      if (/^"[0-9a-f]{64}"$/.test(text)) { sent[id + ':' + t.txid] = JSON.parse(text); save(); log(`offer ${id}: proof of ${t.txid} sent (${confs} confirmations), ZP transaction ${JSON.parse(text)}`); }
      else log(`offer ${id}: proof of ${t.txid} refused: ${text.slice(0, 200)}`);
    }
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  if (!CHAIN || !SWAP) { console.error('set PROVER_CHAIN and PROVER_SWAP'); process.exit(1); }
  log(`BitZen prover: chain ${CHAIN}, swap ${SWAP}, node ${NODE}, Bitcoin ${BTC}`);
  for (;;) { try { await round(); } catch (e) { log('round failed:', e.message); } await sleep(LOOP_MS); }
}
