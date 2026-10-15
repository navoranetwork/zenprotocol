// The Dex's newest calls, before the chain index has them (it trails the tip by 10 blocks on purpose, so a reorg
// cannot leave stale rows). Read live from the node: the blocks between the index and the tip (raw, as the index
// decodes them) and the mempool (JSON, whose contract witnesses carry the message body raw). Each call gives a row
// in the index's `dex` table shape, plus `confirmations` (0 = in the mempool) and `pending`.
// These rows are hints for display only: a block near the tip can still be replaced, and a mempool call may never be
// mined. Whoever signs re-reads the exact order from the node first.
import { deserializeBlock, txHash, hex, unhex, Reader, Data } from '../wallet/src/serialize.js';
import { encodeAddress } from '../wallet/src/keys.js';

const u32hex = n => (n >>> 0).toString(16).padStart(8, '0');
const cidStr = c => u32hex(c.version) + hex(c.hash);
const isZero = a => a.every(x => x === 0);
const assetStr = a => isZero(a.contract.hash) && isZero(a.subtype) && a.contract.version === 0 ? '00'
  : cidStr(a.contract) + (isZero(a.subtype) ? '' : hex(a.subtype));
const str = x => x == null ? null : x instanceof Uint8Array ? hex(x) : typeof x === 'object' ? JSON.stringify(x, (_, v) => typeof v === 'bigint' ? String(v) : v) : String(x);

// one Dex call -> a row, as site/chain-index.mjs writes it: for a Take, the amounts are what is left of the order, and
// order_asset is the 1-unit asset the transaction locks to the Dex (the order it makes: a new order, or a Take's remainder)
export function dexRow({ tx, block, time, command, body, outputs, dex, net }) {
  if (!['Make', 'Take', 'Cancel'].includes(command) || body?.t !== 'Dict') return null;
  const f = Object.fromEntries(body.v.map(([k, d]) => [k, d.v]));
  const dexAddr = encodeAddress(unhex(dex), net, true);
  const oa = outputs.find(o => o[0] === dexAddr && String(o[2]) === '1' && o[1].startsWith(dex))?.[1] ?? null;
  let under = f.UnderlyingAmount, total = f.OrderTotal;
  const payout = f.RequestedPayout, provided = f.ProvidedAmount;
  if (command === 'Take' && payout != null && provided != null) { under = BigInt(under) - BigInt(payout); total = BigInt(total) - BigInt(provided); }
  return { tx, block, time, command, under_asset: str(f.UnderlyingAsset), under_amount: str(under), pair_asset: str(f.PairAsset), pair_total: str(total),
    maker: str(f.MakerPubKey), order_asset: oa, payout: str(payout), provided: str(provided),
    // the order this call acts on, as it was before the call (a Take or Cancel names it in full)
    target: { under_asset: str(f.UnderlyingAsset), under_amount: str(f.UnderlyingAmount), pair_asset: str(f.PairAsset), pair_total: str(f.OrderTotal), maker: str(f.MakerPubKey) } };
}

// a raw block (hex, from GET /blockchain/blocks) -> its Dex rows
export function rowsOfRawBlock(n, raw, dex, net) {
  const blk = deserializeBlock(unhex(raw), { lenient: true });
  const time = Number(new DataView(blk.header.buffer, blk.header.byteOffset).getBigUint64(72));
  const lockAddr = l => l.type === 'PK' ? encodeAddress(l.hash, net) : l.type === 'Coinbase' ? encodeAddress(l.pkHash, net) : l.type === 'Contract' ? encodeAddress(unhex(cidStr(l.contractId)), net, true) : l.type;
  const rows = [];
  for (const { tx } of blk.txs) {
    const outputs = tx.outputs.map(o => [lockAddr(o.lock), assetStr(o.spend.asset), String(o.spend.amount)]);
    for (const w of tx.witnesses) {
      if (w.type !== 'Contract' || cidStr(w.contractId) !== dex) continue;
      const r = dexRow({ tx: hex(txHash(tx)), block: n, time, command: w.command, body: w.messageBody, outputs, dex, net });
      if (r) rows.push(r);
    }
  }
  return rows;
}

// GET /blockchain/mempool ([{ <hash>: tx JSON }]) -> its Dex rows (block null, confirmations 0)
export function rowsOfMempool(list, dex, net) {
  const rows = [];
  for (const entry of Array.isArray(list) ? list : []) {
    for (const [hash, tx] of Object.entries(entry)) {
      const outputs = (tx.outputs || []).map(o => {
        const l = o.lock, kind = typeof l === 'string' ? l : Object.keys(l || {})[0], v = typeof l === 'string' ? null : l[kind];
        return [(v && typeof v === 'object' && v.address) || kind, o.spend?.asset, String(o.spend?.amount)];
      });
      for (const w of tx.witness || []) {
        const cw = w.ContractWitness;
        if (!cw || cw.contractId !== dex || !cw.messageBodyRaw) continue;
        let body = null;
        try { body = Data.read(new Reader(unhex(cw.messageBodyRaw))); } catch { continue; }
        const r = dexRow({ tx: hash, block: null, time: null, command: cw.command, body, outputs, dex, net });
        if (r) rows.push(r);
      }
    }
  }
  return rows;
}

