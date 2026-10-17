// The DPM math (site/bets/dpm.mjs) against the shared vectors of docs/BETS-DPM.md, and the solvency asserts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isqrt, buy, sell, settle, redeem, refund, prices, payoutPerShare, payoutPerShareNet } from '../bets/dpm.mjs';

const doc = fs.readFileSync(new URL('../../docs/BETS-DPM.md', import.meta.url), 'utf8');
const vectors = JSON.parse(doc.split('```json vectors')[1].split('```')[0]);
const big = v => typeof v === 'string' && /^\d+$/.test(v) ? BigInt(v) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, big(x)])) : v;
const S = r => JSON.parse(JSON.stringify(r, (_, v) => typeof v === 'bigint' ? String(v) : v));

test('the shared vectors of docs/BETS-DPM.md', () => {
  for (const v of vectors) {
    const a = big(v.in);
    const got = v.op === 'isqrt' ? { r: isqrt(a.n) } : v.op === 'buy' ? buy(a.state, a.side, a.x, a.minShares ?? 0n)
      : v.op === 'sell' ? sell(a.state, a.side, a.shares, a.minOut ?? 0n) : v.op === 'redeem' ? redeem(a.state, a.side, a.n)
      : v.op === 'settle' ? settle(a.state, a.winner, a.signers)
      : v.op === 'refund' ? refund(a.state, a.p) : { ...prices(a.state), payoutUp: payoutPerShare(a.state, 'up'), payoutDown: payoutPerShare(a.state, 'down'), payoutUpNet: payoutPerShareNet(a.state, 'up'), payoutDownNet: payoutPerShareNet(a.state, 'down') };
    assert.deepEqual(S(got), v.out, v.name);
  }
  assert.ok(vectors.length >= 25);
});

test('isqrt is floor(sqrt) at the edges and in 10,000 random points', () => {
  let x = 7n;
  for (let i = 0; i < 10000; i++) {
    x = (x * 6364136223846793005n + 1442695040888963407n) % (1n << 64n);
    const r = isqrt(x); assert.ok(r * r <= x && (r + 1n) * (r + 1n) > x);
  }
});

test('solvency: after any sequence (the 1 + 1 opening included), the pool pays every Redeem, and Paid = pool for refunds', () => {
  let seed = 99;
  const rnd = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return BigInt(seed % n); };
  for (let run = 0; run < 300; run++) {
    let s = { qUp: 0n, qDown: 0n, pool: 0n, mUp: 0n, mDown: 0n }, paid = 0n;
    const held = { up: 0n, down: 0n };
    for (const side of ['up', 'down']) { const r = buy(s, side, 1000000n); s = r.state; held[side] += r.shares; paid += r.paid; }
    for (let i = 0; i < 40; i++) {
      const side = rnd(2) ? 'up' : 'down';
      if (rnd(3) || held[side] === 0n) { const r = buy(s, side, 1n + rnd(30000000)); if (r.error) continue; s = r.state; held[side] += r.shares; paid += r.paid; }
      else { const n = 1n + rnd(Number(held[side])); const r = sell(s, side, n); if (r.error) continue; s = r.state; held[side] -= n; paid -= r.out; }
      assert.ok(s.pool * s.pool >= s.qUp * s.qUp + s.qDown * s.qDown, 'the pool no longer covers the state');
      assert.equal(held.up, s.qUp); assert.equal(held.down, s.qDown);
      assert.equal(paid, s.pool, 'Paid receipts outstanding must equal the pool');
    }
    // Settle: the fee is at most 2% of the pool and the losing side's money, a winning share still pays at least 1, the
    // split adds up; then the winner redeems in random pieces and never gets more than the pool net of the fee
    const win = rnd(2) ? 'up' : 'down', qWin = win === 'up' ? s.qUp : s.qDown, mLose = win === 'up' ? s.mDown : s.mUp;
    const f = settle(s, win, 3n);
    if (qWin > 0n) {
      assert.ok(f.fee <= s.pool * 2n / 100n && f.fee <= mLose && s.pool - f.fee >= qWin);
      assert.equal(f.committeeEach * 3n + f.cgp + f.operator, f.fee);
    }
    let left = qWin, st = f.state, out = 0n;
    while (left > 0n) { const n = left < 3n ? left : 1n + rnd(Number(left)); const r = redeem(st, win, n); st = r.state; out += r.out; left -= n; }
    assert.ok(out <= f.state.pool && f.state.pool - out < 50n, `redeems ${out} of pool ${f.state.pool}`);
    if (qWin > 0n) assert.ok(out + 50n >= qWin, 'a winning share paid less than 1');
    // Void: refunds of all Paid pay exactly the pool
    assert.equal(refund(s, s.pool).state.pool, 0n);
  }
});
