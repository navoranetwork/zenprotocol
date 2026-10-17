// The FPMM math (site/bets/fpmm.mjs) against the shared vectors of docs/BETS-FPMM.md, and its invariants
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { seed, buy, sell, sellFor, withdraw, feeBps } from '../bets/fpmm.mjs';

const doc = fs.readFileSync(new URL('../../docs/BETS-FPMM.md', import.meta.url), 'utf8');
const vectors = JSON.parse(doc.split('```json vectors')[1].split('```')[0]);
const B = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' && /^\d+$/.test(v) ? BigInt(v) : v]));
const S = r => JSON.parse(JSON.stringify(r, (_, v) => typeof v === 'bigint' ? String(v) : v));

test('the shared vectors of docs/BETS-FPMM.md', () => {
  for (const v of vectors) {
    const a = B(v.in);
    const got = v.op === 'seed' ? seed(a.n, a.oddsBps) : v.op === 'buy' ? buy(a.rUp, a.rDown, a.side, a.x, a.minOut ?? 0n)
      : v.op === 'sell' ? sell(a.rUp, a.rDown, a.side, a.amount, a.maxIn) : v.op === 'sellFor' ? sellFor(a.rUp, a.rDown, a.side, a.tokens)
      : { amount: withdraw(a.shares, a.seed, a.rUp, a.rDown, a.result) };
    assert.deepEqual(S(got), v.out, v.name);
  }
  assert.ok(vectors.length >= 15);
});

test('invariants on random trades: k never falls, the pairs always cover both sides', () => {
  let x = 12345;
  const rnd = n => { x = (x * 1103515245 + 12345) % 2147483648; return BigInt(x % n); };
  for (let run = 0; run < 200; run++) {
    const s = seed(BigInt(1 + Number(rnd(300))) * 1000000n, 1000n + rnd(8000));
    let { rUp, rDown } = s;
    let outUp = s.backUp, outDown = s.backDown;                         // tokens held outside the reserve
    for (let i = 0; i < 40; i++) {
      const side = rnd(2) ? 'up' : 'down', k = rUp * rDown;
      if (rnd(3)) {
        const r = buy(rUp, rDown, side, 1n + rnd(20000000)); if (r.error) continue;
        if (side === 'up') outUp += r.out; else outDown += r.out;
        ({ rUp, rDown } = r);
      } else {
        const held = side === 'up' ? outUp : outDown; if (held === 0n) continue;
        const r = sellFor(rUp, rDown, side, 1n + rnd(Number(held))); if (r.error) continue;
        if (side === 'up') outUp -= r.in; else outDown -= r.in;
        ({ rUp, rDown } = r);
      }
      assert.ok(rUp * rDown >= k, 'k fell');
      assert.ok(rUp > 0n && rDown > 0n);
    }
    // every Up and every Down is backed by one pair: reserve + outside is the same on both sides
    assert.equal(rUp + outUp, rDown + outDown);
    // the winner's tokens never exceed the collateral: Withdraw + Redeem of all = the pairs
    const pairsNow = rUp + outUp;
    assert.equal(withdraw(1n, 1n, rUp, rDown, 'up') + outUp, pairsNow);
  }
});

test('fee: 2% at 50%, less towards the edges', () => {
  assert.equal(feeBps(100n, 100n), 200n); assert.equal(feeBps(900n, 100n), 40n); assert.equal(feeBps(1n, 999n), 0n);
});
