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
