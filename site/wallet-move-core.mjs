// Moving the testnet off the public wallet phrase (docs/WALLET-MIGRATION.md): the pure part of the snapshot and the
// issue plan, tested in site/test/wallet-move.test.mjs. scripts/v1/wallet-move.mjs gathers the inputs and issues.
//
// Inputs (amounts in base units, as strings or numbers):
//   oldAsset        the old zUSDC asset id
//   supply          the old zUSDC outstanding (the bridge's zusdcOutstanding)
//   balances        [{ address, asset, amount }] live balances of every holder of the old zUSDC and the position tokens
//                   (contract addresses included: they are skipped, but their totals are checked)
//   orders          open Dex orders [{ maker (address), under_asset, under_amount }]
//   markets         [{ bull, bear, status: 'settled' | 'void', result: 'bull' | 'bear' | null }]
//   bridgeOld       the old bridge's ZP address (0/0 of the old wallet)
//   bridgeCoins     [{ amount, inputs: [address|null|'mint', …] }] old zUSDC still at bridgeOld, with the input addresses
//                   of the transaction that brought each coin
//   ownOld          Map old address -> new address, for our own old wallet's keys (2/0 -> new 2/0, others -> new 2/1)
//   oldWallet       Set of the old wallet's addresses (to tell our own coins at bridgeOld)
//   known           Set of addresses derived from public phrases (assert: none in the plan)
//   surplus         reserve surplus to issue to `betsNew`
//   betsNew         the bets service's new address (gets the surplus and the void dust)
export const isContract = a => /^c(tzn|zen)1/.test(a || '');

export function buildPlan(x) {
  const big = v => BigInt(v ?? 0);
  const problems = [], credits = new Map(), parts = new Map(), manual = [];
  const credit = (address, amount, why) => {
    if (amount <= 0n) return;
    const to = x.ownOld.get(address) ?? address;
    credits.set(to, (credits.get(to) ?? 0n) + amount);
    const p = parts.get(to) ?? {}; p[why] = String(big(p[why]) + amount); parts.set(to, p);
  };
  // the value of a position token, per market, in old zUSDC units: winner 1, loser 0, void 1/2 (rounded down per owner)
  const token = new Map();
  for (const m of x.markets) {
    if (m.status !== 'settled' && m.status !== 'void') problems.push(`market ${m.bull.slice(-8)} is ${m.status}: every market must be settled or void`);
    const v = m.status === 'void' ? [1n, 2n] : null;
    token.set(m.bull, v ?? (m.result === 'bull' ? [1n, 1n] : [0n, 1n]));
    token.set(m.bear, v ?? (m.result === 'bear' ? [1n, 1n] : [0n, 1n]));
  }
  const worth = (asset, n) => { const [a, b] = token.get(asset); return n * a / b; };
  // 1. balances at PK addresses (contract addresses are owed through the orders and the tokens)
  const atContracts = {};
  for (const b of x.balances) {
    const n = big(b.amount);
    if (isContract(b.address)) { atContracts[b.asset] = (atContracts[b.asset] ?? 0n) + n; continue; }
    if (b.address === x.bridgeOld && b.asset === x.oldAsset) continue;          // at the bridge: by sender, below
    if (b.asset === x.oldAsset) credit(b.address, n, 'zUSDC held');
    else if (token.has(b.asset)) credit(b.address, worth(b.asset, n), 'position tokens');
  }
  // 2. open Dex orders, to their makers
  for (const o of x.orders) {
    const n = big(o.under_amount);
    if (o.under_asset === x.oldAsset) credit(o.maker, n, 'zUSDC in Dex orders');
    else if (token.has(o.under_asset)) credit(o.maker, worth(o.under_asset, n), 'position tokens in Dex orders');
  }
  // 3. old zUSDC still at the old bridge address: to its sender, when there is exactly one PK sender
  for (const c of x.bridgeCoins) {
    const ins = [...new Set(c.inputs)];
    const pks = ins.filter(a => a && a !== 'mint' && !isContract(a));
    if (ins.length && pks.length === ins.length && pks.length === 1) credit(pks[0], big(c.amount), 'sent to the bridge');
    else if (ins.length && ins.every(a => x.oldWallet.has(a))) credit(ins[0], big(c.amount), 'our own coin at the bridge');
    else manual.push({ ...c, amount: String(c.amount), why: 'inputs from a contract, several PKs or unknown: decide by hand' });
  }
  // checks: the Dex holds what its orders say, and the sum is the supply
  const dexSum = {}; for (const o of x.orders) dexSum[o.under_asset] = (dexSum[o.under_asset] ?? 0n) + big(o.under_amount);
  const ofDex = {}; for (const b of x.balances) if (b.address === x.dex) ofDex[b.asset] = (ofDex[b.asset] ?? 0n) + big(b.amount);
  for (const a of new Set([...Object.keys(dexSum), ...Object.keys(ofDex)].filter(a => a === x.oldAsset || token.has(a))))
    if ((dexSum[a] ?? 0n) !== (ofDex[a] ?? 0n)) problems.push(`the Dex holds ${ofDex[a] ?? 0n} of ${a.slice(-8)} but its open orders say ${dexSum[a] ?? 0n}: wait for the index, or an order is missing`);
  const credited = [...credits.values()].reduce((s, v) => s + v, 0n), inManual = manual.reduce((s, c) => s + big(c.amount), 0n);
  const supply = big(x.supply), dust = supply - credited - inManual;
  const voidOwners = x.balances.filter(b => !isContract(b.address) && token.get(b.asset)?.[1] === 2n).length + x.orders.filter(o => token.get(o.under_asset)?.[1] === 2n).length;
  if (dust < 0n || dust > BigInt(voidOwners)) problems.push(`credits ${credited} + manual ${inManual} + dust ${dust} != supply ${supply} (dust must be 0..${voidOwners}, from void halves)`);
  // the old zUSDC everywhere (contracts included) must be the supply: a holder missing from the index shows here
  const allOld = x.balances.filter(b => b.asset === x.oldAsset).reduce((s, b) => s + big(b.amount), 0n);
  if (allOld !== supply) problems.push(`old zUSDC found at all addresses ${allOld} != supply ${supply}: a holder is missing (index behind?)`);
  // the surplus and the dust go to the bets service's new key
  if (dust > 0n) credit(x.betsNew, dust, 'void rounding dust');
  if (big(x.surplus) > 0n) credit(x.betsNew, big(x.surplus), 'reserve surplus');
  const plan = [...credits].map(([address, amount]) => ({ address, amount: String(amount), parts: parts.get(address) }))
    .sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1));
  for (const p of plan) {
    if (x.known.has(p.address)) problems.push(`${p.address} is derived from a public phrase: never issue to it`);
    if (isContract(p.address)) problems.push(`${p.address} is a contract`);
    if (p.address === x.bridgeNew) problems.push(`${p.address} is the new bridge address: zUSDC there would be paid out`);
  }
  return { ok: problems.length === 0, problems, plan, manual, totals: { supply: String(supply), credited: String(credited), manual: String(inManual), dust: String(dust), surplus: String(big(x.surplus)), atContracts: Object.fromEntries(Object.entries(atContracts).map(([k, v]) => [k, String(v)])) } };
}
