// BitZen prover: makes the swap automatic. Watches the BitZenSwap contract's reserved offers, finds on Bitcoin the
// payment to each reservation's script, and as soon as its block has the confirmations the offer's price needs (2 up
// to 0.01 BTC, 3 up to 0.1, 4 up to 1, else 6) and is in BitZenChain's ring, sends the proof (`pay` to the chain
// contract with notify = the swap and ref = the offer): the buyer receives the ZP without doing anything.
// Anyone can run it; it only carries public data, and the contracts check everything (a wrong proof is refused).
// The node's wallet pays the call's fee. Node 18+, no packages.
//
// It also serves the swap page (site/swap.html) when PROVER_LISTEN is set:
//   GET  /status    the offers (amount, price, state, the Bitcoin address to pay, the payment and its confirmations)
//   POST /reserve   { id, buyer: tzn1… address }: reserves the offer for that address (the node's wallet pays the fee)
//
// env: PROVER_NODE (http://127.0.0.1:31567)  PROVER_PASSWORD  PROVER_CHAIN, PROVER_SWAP (contract addresses ctzn1…)
//      PROVER_BTC_API (https://mempool.space/api)  PROVER_BTC_NET (main | test: address prefix bc / tb)
//      PROVER_LOOP_MS (30000)  PROVER_STATE (./prover-state.json)  PROVER_LISTEN (host:port, off when unset)
import { createHash } from 'node:crypto';
import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
const env = process.env;
const NODE = env.PROVER_NODE || 'http://127.0.0.1:31567', PW = env.PROVER_PASSWORD || 'testnet';
const CHAIN = env.PROVER_CHAIN, SWAP = env.PROVER_SWAP, BTC = env.PROVER_BTC_API || 'https://mempool.space/api';
const LOOP_MS = Number(env.PROVER_LOOP_MS || 30000), STATE = env.PROVER_STATE || './prover-state.json';
const RING = 16;
const NET = env.PROVER_BTC_NET || 'main', LISTEN = env.PROVER_LISTEN || '';
const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = b => createHash('sha256').update(b).digest();
const rev = h => h.match(/../g).reverse().join('');
const blockHash = hex => rev(sha(sha(Buffer.from(hex, 'hex'))).toString('hex'));
// a Bitcoin output script as an address (P2WPKH, P2WSH, P2TR: bech32 / bech32m; P2PKH, P2SH: base58check); null otherwise
const B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function polymod(v) { const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]; let c = 1; for (const x of v) { const b = c >>> 25; c = ((c & 0x1ffffff) << 5) ^ x; for (let i = 0; i < 5; i++) if ((b >>> i) & 1) c ^= G[i]; } return c >>> 0; }
function bech32(hrp, version, prog) {
  const conv = []; let acc = 0, bits = 0; for (const b of prog) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; conv.push((acc >>> bits) & 31); } } if (bits) conv.push((acc << (5 - bits)) & 31);
  const data = [version, ...conv], k = version === 0 ? 1 : 0x2bc830a3;
  const exp = [...[...hrp].map(c => c.charCodeAt(0) >> 5), 0, ...[...hrp].map(c => c.charCodeAt(0) & 31)];
  const pm = polymod([...exp, ...data, 0, 0, 0, 0, 0, 0]) ^ k;
  return hrp + '1' + [...data, ...[0, 1, 2, 3, 4, 5].map(i => (pm >>> (5 * (5 - i))) & 31)].map(x => B32[x]).join('');
}
function base58check(payload) {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const b = Buffer.concat([payload, sha(sha(payload)).subarray(0, 4)]); let n = BigInt('0x' + b.toString('hex')), out = '';
  while (n > 0n) { out = A[Number(n % 58n)] + out; n /= 58n; } for (const x of b) { if (x) break; out = '1' + out; } return out;
}
export function scriptAddress(hex, net = NET) {
  const s = Buffer.from(hex, 'hex'), hrp = net === 'main' ? 'bc' : 'tb';
  if (s.length === 22 && s[0] === 0 && s[1] === 20) return bech32(hrp, 0, s.subarray(2));
  if (s.length === 34 && s[0] === 0 && s[1] === 32) return bech32(hrp, 0, s.subarray(2));
  if (s.length === 34 && s[0] === 0x51 && s[1] === 32) return bech32(hrp, 1, s.subarray(2));
  if (s.length === 25 && s[0] === 0x76 && s[1] === 0xa9 && s[2] === 20 && s[23] === 0x88 && s[24] === 0xac) return base58check(Buffer.concat([Buffer.of(net === 'main' ? 0 : 0x6f), s.subarray(3, 23)]));
  if (s.length === 23 && s[0] === 0xa9 && s[1] === 20 && s[22] === 0x87) return base58check(Buffer.concat([Buffer.of(net === 'main' ? 5 : 0xc4), s.subarray(2, 22)]));
  return null;
}
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

