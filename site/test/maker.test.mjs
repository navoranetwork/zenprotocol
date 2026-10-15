// The market maker's levels (site/marketmaker/levels.mjs):  node --test site/test/maker.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plan, impliedPrice, targets } from '../marketmaker/levels.mjs';

const USDC = 'ab'.repeat(32), SIZE = 100;
const opts = { levels: 3, spread: 0.01, step: 0.005, requote: 0.002 };
let n = 0;
const ask = price => ({ id: 'a' + n++, underAsset: '00', underAmount: SIZE * 1e8, pairAsset: USDC, pairTotal: Math.round(SIZE * price * 1e6), units: 1 });
const bid = price => ({ id: 'b' + n++, underAsset: USDC, underAmount: Math.round(SIZE * price * 1e6), pairAsset: '00', pairTotal: SIZE * 1e8, units: 1 });
const book = price => [...targets(price, 'ask', opts).map(ask), ...targets(price, 'bid', opts).map(bid)];
const levels = ms => ms.map(m => m.side + m.level).sort();

test('levels: 1% from the price, then 0.5% apart, on both sides', () => {
  assert.deepEqual(targets(0.1, 'ask', opts).map(x => +x.toFixed(6)), [0.101, 0.1015, 0.102]);
  assert.deepEqual(targets(0.1, 'bid', opts).map(x => +x.toFixed(6)), [0.099, 0.0985, 0.098]);
  assert.equal(impliedPrice(ask(0.101)).toFixed(6), '0.101000');
  assert.equal(impliedPrice(bid(0.099)).toFixed(6), '0.099000');
});

test('an empty book: makes every level, inner levels first', () => {
  const p = plan(0.1, [], opts);
  assert.deepEqual(p.cancels, []);
  assert.deepEqual(p.makes.map(m => m.side + m.level), ['ask0', 'ask1', 'ask2', 'bid0', 'bid1', 'bid2']);
});

test('a full book at the price: nothing to do', () => {
  const p = plan(0.1, book(0.1), opts);
  assert.deepEqual(p.cancels, []); assert.deepEqual(p.makes, []); assert.equal(p.kept.length, 6);
});

test('a taken level is made again, and only that one', () => {
  const b = book(0.1).filter((_, i) => i !== 4);         // bid level 1 was taken
  const p = plan(0.1, b, opts);
  assert.deepEqual(p.cancels, []); assert.deepEqual(levels(p.makes), ['bid1']);
});

test('the price moves up by one step: one ask and one bid change, not all six', () => {
  const b = book(0.1), up = 0.1 * 1.005;
  const p = plan(up, b, opts);
  // the ask at 1.01 is now below the new inner ask (1.01 x 1.005): cancelled; the old asks 2 and 3 become levels 0 and 1
  // (within 0.2%: 1.015/(1.005 x 1.01) - 1 = 0.0001); a new outer ask; the bids shift outward and the outer one falls off
  assert.equal(p.cancels.length, 2);
  assert.deepEqual(p.cancels.map(o => impliedPrice(o).toFixed(4)).sort(), ['0.0980', '0.1010']);
  assert.deepEqual(levels(p.makes), ['ask2', 'bid0']);
});

test('a large move: every order is off its level, so all are cancelled and all levels made', () => {
  const p = plan(0.12, book(0.1), opts);
  assert.equal(p.cancels.length, 6); assert.equal(p.makes.length, 6);
});

test('extra copies and two orders on one level are cancelled', () => {
  const two = { ...ask(0.101), units: 2 }, near = ask(0.10101), far = ask(0.10115);
  const p = plan(0.1, [two, near, far], opts);
  assert.ok(p.cancels.includes(two));                      // more than one copy
  assert.ok(p.cancels.includes(far)); assert.ok(!p.cancels.includes(near));   // same level: the closer one stays
  assert.deepEqual(levels(p.makes.filter(m => m.side === 'ask')), ['ask1', 'ask2']);
});

test('one level per side works as the old single-order maker', () => {
  const p = plan(0.1, [], { ...opts, levels: 1 });
  assert.deepEqual(levels(p.makes), ['ask0', 'bid0']);
});

test('a bid level at or below price 0 is never made', () => {
  const p = plan(0.1, [], { levels: 3, spread: 0.99, step: 0.01, requote: 0.002 });
  assert.deepEqual(levels(p.makes), ['ask0', 'ask1', 'ask2', 'bid0']);
});
