// The market maker's plan for one cycle, with no I/O (site/test/maker.test.mjs tests it).
// Each side has `levels` price levels around the reference price:
//   ask level i: price x (1 + spread + i x step)      bid level i: price x (1 - spread - i x step)
// Every open order is matched to the nearest level of its side. It stays while it is within `requote` of that level;
// otherwise it is cancelled. So when the price moves by one step, the orders mostly shift by one level and only the
// level that fell off one end is cancelled and the new one made: not every level on every move.
// Extra identical copies of an order (units > 1) and a second order on the same level are cancelled too.

export const sideOf = o => (o.underAsset === '00' ? 'ask' : 'bid');

// USD (zUSDC) per ZP. ZP has 8 decimals, zUSDC 6.
export const impliedPrice = o => o.underAsset === '00'
  ? (Number(o.pairTotal) / 1e6) / (Number(o.underAmount) / 1e8)        // sells ZP for zUSDC
  : (Number(o.underAmount) / 1e6) / (Number(o.pairTotal) / 1e8);       // sells zUSDC for ZP

export const targets = (price, side, { levels, spread, step }) =>
  Array.from({ length: levels }, (_, i) => price * (side === 'ask' ? 1 + spread + i * step : 1 - spread - i * step));

// open: [{ id, underAsset, underAmount, pairAsset, pairTotal, units }]
// returns { cancels: [order], makes: [{ side, level, price }], kept: [{ order, side, level }] }, makes inner levels first
export function plan(price, open, opts) {
  const cancels = [], makes = [], kept = [];
  for (const side of ['ask', 'bid']) {
    const ts = targets(price, side, opts);
    const best = new Map();                       // level -> { order, dist }
    for (const o of open.filter(o => sideOf(o) === side)) {
      const p = impliedPrice(o);
      let level = 0;
      for (let i = 1; i < ts.length; i++) if (Math.abs(p / ts[i] - 1) < Math.abs(p / ts[level] - 1)) level = i;
      const dist = Math.abs(p / ts[level] - 1);
      if (o.units > 1 || dist > opts.requote || !(ts[level] > price * 1e-6)) { cancels.push(o); continue; }
      const b = best.get(level);
      if (!b) best.set(level, { order: o, dist });
      else if (dist < b.dist) { cancels.push(b.order); best.set(level, { order: o, dist }); }
      else cancels.push(o);
    }
    for (const [level, { order }] of best) kept.push({ order, side, level });
    ts.forEach((t, level) => { if (!best.has(level) && t > price * 1e-6) makes.push({ side, level, price: t }); });
  }
  return { cancels, makes, kept };
}