// offers whose seller's "cancel" waits in the mempool (GET /blockchain/mempool: [{hash: tx}], contract witnesses as JSON):
// shown as closing and not reserved, so a buyer does not race the seller's take-back
export function cancelsIn(mempool, swapId) {
  const ids = new Set();
  for (const e of Array.isArray(mempool) ? mempool : []) for (const tx of Object.values(e || {}))
    for (const w of Array.isArray(tx?.witness) ? tx.witness : []) {
      const cw = w?.ContractWitness;
      if (cw && cw.contractId === swapId && cw.command === 'cancel') { const id = plain(cw.messageBody)?.id; if (typeof id === 'string') ids.add(id); }
    }
  return ids;
}
const pendingCancels = async swapId => swapId ? cancelsIn(await get(`${NODE}/blockchain/mempool`).catch(() => []), swapId) : new Set();

let view = { updated: null, offers: [] };
async function round() {
  const chain = plain(await get(`${NODE}/contract/state?address=${CHAIN}`));
  const swap = plain(await get(`${NODE}/contract/state?address=${SWAP}`));
  const zpTip = (await get(`${NODE}/blockchain/info`)).blocks;
  const active = await get(`${NODE}/contract/active`);
  const chainId = active.find(c => c.address === CHAIN)?.contractId;
  const swapId = active.find(c => c.address === SWAP)?.contractId;
  const closing = await pendingCancels(swapId);
  const offers = [];
  if (swap) for (const [id, o] of Object.entries(swap)) {
    if (!o || typeof o !== 'object' || o.amount == null || o.sats == null) continue;
    const until = o.until != null ? Number(o.until) : null, held = until != null && zpTip + 1 <= until;
    const k = Number(o.k || 0), nextScript = o['s' + k];
    offers.push({ id, zp: Number(o.amount) / 1e8, amount: String(o.amount), sats: Number(o.sats), confs: confsFor(Number(o.sats)),
      seller: typeof o.seller === 'string' ? o.seller : null, scripts: [0, 1, 2, 3].map(i => o['s' + i]).filter(Boolean).length, used: k,
      scriptList: [0, 1, 2, 3].map(i => o['s' + i]).filter(x => typeof x === 'string'),   // so a wallet can refuse an address already in the market
      state: held ? 'reserved' : closing.has(id) ? 'closing' : o.cur ? 'expired' : 'open', until, buyer: o.buyer?.PK?.hash || null,
      address: o.cur ? scriptAddress(o[o.cur]) : null, script: o.cur ? o[o.cur] : null,
      canReserve: !held && !closing.has(id) && !!nextScript, payment: null });
  }
  view = { updated: new Date().toISOString(), chain: CHAIN, swap: SWAP, swapId: swapId || null, zpTip, btcNet: NET, offers };
  if (!chain || !swap) return;
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
      if (!t.status?.confirmed) {
        const vo = view.offers.find(x => x.id === id), vv = t.vout.findIndex(x => x.scriptpubkey === script && x.value >= sats);
        if (vo && vv >= 0 && !vo.payment) vo.payment = { txid: t.txid, value: t.vout[vv].value, block: null, confs: 0, need, proof: null };
        continue;
      }
      const vout = t.vout.findIndex(x => x.scriptpubkey === script && x.value >= sats);
      if (vout < 0) continue;
      if (sent[id + ':' + t.txid]) { const vo = view.offers.find(x => x.id === id); if (vo) vo.payment = { txid: t.txid, value: t.vout[vout].value, block: t.status.block_height, need, proof: sent[id + ':' + t.txid] }; continue; }
      const slot = slots.find(s => s.hash === t.status.block_hash);
      const vo = view.offers.find(x => x.id === id);
      if (vo) vo.payment = { txid: t.txid, value: t.vout[vout].value, block: t.status.block_height, confs: slot ? tipN - slot.n + 1 : null, need, proof: null };
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
      if (/^"[0-9a-f]{64}"$/.test(text)) { sent[id + ':' + t.txid] = JSON.parse(text); save(); if (vo) vo.payment.proof = JSON.parse(text); log(`offer ${id}: proof of ${t.txid} sent (${confs} confirmations), ZP transaction ${JSON.parse(text)}`); }
      else log(`offer ${id}: proof of ${t.txid} refused: ${text.slice(0, 200)}`);
    }
  }
}

