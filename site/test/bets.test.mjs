// FixedPayout V1 markets, the pure parts (site/bets/core.mjs):  node --test site/test/bets.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { tokenSubtype, tokens, lineOf, priceOf, nextCloses, isWeekday, stateOf, winnerOf, attestSubtype, D, bodies } from '../bets/core.mjs';
import { Writer, Lock, Reader, Data } from '../../wallet/src/serialize.js';

const sha3 = s => createHash('sha3-256').update(Buffer.from(s, 'utf8')).digest('hex');
// the market of scripts/v1/fixedpayout-try.mjs, whose position tokens the engine printed on dab00f8
const tryMarket = { oraclePubKey: '03774ae7f858a9411e5ef4246b70c65aac5649980be5c17891bbec17895da008cb', oracleId: '00000001' + sha3('a test V1 oracle contract'),
  ticker: 'BTC', price: 110000000, close: 1791900000000, collateral: '00000001' + sha3('a test token for FixedPayout') };

test('token subtypes match the engine (fixedpayout-try on dab00f8: Bull d7bdba35…a61b, Bear af11bcc4…a6b6)', () => {
  assert.equal(tokenSubtype(tryMarket, 'Bull'), 'd7bdba354763fd95b0c57d78eadfab3737dab93013be4dc926c7abb103d3a61b');
  assert.equal(tokenSubtype(tryMarket, 'Bear'), 'af11bcc4c50eaffb6bca1edac133745934a170318346cf1b7df86ddd54519ab6');
  const t = tokens('00000001' + 'ab'.repeat(32), tryMarket);
  assert.equal(t.bull, '00000001' + 'ab'.repeat(32) + 'd7bdba354763fd95b0c57d78eadfab3737dab93013be4dc926c7abb103d3a61b');
  assert.equal(new Set(Object.values(t)).size, 5);
});

test('lines: the value to 3 significant digits; Price is the line x 1000', () => {
  assert.equal(lineOf(82396), 82400); assert.equal(lineOf(2453.88), 2450); assert.equal(lineOf(1.119422), 1.12);
  assert.equal(lineOf(4181.929725), 4180); assert.equal(lineOf(0), null);
  assert.equal(priceOf(82400), 82400000); assert.equal(priceOf(1.12), 1120);
});

test('closes: the next 22:00 UTC at least 12 h ahead; daily tickers only on weekdays', () => {
  const fri10 = Date.UTC(2026, 9, 16, 10, 0);                       // Friday 10:00 UTC
  assert.deepEqual(nextCloses(fri10, 22), [Date.UTC(2026, 9, 16, 22)]);
  const fri11 = Date.UTC(2026, 9, 16, 11, 0);                       // less than 12 h before 22:00: tomorrow's
  assert.deepEqual(nextCloses(fri11, 22), [Date.UTC(2026, 9, 17, 22)]);
  assert.equal(isWeekday(Date.UTC(2026, 9, 17, 22)), false); assert.equal(isWeekday(Date.UTC(2026, 9, 16, 22)), true);
});

test('state from the markers the contract holds and the time', () => {
  const m = { close: 1000, tokens: tokens('00000001' + 'ab'.repeat(32), tryMarket) };
  assert.deepEqual(stateOf(m, new Set(), 500), { status: 'open', result: null });
  assert.deepEqual(stateOf(m, new Set(), 2000), { status: 'closing', result: null });
  assert.deepEqual(stateOf(m, new Set(), 1000 + 86400001), { status: 'voidable', result: null });
  assert.deepEqual(stateOf(m, new Set([m.tokens.bullWon]), 2000), { status: 'settled', result: 'bull' });
  assert.deepEqual(stateOf(m, new Set([m.tokens.void]), 1000 + 86400001), { status: 'void', result: null });
});

test('the winner: Bull at or above the line', () => {
  assert.equal(winnerOf(110000000, '110000000'), 'Bull'); assert.equal(winnerOf(110000000, '109999999'), 'Bear');
});

test('the attestation subtype as fixedpayout-try computes it (it passed on dab00f8)', () => {
  const root = 'aa'.repeat(32), ts = 1791900000000, k = tryMarket.oraclePubKey;
  const be64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
  const h = (...p) => createHash('sha3-256').update(Buffer.concat(p.map(x => typeof x === 'string' ? Buffer.from(x, 'hex') : x))).digest('hex');
  assert.equal(attestSubtype(root, ts, k), h(h(h(root, be64(ts)), k)));
});

test('a contract lock in a body reads back as the wallet serializer writes it', () => {
  const id = '00000001' + 'cd'.repeat(32);
  const w = new Writer(); Lock.write(w, { type: 'Contract', contractId: { version: 1, hash: Buffer.from('cd'.repeat(32), 'hex') } });
  assert.equal(D.contractLock(id).toString('hex'), '08' + Buffer.from(w.out()).toString('hex'));
  const body = Data.read(new Reader(Buffer.from(bodies.attest('aa'.repeat(32), 1, tryMarket.oraclePubKey, id), 'hex')));
  assert.equal(body.t, 'Dict'); assert.deepEqual(body.v.map(([k]) => k).sort(), ['Commit', 'Recipient', 'OraclePubKey'].sort());
});

import { linesOf, normCdf, fairUp, quotesFor, planQuotes, orderPrice } from '../bets/core.mjs';