const round = x => Number(x.toPrecision(12));   // 1.0150000000000001 -> 1.015
const sameOrder = (row, t) => row.under_asset === t.under_asset && row.under_amount === t.under_amount && row.pair_asset === t.pair_asset
  && row.pair_total === t.pair_total && (row.maker || '').toLowerCase() === (t.maker || '').toLowerCase();

// The open orders: the index's rows and the newest blocks' rows whose order asset the Dex holds now (live), newest
// first; then orders made in the mempool (pending). An open order that a mempool Take or Cancel acts on is marked
// (`pendingTake` / `pendingCancel`: that transaction).
export function openOrders({ indexed, recent, mempool, held, tip }) {
  const confs = r => r.block == null ? 0 : tip - r.block + 1;
  const strip = ({ target, ...r }) => r;
  const out = [];
  const seen = new Set();
  for (const r of [...recent].sort((a, b) => b.block - a.block).concat(indexed)) {
    if (!r.order_asset || !held.has(r.order_asset)) continue;
    out.push({ ...strip(r), open: true, pending: false, confirmations: confs(r) });
    seen.add(r.order_asset);
  }
  for (const r of mempool) {
    if (!r.order_asset || seen.has(r.order_asset) || held.has(r.order_asset)) continue;
    out.push({ ...strip(r), open: true, pending: true, confirmations: 0 });
  }
  for (const m of mempool) if (m.command !== 'Make') for (const o of out) if (!o.pending && sameOrder(o, m.target)) o[m.command === 'Take' ? 'pendingTake' : 'pendingCancel'] = m.tx;
  return out;
}

// Fills (Takes) on one market. base/quote: asset ids ('00' = ZP). Taker side: 'buy' = the taker bought base.
// price is quote per base, in whole units (decimals: ZP 8; quote `qdec`, 6 for zUSDC by default).
export function fills(rows, { base, quote, bdec = 8, qdec = 6, tip }) {
  const out = [];
  for (const r of rows) {
    if (r.command !== 'Take' || r.payout == null || r.provided == null) continue;
    const pay = BigInt(r.payout), prov = BigInt(r.provided);
    let side, b, qa;
    if (r.under_asset === base && r.pair_asset === quote) { side = 'buy'; b = pay; qa = prov; }        // the maker sold base; the taker paid quote
    else if (r.under_asset === quote && r.pair_asset === base) { side = 'sell'; b = prov; qa = pay; }  // the maker bought base; the taker paid base
    else continue;
    if (b === 0n) continue;
    const size = Number(b) / 10 ** bdec, value = Number(qa) / 10 ** qdec;
    out.push({ tx: r.tx, block: r.block, time: r.time, side, price: round(value / size), size: String(b), quoteAmount: String(qa), maker: r.maker,
      pending: r.block == null, confirmations: r.block == null ? 0 : tip - r.block + 1 });
  }
  return out;
}

// The book of one market from open orders: asks sell base for quote (ascending price), bids buy base with quote
// (descending). size is in base units.
export function book(orders, { base, quote, bdec = 8, qdec = 6 }) {
  const asks = [], bids = [];
  for (const o of orders) {
    const ua = BigInt(o.under_amount ?? 0), pt = BigInt(o.pair_total ?? 0);
    if (ua === 0n || pt === 0n) continue;
    const flags = { tx: o.tx, maker: o.maker, pending: o.pending, confirmations: o.confirmations, ...(o.pendingTake ? { pendingTake: o.pendingTake } : {}), ...(o.pendingCancel ? { pendingCancel: o.pendingCancel } : {}),
      order: { under_asset: o.under_asset, under_amount: o.under_amount, pair_asset: o.pair_asset, pair_total: o.pair_total, maker: o.maker } };
    if (o.under_asset === base && o.pair_asset === quote) asks.push({ price: round((Number(pt) / 10 ** qdec) / (Number(ua) / 10 ** bdec)), size: String(ua), ...flags });
    else if (o.under_asset === quote && o.pair_asset === base) bids.push({ price: round((Number(ua) / 10 ** qdec) / (Number(pt) / 10 ** bdec)), size: String(pt), ...flags });
  }
  asks.sort((a, b) => a.price - b.price); bids.sort((a, b) => b.price - a.price);
  return { asks, bids };
}