// ---- the swap page's API ----
async function reserve(id, buyer) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw new Error('bad offer id');
  if (typeof buyer !== 'string' || !/^t?zn1[0-9a-z]{20,90}$/.test(buyer)) throw new Error('that is not a ZP address');
  const d = await get(`${NODE}/address/decode?address=${encodeURIComponent(buyer)}`);
  if (!d.pkHash) throw new Error('that is not a ZP address of a key');
  const o = view.offers.find(x => x.id === id);
  if (!o) throw new Error('no such offer'); if (!o.canReserve) throw new Error(o.state === 'reserved' ? 'the offer is reserved' : o.state === 'closing' ? 'the seller is taking this offer back' : 'the offer cannot be reserved again');
  if ((await pendingCancels(view.swapId)).has(id)) throw new Error('the seller is taking this offer back');   // since the last round
  const lock = Buffer.concat([Buffer.of(8), varint(2), varint(32), Buffer.from(d.pkHash, 'hex')]);
  const body = Buffer.concat([Buffer.of(12), varint(2), bytes(Buffer.from('id')), data({ t: 'String', v: id }), bytes(Buffer.from('buyer')), lock]);
  const r = await fetch(`${NODE}/wallet/contract/execute`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(180000),
    body: JSON.stringify({ address: SWAP, command: 'reserve', messageBody: body.toString('hex'), options: { returnAddress: true }, spends: [], password: PW }) });
  const text = (await r.text()).trim();
  if (!/^"[0-9a-f]{64}"$/.test(text)) throw new Error('refused: ' + text.slice(0, 160));
  log(`offer ${id}: reserved for ${buyer}, ZP transaction ${JSON.parse(text)}`);
  return { tx: JSON.parse(text), pkHash: d.pkHash };
}
function serve() {
  const [host, port] = LISTEN.split(':');
  const json = (res, code, v) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(v)); };
  http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/status') return json(res, 200, view);
      if (req.method === 'POST' && req.url === '/reserve') {
        let b = ''; for await (const c of req) { b += c; if (b.length > 2048) throw new Error('too large'); }
        const { id, buyer } = JSON.parse(b);
        return json(res, 200, await reserve(id, buyer));
      }
      json(res, 404, { error: 'unknown path' });
    } catch (e) { json(res, 400, { error: String(e.message || e).slice(0, 200) }); }
  }).listen(Number(port), host, () => log('swap API on', LISTEN));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  if (!CHAIN || !SWAP) { console.error('set PROVER_CHAIN and PROVER_SWAP'); process.exit(1); }
  if (LISTEN) serve();
  log(`BitZen prover: chain ${CHAIN}, swap ${SWAP}, node ${NODE}, Bitcoin ${BTC}`);
  for (;;) { try { await round(); } catch (e) { log('round failed:', e.message); } await sleep(LOOP_MS); }
}
