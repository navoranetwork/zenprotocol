// Up / Down bets: markets, the best offer, the quote, and the Redeem body.
import test from 'node:test';
import assert from 'node:assert/strict';
import { marketOf, marketsOf, bestOffer, offerPrice, betQuote, redeemBody, redeemValue, eventFields } from '../src/bets.js';
import { Data, Writer } from '../src/serialize.js';

const Z = 'aa'.repeat(36) + 'bb'.repeat(32), BULL = 'cc'.repeat(36) + '01'.repeat(32), BEAR = 'cc'.repeat(36) + '02'.repeat(32);
const ev = { OraclePubKey: '02' + '11'.repeat(32), OracleContractId: 'dd'.repeat(36), Ticker: 'BTC', Price: 67000000, Start: 1792200000000, Expiry: 1792200000000, Collateral: Z };
const row = { event: ev, bull: BULL, bear: BEAR, status: 'open', result: null };

test('a market row: event checked, strike from Price / 1000', () => {
  const m = marketOf(row);
  assert.equal(m.strike, 67000); assert.equal(m.close, 1792200000000); assert.equal(m.status, 'open');
  assert.throws(() => marketOf({ ...row, bull: BEAR }), /position tokens/);
  assert.throws(() => marketOf({ ...row, event: { ...ev, Ticker: 'bitcoin' } }), /ticker/);
  assert.throws(() => marketOf({ ...row, event: { ...ev, OraclePubKey: 'zz' } }), /oracle key/);
  assert.throws(() => marketOf({ ...row, event: { ...ev, Expiry: ev.Start + 3600000 } }), /both be the close/);
  assert.deepEqual(eventFields(m.event).map(([k]) => k), ['OraclePubKey', 'OracleContractId', 'Ticker', 'Price', 'Start', 'Expiry', 'Collateral']);
});

test('the best offer is the cheapest token for zUSDC; the quote pays 1 zUSDC per token', () => {
  const o = (u, p, extra = {}) => ({ underAsset: BULL, underAmount: BigInt(u), pairAsset: Z, pairTotal: BigInt(p), tx: String(u) + ':' + p, ...extra });
  const orders = [o(100e6, 70e6), o(50e6, 30e6), o(10e6, 1e6, { pending: true }), { ...o(10e6, 1e6), pairAsset: '00' }, { ...o(20e6, 2e6), underAsset: BEAR }];
  const b = bestOffer(orders, BULL, Z);
  assert.equal(b.tx, '50000000:30000000'); assert.equal(offerPrice(b), 0.6);
  const q = betQuote(b, 6000000n);   // 6 zUSDC at 0.60
  assert.deepEqual([q.tokens, q.payout, q.profit], [10000000n, 10000000n, 4000000n]);
  assert.throws(() => betQuote(b, 31000000n), /More than this offer/);
  assert.throws(() => betQuote(b, 0n), /Enter an amount/);
  assert.equal(bestOffer(orders, BEAR, '00'), null);
});

test('Redeem: the market and the side, no proof; it pays 1 per winning token, 1/2 after a void', () => {
  const m = marketOf(row), body = redeemBody(m.event, 'up');
  assert.deepEqual(body.v.map(([k]) => k), ['OraclePubKey', 'OracleContractId', 'Ticker', 'Price', 'Start', 'Expiry', 'Collateral', 'Position']);
  assert.equal(body.v.at(-1)[1].v, 'Bull'); assert.equal(redeemBody(m.event, 'down').v.at(-1)[1].v, 'Bear');
  const w = new Writer(); Data.write(w, body); assert.ok(w.len > 100);
  assert.equal(redeemValue(m, 'up', 5n), null);                                         // open
  assert.equal(redeemValue({ ...m, status: 'closed' }, 'up', 5n), null);                // waiting for Settle
  const won = { ...m, status: 'settled', result: 'bull' };
  assert.deepEqual([redeemValue(won, 'up', 5000000n), redeemValue(won, 'down', 5000000n)], [5000000n, 0n]);
  const v = { ...m, status: 'void' };
  assert.deepEqual([redeemValue(v, 'up', 5000001n), redeemValue(v, 'down', 3n)], [2500000n, 1n]);   // rounded down
});

test('the explorer answer: contractId and collateral at the top, statuses, the books', () => {
  const j = { contract: 'czen1xyz', contractId: 'ee'.repeat(36), collateral: Z, graceMs: 86400000,
    markets: [{ ...row, line: 67000, status: 'closing', book: { up: { ask: 0.6, bid: 0.55 }, down: { ask: null, bid: 7 } } }, { ...row, bull: 'zz' }, { ...row, status: 'voidable' }] };
  const ms = marketsOf(j);
  assert.equal(ms.length, 2);
  assert.equal(ms[0].contract, 'ee'.repeat(36)); assert.equal(ms[0].status, 'closing'); assert.deepEqual(ms[0].book, { up: { ask: 0.6, bid: 0.55 }, down: { ask: null, bid: null } });
  assert.equal(ms[1].status, 'voidable'); assert.equal(redeemValue(ms[1], 'up', 4n), null);   // not void yet: nothing to collect
  assert.equal(marketsOf({ ...j, collateral: '00' }).length, 0);                               // rows in another collateral are refused
});
