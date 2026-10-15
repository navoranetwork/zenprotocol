// ZenDex bodies byte for byte as scripts/v1/dex-take.mjs builds them (that script took an order on the testnet), the
// payout rule, and the checks on what the Dex adds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { orderOf, takeBody, makeBody, payoutFor, pkHashOf, expectTake, expectCancel, expectMake } from '../src/dex.js';
import { Writer, Data, hex, unhex, assetFromId } from '../src/serialize.js';

// the encoder of scripts/v1/dex-take.mjs, copied
function varint(n) { const t = []; let len = 0; for (;;) { t[len] = (n & 0x7f) | (len ? 0x80 : 0); if (n <= 0x7f) break; n = Math.floor(n / 128) - 1; len++; } return Buffer.from(t.reverse()); }
const str = s => Buffer.concat([varint(Buffer.byteLength(s)), Buffer.from(s, 'utf8')]);
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return Buffer.concat([Buffer.of(5), b]); };
const string = s => Buffer.concat([Buffer.of(6), str(s)]);
const publicKey = k => Buffer.concat([Buffer.of(10), Buffer.from(k, 'hex')]);
const pkLock = h => Buffer.concat([Buffer.of(8), varint(2), varint(32), Buffer.from(h, 'hex')]);
const dict = o => { const ks = Object.keys(o).sort((a, b) => a.length - b.length || (a < b ? -1 : 1)); return Buffer.concat([Buffer.of(12), varint(ks.length), ...ks.flatMap(k => [str(k), o[k]])]).toString('hex'); };
const enc = d => { const w = new Writer(); Data.write(w, d); return hex(w.out()); };

const ZUSDC = '000000015ab27aa3af287880c1853e3b2e948349ce27cae9e533fd27fbf6520ddad0d577';
const MAKER = '02' + 'ab'.repeat(32);
const bid = orderOf({ under_asset: ZUSDC, under_amount: '9900000', pair_asset: '00', pair_total: '10000000000', maker: MAKER, tx: 'aa'.repeat(32), block: 2500 });   // 9.9 zUSDC for 100 ZP

test('Take: body as the testnet script builds it; payout floor(under * provided / total)', () => {
  const me = 'cd'.repeat(32), provided = 1000000000n;   // sell 10 ZP
  const { body, payout } = takeBody(bid, provided, unhex(me));
  assert.equal(payout, 990000n);
  assert.equal(payoutFor(bid, 333333333n), 9900000n * 333333333n / 10000000000n);
  assert.equal(enc(body), dict({ UnderlyingAsset: string(ZUSDC), UnderlyingAmount: u64(9900000n), PairAsset: string('00'), OrderTotal: u64(10000000000n),
    MakerPubKey: publicKey(MAKER), RequestedPayout: u64(payout), ProvidedAmount: u64(provided), returnAddress: pkLock(me) }));
  assert.throws(() => takeBody(bid, 0n, unhex(me)), /Give between/);
  assert.throws(() => takeBody(bid, 10000000001n, unhex(me)), /Give between/);
  assert.throws(() => takeBody(bid, 1n, unhex(me)), /pays? out nothing|too little/);
  assert.equal(enc(makeBody(bid)), dict({ UnderlyingAsset: string(ZUSDC), UnderlyingAmount: u64(9900000n), PairAsset: string('00'), OrderTotal: u64(10000000000n), MakerPubKey: publicKey(MAKER) }));
});

test('orders from the index are checked', () => {
  assert.throws(() => orderOf({ under_asset: '00', under_amount: '1', pair_asset: '00', pair_total: '1', maker: MAKER }), /bad assets/);
  assert.throws(() => orderOf({ under_asset: '00', under_amount: '0', pair_asset: ZUSDC, pair_total: '1', maker: MAKER }), /bad amounts/);
  assert.throws(() => orderOf({ under_asset: '00', under_amount: '1', pair_asset: ZUSDC, pair_total: '1', maker: '04ab' }), /maker/);
  assert.equal(pkHashOf(MAKER), createHash('sha3-256').update(Buffer.from(MAKER, 'hex')).digest('hex'));
});

