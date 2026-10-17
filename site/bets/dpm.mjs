// The dynamic pari-mutuel market (share-ratio DPM, docs/BETS-DPM.md) in integers, exactly as the contract will compute
// it: the reference for the bets service, /bets/quote and the wallet, and the source of the shared vectors.
// State of a market: qUp, qDown (shares sold), pool (collateral held for it). Amounts are BigInt base units.
// Invariant: pool² >= qUp² + qDown² (the pool covers the cost of the state). Every rounding goes against the trader.
export const CAP = 4_000_000_000n;                   // testnet: pool at most this, so every square fits a U64

// floor(sqrt(n)) for 0 <= n < 2^64, bit by bit: 32 fixed steps (the contract's form: the same cost for every n)
export function isqrt(n) {
  if (n < 0n || n >= 1n << 64n) throw new Error('isqrt: out of range');
  let r = 0n;
  for (let bit = 31n; bit >= 0n; bit--) { const t = r | (1n << bit); if (t * t <= n) r = t; }
  return r;
}
export const isqrtCeil = n => { const r = isqrt(n); return r * r === n ? r : r + 1n; };

const pick = (s, side) => side === 'up' ? [s.qUp, s.qDown] : [s.qDown, s.qUp];
const put = (side, a, b, pool) => side === 'up' ? { qUp: a, qDown: b, pool } : { qUp: b, qDown: a, pool };

// Buy `side` with x collateral: { shares, paid: x, state } or { error }. The buyer also gets x "Paid" receipts.
export function buy(s, side, x, minShares = 0n) {
  if (x <= 0n) return { error: 'Buy needs a positive amount' };
  const [a, b] = pick(s, side), t = s.pool + x;
  if (t > CAP) return { error: 'the pool would pass the testnet cap' };
  const shares = isqrt(t * t - b * b) - a;
  if (shares <= 0n) return { error: 'Buy too small: no shares' };
  if (shares < minShares) return { error: `shares ${shares} below MinShares ${minShares}` };
  return { shares, paid: x, state: put(side, a + shares, b, t) };
}

// Sell `shares` of `side`: { out, state } or { error }. The seller also gives up `out` Paid receipts.
export function sell(s, side, shares, minOut = 0n) {
  const [a, b] = pick(s, side);
  if (shares <= 0n || shares > a) return { error: 'Sell needs between 1 and the shares sold on that side' };
  const pool = isqrtCeil((a - shares) * (a - shares) + b * b), out = s.pool - pool;
  if (out <= 0n) return { error: 'Sell too small: nothing out' };
  if (out < minOut) return { error: `out ${out} below MinOut ${minOut}` };
  return { out, state: put(side, a - shares, b, pool) };
}

// prices: the marginal cost of a share (not a probability; 0.707 each at 50/50) and the implied probability
// q_side² / (qUp² + qDown²), which sums to 1
export function prices(s) {
  const t = Number(s.qUp) ** 2 + Number(s.qDown) ** 2;
  if (t === 0) return { up: 1, down: 1, probUp: 0.5, probDown: 0.5 };
  return { up: Number(s.qUp) / Math.sqrt(t), down: Number(s.qDown) / Math.sqrt(t), probUp: Number(s.qUp) ** 2 / t, probDown: Number(s.qDown) ** 2 / t };
}
// the payout per winning share if the market closed now (null when that side has no shares)
export const payoutPerShare = (s, side) => { const [a] = pick(s, side); return a > 0n ? Number(s.pool) / Number(a) : null; };

// after Settle (winner has shares): Redeem n winning shares -> floor(n x pool / qWin); the state shrinks with it
export function redeem(s, side, n) {
  const [a, b] = pick(s, side);
  if (n <= 0n || n > a) return { error: 'Redeem needs between 1 and the winning shares outstanding' };
  const out = n * s.pool / a;
  return { out, state: put(side, a - n, b, s.pool - out) };
}
// after Void, or Settle with no winning shares: Refund p Paid -> p collateral
export function refund(s, p) {
  if (p <= 0n || p > s.pool) return { error: 'Refund needs between 1 and the pool' };
  return { out: p, state: { ...s, pool: s.pool - p } };
}
