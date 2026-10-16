// The snapshot and issue plan of the wallet move (docs/WALLET-MIGRATION.md):  node --test site/test/wallet-move.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan } from '../wallet-move-core.mjs';

const OLD = 'old', BULL = 'bull', BEAR = 'bear', VB = 'vbull', VBR = 'vbear', DEX = 'ctzn1dex', FP = 'ctzn1fixedpayout';
const base = () => ({
  oldAsset: OLD, dex: DEX, bridgeOld: 'tzn1bridgeold', bridgeNew: 'tzn1bridgenew', betsNew: 'tzn1betsnew',
  markets: [{ bull: BULL, bear: BEAR, status: 'settled', result: 'bull' }, { bull: VB, bear: VBR, status: 'void', result: null }],
  ownOld: new Map([['tzn1mmold', 'tzn1mmnew'], ['tzn1betsold', 'tzn1betsnew'], ['tzn1bridgeold', 'tzn1betsnew']]),
  oldWallet: new Set(['tzn1mmold', 'tzn1betsold', 'tzn1bridgeold']),
  known: new Set(['tzn1mmold', 'tzn1betsold', 'tzn1bridgeold']),
  surplus: '60000000', bridgeCoins: [],
});
// supply 100: alice 20 held, bob 10 in a Dex bid, FixedPayout 70 = collateral of 40 pairs (settled) + 30 pairs (void)
const world = () => ({
  ...base(), supply: '100',
  balances: [
    { address: 'tzn1alice', asset: OLD, amount: 20 }, { address: DEX, asset: OLD, amount: 10 }, { address: FP, asset: OLD, amount: 70 },
    { address: 'tzn1alice', asset: BULL, amount: 15 }, { address: 'tzn1carol', asset: BEAR, amount: 40 },   // carol lost
    { address: DEX, asset: BULL, amount: 5 }, { address: 'tzn1betsold', asset: BULL, amount: 20 },
    { address: 'tzn1alice', asset: VB, amount: 3 }, { address: 'tzn1carol', asset: VBR, amount: 30 }, { address: 'tzn1mmold', asset: VB, amount: 27 },
  ],
  orders: [{ maker: 'tzn1bob', under_asset: OLD, under_amount: 10 }, { maker: 'tzn1dave', under_asset: BULL, under_amount: 5 }],
});

test('credits: held, in Dex orders, position tokens at payout, our old keys mapped; the sum is the supply', () => {
  const r = buildPlan(world());
  assert.deepEqual(r.problems, []);
  const by = Object.fromEntries(r.plan.map(p => [p.address, p.amount]));
  assert.equal(by['tzn1alice'], String(20 + 15 + 1));        // 20 zUSDC, 15 winning Up, 3 void halves -> 1
  assert.equal(by['tzn1bob'], '10');                          // zUSDC in his bid
  assert.equal(by['tzn1dave'], '5');                          // winning Up in his sell order
  assert.equal(by['tzn1carol'], '15');                        // lost Down 0, void 30 -> 15
  assert.equal(by['tzn1mmnew'], '13');                        // old market maker: void 27 -> 13
  assert.equal(by['tzn1betsnew'], String(20 + 1 + 60000000)); // old bets: 20 winning Up; the dust (1 from 3 and 27 halves) and the surplus
  assert.equal(r.totals.dust, '1');
  assert.ok(!('tzn1mmold' in by) && !('tzn1betsold' in by));
});

test('a coin at the old bridge address goes to its one PK sender; otherwise it is manual and the sum still holds', () => {
  const w = world();
  w.supply = '130';
  w.balances.push({ address: 'tzn1bridgeold', asset: OLD, amount: 30 });
  w.bridgeCoins = [{ amount: 20, inputs: ['tzn1erin'] }, { amount: 10, inputs: ['tzn1x', 'ctzn1somecontract'] }];
  const r = buildPlan(w);
  assert.deepEqual(r.problems, []);
  assert.equal(r.plan.find(p => p.address === 'tzn1erin').amount, '20');
  assert.equal(r.manual.length, 1); assert.equal(r.totals.manual, '10');
});

test('refused: an open market, a holder missing, a Dex mismatch, a public-phrase address', () => {
  const open = world(); open.markets[0].status = 'open';
  assert.ok(buildPlan(open).problems.some(p => p.includes('settled or void')));
  const missing = world(); missing.balances = missing.balances.filter(b => b.address !== 'tzn1alice' || b.asset !== OLD);
  assert.ok(buildPlan(missing).problems.some(p => p.includes('a holder is missing')));
  const dex = world(); dex.orders = dex.orders.slice(1);
  assert.ok(buildPlan(dex).problems.some(p => p.includes('the Dex holds')));
  const pub = world(); pub.known.add('tzn1alice');
  const r = buildPlan(pub); assert.equal(r.ok, false); assert.ok(r.problems.some(p => p.includes('public phrase')));
});
