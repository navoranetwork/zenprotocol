// Up / Down bets: markets, the best offer, the quote, and the Redeem body.
import test from 'node:test';
import assert from 'node:assert/strict';
import { marketOf, bestOffer, offerPrice, betQuote, redeemBody, winner, eventFields } from '../src/bets.js';
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

test('Redeem: the event, the side and the oracle proof; it serializes', () => {
  const m = marketOf(row), proof = { valueScaled: 67250000, timestamp: 1792200000000, root: 'ee'.repeat(32), index: 3, auditPath: ['01'.repeat(32), '02'.repeat(32)] };
  const body = redeemBody(m.event, 'up', proof);
  const keys = body.v.map(([k]) => k);
  assert.deepEqual(keys.slice(7), ['Position', 'Timestamp', 'Root', 'Value', 'Index', 'AuditPath']);
  assert.equal(body.v.find(([k]) => k === 'Position')[1].v, 'Bull');
  const w = new Writer(); Data.write(w, body); assert.ok(w.len > 200);
  assert.equal(winner(m.event, proof.valueScaled), 'up'); assert.equal(winner(m.event, 66999999), 'down'); assert.equal(winner(m.event, 67000000), 'up');
  assert.throws(() => redeemBody(m.event, 'up', { ...proof, timestamp: 1 }), /not for the close/);
  assert.throws(() => redeemBody(m.event, 'up', { ...proof, auditPath: Array(31).fill('01'.repeat(32)) }), /Bad oracle proof/);
});