test('lines: the value and ±1 %, ±3 %, to 3 digits, no repeats', () => {
  assert.deepEqual(linesOf(81981, [0, -0.01, 0.01, -0.03, 0.03]), [79500, 81200, 82000, 82800, 84400]);
  assert.deepEqual(linesOf(1.1702, [0, -0.01, 0.01, -0.03, 0.03]), [1.14, 1.16, 1.17, 1.18, 1.21]);
  assert.deepEqual(linesOf(100, [0, 0.001]), [100]);
});

test('fair price of Up: N(d2)', () => {
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-7 && Math.abs(normCdf(1.96) - 0.9750021) < 1e-6 && Math.abs(normCdf(-1) - 0.1586553) < 1e-6);
  const day = 86400000;
  const atLine = fairUp(82000, 82000, day, 0.55);                   // slightly below 0.5 (the -s^2/2 term)
  assert.ok(atLine < 0.5 && atLine > 0.49);
  const above = fairUp(84000, 82000, day, 0.55);                   // 2.4 % above, a day's sd 2.9 %: about 0.79
  assert.ok(above > 0.78 && above < 0.80);
  assert.ok(fairUp(84000, 82000, 600000, 0.55) > 0.999);            // the same with 10 minutes left: almost sure
  assert.equal(fairUp(81000, 82000, 0, 0.55), 0);
  assert.equal(fairUp(82000, 82000, 0, 0.55), 1);                   // Up wins at the line
});

test('quotes: a spread around p, on cents, asks at most 0.99, no bid below 0.01', () => {
  assert.deepEqual(quotesFor(0.5), { up: { bid: 0.47, ask: 0.53 }, down: { bid: 0.47, ask: 0.53 } });
  assert.deepEqual(quotesFor(0.84), { up: { bid: 0.81, ask: 0.87 }, down: { bid: 0.13, ask: 0.19 } });
  assert.deepEqual(quotesFor(0.999), { up: { bid: 0.96, ask: 0.99 }, down: { bid: null, ask: 0.04 } });
  assert.deepEqual(quotesFor(0.5, { spread: 0.1 }).up, { bid: 0.45, ask: 0.55 });
});

test('plan: keep what is near its target, cancel the rest, make the missing slots, leave pending ones', () => {
  const C = 'cc', bull = 'bu', bear = 'be', o = (under, ua, pair, pt, extra = {}) => ({ under_asset: under, under_amount: String(ua), pair_asset: pair, pair_total: String(pt), maker: 'k', ...extra });
  const want = quotesFor(0.84);                                      // Up 0.81/0.87, Down 0.13/0.19
  const mine = [
    o(bull, 2000000, C, 1100000),                                    // the old static Up ask at 0.55: far, cancel
    o(bear, 2000000, C, 1100000),                                    // Down ask at 0.55: far, cancel
    o(C, 8100000, bull, 10000000),                                   // Up bid at 0.81: keep
    o(C, 1500000, bear, 10000000, { pending: true }),                // Down bid at 0.15, in the mempool: leave, slot waits
  ];
  assert.equal(orderPrice(mine[0], 'ask'), 0.55); assert.equal(orderPrice(mine[2], 'bid'), 0.81);
  const p = planQuotes(want, mine, { bull, bear, collateral: C, move: 0.03 });
  assert.deepEqual(p.cancels.map(c => `${c.name} ${c.side}`), ['up ask', 'down ask']);
  assert.deepEqual(p.makes.map(k => `${k.name} ${k.side} ${k.price}`), ['up ask 0.87', 'down ask 0.19']);
  const small = planQuotes(want, mine, { bull, bear, collateral: C, move: 0.03, minSize: 2500000 });   // the 0.81 bid has 10 left: kept
  assert.deepEqual(small.cancels.length, 2);
  const tiny = planQuotes(quotesFor(0.5), [o(bull, 2000000, C, 1100000)], { bull, bear, collateral: C, minSize: 2500000 });   // 2 left at 0.55, near 0.53: made again in full
  assert.deepEqual([tiny.cancels.length, tiny.makes.length], [1, 4]);
  const stop = planQuotes(null, mine, { bull, bear, collateral: C });   // stop quoting: cancel all that can be cancelled
  assert.deepEqual(stop.cancels.length, 3); assert.deepEqual(stop.makes, []);
});

import { spreadFor, medianOf } from '../bets/core.mjs';
test('spread: wider on a fast move, near the close, with one source; capped', () => {
  const day = 86400000;
  assert.equal(spreadFor(0.06, { vol: 0.55, move: 0, msLeft: day }), 0.06);
  // BTC 0.55 a year: 5 minutes' sd is about 0.0021; a 0.5 % move is about 2.4 sd
  assert.ok(Math.abs(spreadFor(0.06, { vol: 0.55, move: 0.005, minutes: 5, msLeft: day }) - 0.06 * 0.005 / (0.55 * Math.sqrt(5 / 525960))) < 1e-9);
  assert.equal(spreadFor(0.06, { vol: 0.55, move: 0.05, minutes: 5, msLeft: day }), 0.18);      // at most 3x
  assert.ok(Math.abs(spreadFor(0.06, { vol: 0.55, msLeft: 5400000 }) - 0.09) < 1e-12);
  assert.equal(spreadFor(0.06, { vol: 0.55, msLeft: 1800000 }), 0.12);
  assert.ok(Math.abs(spreadFor(0.06, { vol: 0.55, msLeft: day, sources: 1 }) - 0.09) < 1e-12);
  assert.equal(spreadFor(0.06, { vol: 0.55, move: 0.05, msLeft: 1800000, sources: 1 }), 0.3);
  assert.equal(medianOf([3, 1, 2]), 2); assert.equal(medianOf([1, 3]), 2); assert.equal(medianOf([0, NaN]), null);
});