test('what the Dex adds is checked before signing', () => {
  const dex = { version: 1, hash: unhex('fd'.repeat(32)) }, me = 'cd'.repeat(32), makerHash = pkHashOf(MAKER);
  const out = (lock, asset, amount) => ({ lock, spend: { asset: assetFromId(asset), amount } });
  const toDex = { type: 'Contract', contractId: dex }, toMe = { type: 'PK', hash: unhex(me) }, toMaker = { type: 'PK', hash: unhex(makerHash) };
  const good = { inputs: [], outputs: [out(toMe, ZUSDC, 990000n), out(toMaker, '00', 1000000000n), out(toDex, ZUSDC, 8910000n)] };
  const take = expectTake(bid, 1000000000n, 990000n, me);
  take(good, dex);
  assert.throws(() => take({ inputs: [], outputs: [out(toMe, ZUSDC, 980000n), out(toMaker, '00', 1000000000n)] }, dex), /not pay you/);
  assert.throws(() => take({ inputs: [], outputs: [...good.outputs, out({ type: 'PK', hash: unhex('ee'.repeat(32)) }, '00', 1n)] }, dex), /someone else/);
  assert.throws(() => take({ inputs: [], outputs: [out(toMe, ZUSDC, 990000n), out(toMaker, '00', 999999999n)] }, dex), /maker/);
  const mine = orderOf({ under_asset: ZUSDC, under_amount: '9900000', pair_asset: '00', pair_total: '10000000000', maker: MAKER });
  expectCancel(mine, makerHash)({ inputs: [], outputs: [out({ type: 'PK', hash: unhex(makerHash) }, ZUSDC, 9900000n), { lock: { type: 'Destroy' }, spend: { asset: assetFromId(ZUSDC), amount: 1n } }] }, dex);
  assert.throws(() => expectCancel(mine, makerHash)({ inputs: [], outputs: [out({ type: 'PK', hash: unhex(makerHash) }, ZUSDC, 1n)] }, dex), /whole order/);
  expectMake(mine)({ inputs: [], outputs: [out(toDex, ZUSDC, 9900000n), out(toDex, ZUSDC, 1n)] }, dex);
  assert.throws(() => expectMake(mine)({ inputs: [], outputs: [out(toMe, ZUSDC, 9900000n)] }, dex), /elsewhere/);
});

// ---- the order book
import { bookFromOrders, levels, parsePrice, limitOrder, takeFor } from '../src/dex.js';
test('order book: asks and bids of ZP/zUSDC, levels by tick, limit orders, take amounts', () => {
  const ZU = '000000015ab27aa3af287880c1853e3b2e948349ce27cae9e533fd27fbf6520ddad0d577', mk = '02' + 'ab'.repeat(32);
  const o = (under, ua, pair, pt, tx) => orderOf({ under_asset: under, under_amount: String(ua), pair_asset: pair, pair_total: String(pt), maker: mk, tx });
  const orders = [o('00', 40e8, ZU, 40.4e6, 'a1'), o('00', 40e8, ZU, 40.6e6, 'a2'), o('00', 10e8, ZU, 10.1e6, 'a3'), o(ZU, 39.6e6, '00', 40e8, 'b1'), o(ZU, 39.4e6, '00', 40e8, 'b2'), o('00', 1e8, '00'.padEnd(72, '1'), 5, 'x')];
  const b = bookFromOrders(orders, ZU);
  assert.deepEqual(b.asks.map(r => [r.o.tx, +r.price.toFixed(6)]), [['a1', 1.01], ['a3', 1.01], ['a2', 1.015]]);
  assert.deepEqual(b.bids.map(r => [r.o.tx, +r.price.toFixed(6)]), [['b1', 0.99], ['b2', 0.985]]);
  const la = levels(b.asks, 'ask');
  assert.equal(la.length, 2); assert.equal(la[0].size, 50n * 100000000n); assert.equal(la[1].total, 90n * 100000000n); assert.ok(Math.abs(la[0].price - 1.01) < 1e-9);
  assert.equal(parsePrice('1.0125'), 101250000n); assert.throws(() => parsePrice('abc'));
  assert.deepEqual(limitOrder({ side: 'sell', price8: parsePrice('1.02'), amount: 5e8, quote: ZU }), { underAsset: '00', underAmount: 500000000n, pairAsset: ZU, pairTotal: 5100000n });
  assert.deepEqual(limitOrder({ side: 'buy', price8: parsePrice('0.98'), amount: 5e8, quote: ZU }), { underAsset: ZU, underAmount: 4900000n, pairAsset: '00', pairTotal: 500000000n });
  assert.throws(() => limitOrder({ side: 'sell', price8: parsePrice('1'), amount: 5e7, quote: ZU }), /At least 1 ZP/);
  assert.throws(() => limitOrder({ side: 'sell', price8: parsePrice('0.001'), amount: 2e8, quote: ZU }), /0.01/);
  const buy = takeFor(b.asks[0], 10e8);   // 10 ZP from the 1.01 ask: 10.1 zUSDC
  assert.deepEqual(buy, { provided: 10100000n, payout: 1000000000n });
  assert.deepEqual(takeFor(b.asks[0], 100e8), { provided: 40400000n, payout: 4000000000n });   // capped at the whole order
  assert.deepEqual(takeFor(b.bids[0], 10e8), { provided: 1000000000n, payout: 9900000n });     // sell 10 ZP into the 0.99 bid
});
