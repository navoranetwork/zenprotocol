// The FPMM math of the UpDown contract (docs/BETS-FPMM.md), in integers, exactly as the contract will do it: the
// reference for the bets service, the explorer's /bets/quote and the wallet (which computes quotes locally), and the
// source of the shared test vectors. Amounts are BigInt base units. Every division rounds against the trader.
export const CAP = 4_000_000_000n;                   // testnet: at most this much a side, so k = rUp x rDown fits a U64
const ceilDiv = (a, b) => (a + b - 1n) / b;
const min = (a, b) => (a < b ? a : b);

// the fee in basis points from the reserve: 400 x min(rUp, rDown) / (rUp + rDown), 2% at 50%, less towards 0 or 1
export const feeBps = (rUp, rDown) => 400n * min(rUp, rDown) / (rUp + rDown);
export const priceUp = (rUp, rDown) => Number(rDown) / Number(rUp + rDown);

// Seed N at a price of Up (oddsBps, 1..9999): N pairs minted; the reserve keeps all of the cheaper side and the share
// of the other that gives the price; the rest of that side goes back to the seeder
export function seed(n, oddsBps = 5000n) {
  if (n <= 0n || oddsBps <= 0n || oddsBps >= 10000n) return { error: 'Seed needs N > 0 and a price between 1 and 9999 bps' };
  let rUp = n, rDown = n;
  if (oddsBps < 5000n) rDown = n * oddsBps / (10000n - oddsBps);        // Up cheap: more Up in the reserve
  else if (oddsBps > 5000n) rUp = n * (10000n - oddsBps) / oddsBps;
  if (rUp <= 0n || rDown <= 0n || rUp > CAP || rDown > CAP) return { error: 'Seed out of range' };
  return { rUp, rDown, backUp: n - rUp, backDown: n - rDown, shares: n };
}

// Buy `side` ('up' | 'down') with x collateral: { out, fee, rUp, rDown } or { error }
export function buy(rUp, rDown, side, x, minOut = 0n) {
  if (x <= 0n) return { error: 'Buy needs a positive amount' };
  const [a, b] = side === 'up' ? [rUp, rDown] : [rDown, rUp];          // a: the side bought
  const fee = ceilDiv(x * feeBps(rUp, rDown), 10000n), n = x - fee, k = a * b;
  const out = a + n - ceilDiv(k, b + n);
  const a2 = a + x - out, b2 = b + x;
  if (out <= 0n) return { error: 'Buy too small: nothing out' };
  if (out < minOut) return { error: `out ${out} is below MinOut ${minOut}` };
  if (a2 > CAP || b2 > CAP) return { error: 'the reserve would pass the testnet cap' };
  return side === 'up' ? { out, fee, rUp: a2, rDown: b2 } : { out, fee, rUp: b2, rDown: a2 };
}

// Sell `side` for c collateral, giving at most maxIn tokens: { in, fee, rUp, rDown } or { error }
export function sell(rUp, rDown, side, c, maxIn) {
  if (c <= 0n) return { error: 'Sell needs a positive Amount' };
  const [a, b] = side === 'up' ? [rUp, rDown] : [rDown, rUp];          // a: the side sold
  const f = feeBps(rUp, rDown), g = ceilDiv(c * 10000n, 10000n - f);
  if (g >= b) return { error: 'Sell too large for the reserve' };
  const tokens = ceilDiv(a * b, b - g) - a + g;
  if (maxIn != null && tokens > maxIn) return { error: `needs ${tokens} tokens, more than MaxIn ${maxIn}` };
  const a2 = a + tokens - c, b2 = b - c;
  if (a2 > CAP) return { error: 'the reserve would pass the testnet cap' };
  return side === 'up' ? { in: tokens, fee: g - c, rUp: a2, rDown: b2 } : { in: tokens, fee: g - c, rUp: b2, rDown: a2 };
}

// the most collateral a sale of `tokens` gives (what the wallet and /bets/quote put in Amount): the largest c whose
// sell needs at most `tokens`, found by bisection
export function sellFor(rUp, rDown, side, tokens) {
  let lo = 0n, hi = side === 'up' ? rDown : rUp;
  while (lo < hi) { const mid = (lo + hi + 1n) / 2n; const r = sell(rUp, rDown, side, mid, tokens); if (r.error) hi = mid - 1n; else lo = mid; }
  return lo === 0n ? { error: 'Sell too small: nothing out' } : { amount: lo, ...sell(rUp, rDown, side, lo, tokens) };
}

// Withdraw S shares of a Seed of N: after Settle the winning side's reserve, after Void half of both, pro rata
export const withdraw = (s, n, rUp, rDown, result) => result === 'void' ? s * (rUp + rDown) / 2n / n : s * (result === 'up' ? rUp : rDown) / n;
