// The Dex's newest calls before the index has them (site/dex-fresh.mjs):  node --test site/test/dex-fresh.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writer, Transaction, Data, VarInt, hex, unhex, txHash, assetFromId } from '../../wallet/src/serialize.js';
import { encodeAddress } from '../../wallet/src/keys.js';
import { rowsOfRawBlock, rowsOfMempool, openOrders, fills, book } from '../dex-fresh.mjs';

const NET = 'test';
const DEX = '00000001' + 'fd'.repeat(32), USDC = '00000001' + '5a'.repeat(32), OTHER = '00000001' + '77'.repeat(32);
const DEX_ADDR = encodeAddress(unhex(DEX), NET, true);
const MAKER = '02' + '42'.repeat(32), TAKER_HASH = 'aa'.repeat(32);
const cid = id => ({ version: parseInt(id.slice(0, 8), 16), hash: unhex(id.slice(8, 72)) });
const orderAsset = n => DEX + n.toString(16).padStart(2, '0').repeat(32);
const body = (o, extra = {}) => ({ t: 'Dict', v: [
  ['UnderlyingAsset', { t: 'String', v: o.ua }], ['UnderlyingAmount', { t: 'U64', v: BigInt(o.uamt) }], ['PairAsset', { t: 'String', v: o.pa }],
  ['OrderTotal', { t: 'U64', v: BigInt(o.total) }], ['MakerPubKey', { t: 'PublicKey', v: unhex(MAKER) }],
  ...Object.entries(extra).map(([k, v]) => [k, { t: 'U64', v: BigInt(v) }])] });
const out = (lock, asset, amount) => ({ lock, spend: { asset: assetFromId(asset), amount: BigInt(amount) } });
const toDex = (asset, amount) => out({ type: 'Contract', contractId: cid(DEX) }, asset, amount);
const toPk = (asset, amount) => out({ type: 'PK', hash: unhex(TAKER_HASH) }, asset, amount);
const call = (command, msg) => ({ type: 'Contract', contractId: cid(DEX), command, messageBody: msg, stateCommitment: { type: 'NoState' },
  beginInputs: 0, beginOutputs: 0, inputsLength: 0, outputsLength: 0, signature: null, cost: 100n });
const tx = (outputs, witnesses) => ({ version: 0, inputs: [{ type: 'outpoint', outpoint: { txHash: new Uint8Array(32), index: 0 } }], outputs, contract: null, witnesses });
function block(n, time, txs) {
  const w = new Writer(), h = new Uint8Array(100), dv = new DataView(h.buffer);
  dv.setUint32(36, n); dv.setBigUint64(72, BigInt(time));
  w.bytes(h); VarInt.write(w, 0); VarInt.write(w, txs.length); for (const t of txs) Transaction.write(w, t);
  return hex(w.out());
}

// an ask: 40 ZP for 40.4 zUSDC; a bid: 39.6 zUSDC for 40 ZP
const ask = { ua: '00', uamt: 40e8, pa: USDC, total: 40_400000 }, bid = { ua: USDC, uamt: 39_600000, pa: '00', total: 40e8 };
const makeAsk = tx([toDex('00', ask.uamt), toDex(orderAsset(1), 1)], [call('Make', body(ask))]);
const makeBid = tx([toDex(USDC, bid.uamt), toDex(orderAsset(2), 1)], [call('Make', body(bid))]);
// a taker sells 10 ZP to the bid: gets 9.9 zUSDC; the remainder (29.7 zUSDC for 30 ZP) is a new order
const takeBid = tx([toPk(USDC, 9_900000), toDex(orderAsset(3), 1)], [call('Take', body(bid, { RequestedPayout: 9_900000, ProvidedAmount: 10e8 }))]);
const raw = block(2500, 1760540000000, [makeAsk, makeBid, takeBid]);

test('rows of a raw block: Make and Take, with the remainder of a part fill', () => {
  const rows = rowsOfRawBlock(2500, raw, DEX, NET);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(r => r.command), ['Make', 'Make', 'Take']);
  assert.equal(rows[0].tx, hex(txHash(makeAsk)));
  assert.equal(rows[0].block, 2500); assert.equal(rows[0].time, 1760540000000);
  assert.equal(rows[0].order_asset, orderAsset(1)); assert.equal(rows[0].under_amount, '4000000000'); assert.equal(rows[0].maker, MAKER);
  assert.equal(rows[2].under_amount, '29700000'); assert.equal(rows[2].pair_total, '3000000000');
  assert.equal(rows[2].payout, '9900000'); assert.equal(rows[2].provided, '1000000000'); assert.equal(rows[2].order_asset, orderAsset(3));
  assert.equal(rows[2].target.under_amount, '39600000');
});

test('rows of another contract are ignored', () => {
  assert.deepEqual(rowsOfRawBlock(2500, raw, OTHER, NET), []);
});

// the mempool as the node's JSON gives it
const jsonTx = (t, hash) => ({ [hash]: {
  outputs: t.outputs.map(o => ({ lock: o.lock.type === 'Contract' ? { Contract: { id: DEX, address: DEX_ADDR } } : { PK: { hash: TAKER_HASH, address: 'tzn1x' } },
    spend: { asset: o.spend.asset.contract.version === 0 && o.spend.asset.contract.hash.every(x => !x) ? '00' : (o.spend.asset.contract.version >>> 0).toString(16).padStart(8, '0') + hex(o.spend.asset.contract.hash) + (o.spend.asset.subtype.every(x => !x) ? '' : hex(o.spend.asset.subtype)), amount: Number(o.spend.amount) } })),
  witness: t.witnesses.map(w => ({ ContractWitness: { contractId: DEX, command: w.command, messageBodyRaw: (() => { const x = new Writer(); Data.write(x, w.messageBody); return hex(x.out()); })() } })) } });

test('rows of the mempool JSON (body read from messageBodyRaw)', () => {
  const rows = rowsOfMempool([jsonTx(makeAsk, 'ab'.repeat(32))], DEX, NET);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].block, null); assert.equal(rows[0].order_asset, orderAsset(1)); assert.equal(rows[0].pair_total, '40400000');
});

test('open orders: indexed and newest, held live; mempool makes pending; a mempool Take marks its order', () => {
  const recent = rowsOfRawBlock(2500, raw, DEX, NET);
  const indexed = [{ tx: 'old', block: 2480, command: 'Make', under_asset: USDC, under_amount: '19800000', pair_asset: '00', pair_total: '2000000000', maker: MAKER, order_asset: orderAsset(9) }];
  const pendingMake = rowsOfMempool([jsonTx(tx([toDex('00', 1e8), toDex(orderAsset(4), 1)], [call('Make', body({ ua: '00', uamt: 1e8, pa: USDC, total: 1_020000 }))]), 'cd'.repeat(32))], DEX, NET);
  const pendingTake = rowsOfMempool([jsonTx(tx([toPk('00', 1e8)], [call('Take', body(ask, { RequestedPayout: 1e8, ProvidedAmount: 1_010000 }))]), 'ef'.repeat(32))], DEX, NET);
  // the bid (2) was taken in part: the Dex holds 1 (ask), 3 (remainder) and 9 (indexed), not 2
  const held = new Set([orderAsset(1), orderAsset(3), orderAsset(9)]);
  const orders = openOrders({ indexed, recent, mempool: [...pendingMake, ...pendingTake], held, tip: 2509 });
  assert.deepEqual(orders.map(o => o.order_asset), [orderAsset(1), orderAsset(3), orderAsset(9), orderAsset(4)]);
  assert.deepEqual(orders.map(o => o.confirmations), [10, 10, 30, 0]);
  assert.deepEqual(orders.map(o => o.pending), [false, false, false, true]);
  assert.equal(orders[0].pendingTake, 'ef'.repeat(32));
  assert.ok(!('target' in orders[0]));
  // the same order asset in the newest rows and the index: once while the Dex holds one unit, twice with two
  const dup = [{ ...recent[0], block: 2490 }];
  assert.equal(openOrders({ indexed: dup, recent, mempool: [], held: new Map([[orderAsset(1), 1]]), tip: 2509 }).filter(o => o.order_asset === orderAsset(1)).length, 1);
  const copy = [{ ...recent[0], tx: 'copy', block: 2490 }];
  assert.equal(openOrders({ indexed: copy, recent, mempool: [], held: new Map([[orderAsset(1), 2]]), tip: 2509 }).filter(o => o.order_asset === orderAsset(1)).length, 2);
});

test('fills: Takes only, with the taker side, price and size', () => {
  const recent = rowsOfRawBlock(2500, raw, DEX, NET);
  const f = fills(recent, { base: '00', quote: USDC, tip: 2509 });
  assert.equal(f.length, 1);
  assert.equal(f[0].side, 'sell'); assert.equal(f[0].size, '1000000000'); assert.equal(f[0].quoteAmount, '9900000');
  assert.equal(f[0].price.toFixed(4), '0.9900'); assert.equal(f[0].confirmations, 10);
  // a taker buying ZP from an ask
  const buy = fills([{ tx: 'b', block: 2501, command: 'Take', under_asset: '00', pair_asset: USDC, payout: '500000000', provided: '5050000' }], { base: '00', quote: USDC, tip: 2509 });
  assert.equal(buy[0].side, 'buy'); assert.equal(buy[0].size, '500000000'); assert.equal(buy[0].price.toFixed(4), '1.0100');
  assert.deepEqual(fills(recent, { base: '00', quote: OTHER, tip: 2509 }), []);
});

test('book: asks ascending, bids descending, in whole-unit prices', () => {
  const o = (ua, uamt, pa, total, extra = {}) => ({ under_asset: ua, under_amount: String(uamt), pair_asset: pa, pair_total: String(total), maker: MAKER, pending: false, confirmations: 3, ...extra });
  const b = book([o('00', 40e8, USDC, 40_800000), o('00', 40e8, USDC, 40_400000), o(USDC, 39_200000, '00', 40e8), o(USDC, 39_600000, '00', 40e8, { pendingTake: 'x' }), o(OTHER, 1, '00', 1)],
    { base: '00', quote: USDC });
  assert.deepEqual(b.asks.map(a => a.price.toFixed(3)), ['1.010', '1.020']);
  assert.deepEqual(b.bids.map(a => a.price.toFixed(3)), ['0.990', '0.980']);
  assert.equal(b.asks[0].size, '4000000000'); assert.equal(b.bids[0].size, '4000000000'); assert.equal(b.bids[0].pendingTake, 'x');
});
