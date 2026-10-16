// FixedPayout V1 markets (docs/BETS.md): the pure parts, shared by the market service (site/bets/bets.mjs) and the
// explorer API (site/explorer-api.mjs), tested in site/test/bets.test.mjs. No I/O here.
import { createHash } from 'node:crypto';

const sha3 = (...parts) => createHash('sha3-256').update(Buffer.concat(parts.map(p => typeof p === 'string' ? Buffer.from(p, 'hex') : p))).digest('hex');
const be32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const be64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
// a contract id or an asset id as the node writes it: version (8 hex) + contract hash (64) [+ subtype (64)]
const idParts = id => ({ version: parseInt(id.slice(0, 8), 16), hash: id.slice(8, 72), subtype: id.length > 72 ? id.slice(72, 136) : '0'.repeat(64) });

// the subtype of one of the contract's tokens for a market (contracts/v1/FixedPayout.fst marketHash): SHA3 of the oracle's
// compressed key, the Oracle contract id (U32 version, hash), the ticker's bytes, Price and the close (U64 big endian),
// the collateral asset (U32 version, hash, subtype) and a 4-character tag. Checked against the engine's try on dab00f8.
export function tokenSubtype(m, tag) {
  const o = idParts(m.oracleId), c = idParts(m.collateral);
  return sha3(m.oraclePubKey, be32(o.version), o.hash, Buffer.from(m.ticker, 'utf8'), be64(m.price), be64(m.close),
    be32(c.version), c.hash, c.subtype, Buffer.from(tag, 'utf8'));
}
export const TAGS = { bull: 'Bull', bear: 'Bear', bullWon: 'BuWn', bearWon: 'BeWn', void: 'Void' };
export const tokenId = (contractId, m, tag) => contractId + tokenSubtype(m, tag);
export const tokens = (contractId, m) => Object.fromEntries(Object.entries(TAGS).map(([k, t]) => [k, tokenId(contractId, m, t)]));

// the oracle's commit hash and the attestation token's subtype for a round (V1 Oracle, FixedPayout's attestToken)
export const commitHash = (root, ts) => sha3(root, be64(ts));
export const attestSubtype = (root, ts, oraclePubKey) => sha3(sha3(commitHash(root, ts), oraclePubKey));

// a market's line: the oracle's value rounded to 3 significant digits (82,396 -> 82,400; 1.1194 -> 1.12)
export function lineOf(value) {
  if (!(value > 0)) return null;
  const step = 10 ** (Math.floor(Math.log10(value)) - 2);
  return Number((Math.round(value / step) * step).toPrecision(3));
}
export const priceOf = line => Math.round(line * 1000);           // the contract's Price: the line x 1000

// the next closes: the given hour UTC on each of the next `days` days, at least `minAheadMs` after now; daily tickers
// (stocks, gold) only Monday to Friday
export function nextCloses(nowMs, hourUtc, days = 1, minAheadMs = 12 * 3600000) {
  const out = [];
  const d = new Date(nowMs); d.setUTCHours(hourUtc, 0, 0, 0);
  for (let t = d.getTime(); out.length < days; t += 86400000) if (t - nowMs >= minAheadMs) out.push(t);
  return out;
}
export const isWeekday = ms => { const w = new Date(ms).getUTCDay(); return w >= 1 && w <= 5; };

// a market's state from what the contract holds (its markers) and the time
export function stateOf(m, held, nowMs, graceMs = 86400000) {
  if (held.has(m.tokens.bullWon)) return { status: 'settled', result: 'bull' };
  if (held.has(m.tokens.bearWon)) return { status: 'settled', result: 'bear' };
  if (held.has(m.tokens.void)) return { status: 'void', result: null };
  if (nowMs < m.close) return { status: 'open', result: null };
  return { status: nowMs > m.close + graceMs ? 'voidable' : 'closing', result: null };
}

// the lines of a ticker for one close: the value moved by each offset (0, ±1 %, ±3 %), rounded to 3 digits, without repeats
export const linesOf = (value, offsets) => [...new Set(offsets.map(o => lineOf(value * (1 + o))).filter(Boolean))].sort((a, b) => a - b);

// ---- quoting (the market service's market making) ----
const YEAR = 365.25 * 86400000;
// the standard normal distribution function (Abramowitz and Stegun 26.2.17, error below 1e-7)
export function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x)), d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x > 0 ? 1 - p : p;
}
// the fair price of Up: the chance that the price is at or above the line at the close, N(d2) with no interest rate,
// from the latest price, the time left and an annual volatility
export function fairUp(spot, line, msLeft, vol) {
  if (!(spot > 0 && line > 0)) return null;
  if (msLeft <= 0 || !(vol > 0)) return spot >= line ? 1 : 0;
  const s = vol * Math.sqrt(msLeft / YEAR);
  return normCdf((Math.log(spot / line) - s * s / 2) / s);
}
// the four quotes of a market around the fair price of Up: Up bid and ask around p, Down's around 1 - p; a spread wide,
// on a tick of 0.01, asks at most 0.99, no bid below 0.01
export function quotesFor(pUp, { spread = 0.06, tick = 0.01, min = 0.01, max = 0.99 } = {}) {
  const fix = x => Number(x.toFixed(6));
  const two = p => {
    const ask = Math.min(max, fix(Math.ceil((p + spread / 2) / tick - 1e-9) * tick));
    const bid = fix(Math.floor((p - spread / 2) / tick + 1e-9) * tick);
    return { bid: bid >= min && bid < ask ? bid : null, ask };
  };
  return { up: two(pUp), down: two(1 - pUp) };
}
// the spread of a market's quotes: the base, times the last minutes' move in standard deviations when it is above one
// (at most 3x), times 1.5 in the last 2 hours and 2 in the last hour before the close, times 1.5 with a single live
// source; at most 0.3
export function spreadFor(base, { vol, move = null, minutes = 5, msLeft = Infinity, sources = 3 }) {
  let k = 1;
  if (move != null && vol > 0 && minutes > 0) { const z = Math.abs(move) / (vol * Math.sqrt(minutes * 60000 / YEAR)); if (z > 1) k *= Math.min(3, z); }
  if (msLeft < 3600000) k *= 2; else if (msLeft < 7200000) k *= 1.5;
  if (sources < 2) k *= 1.5;
  return Math.min(0.3, base * k);
}
export const medianOf = xs => { const v = xs.filter(x => x > 0).sort((a, b) => a - b); return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null; };
// the price of one of our Dex orders on a position token: an ask sells the token for the collateral, a bid buys it
export const orderPrice = (o, side) => side === 'ask' ? Number(o.pair_total) / Number(o.under_amount) : Number(o.under_amount) / Number(o.pair_total);
// what to cancel and what to make for one market. want: quotesFor(...) or null (stop quoting); mine: our open orders on
// its tokens (the explorer's /dex/orders?pending=1 rows). An order within `move` of its target stays; one in the mempool
// or with a Take or Cancel on its way is left alone this time (its slot waits). An order with less than minSize tokens
// left (taken in part, or an old small one) is made again in full.
export const orderSize = (o, side) => Number(side === 'ask' ? o.under_amount : o.pair_total);
export function planQuotes(want, mine, { bull, bear, collateral, move = 0.03, minSize = 0 }) {
  const cancels = [], makes = [];
  for (const [name, side, token] of [['up', 'ask', bull], ['up', 'bid', bull], ['down', 'ask', bear], ['down', 'bid', bear]]) {
    const target = want ? want[name][side] : null;
    const here = mine.filter(o => side === 'ask' ? o.under_asset === token && o.pair_asset === collateral : o.pair_asset === token && o.under_asset === collateral);
    let keep = false, busy = false;
    for (const o of here) {
      if (o.pendingCancel || o.pendingTake) { busy = true; continue; }
      if (!keep && target != null && Math.abs(orderPrice(o, side) - target) < move - 1e-9 && orderSize(o, side) >= minSize) { keep = true; continue; }
      if (o.pending) { busy = true; continue; }
      cancels.push({ ...o, name, side });
    }
    if (target != null && !keep && !busy) makes.push({ name, side, token, price: target });
  }
  return { cancels, makes };
}

// the winner by the close round's value (x 1000): Bull if Price <= Value
export const winnerOf = (price, valueScaled) => (BigInt(price) <= BigInt(valueScaled) ? 'Bull' : 'Bear');

// Zen data, serialized as the node does (dictionary keys by length, then bytes)
function varint(n) { const t = []; let len = 0; for (;;) { t[len] = (n & 0x7f) | (len ? 0x80 : 0); if (n <= 0x7f) break; n = Math.floor(n / 128) - 1; len++; } return Buffer.from(t.reverse()); }
const str = s => Buffer.concat([varint(Buffer.byteLength(s)), Buffer.from(s, 'utf8')]);
export const D = {
  u64: n => Buffer.concat([Buffer.of(5), be64(n)]),
  string: s => Buffer.concat([Buffer.of(6), str(s)]),
  hash: h => Buffer.concat([Buffer.of(7), Buffer.from(h, 'hex')]),
  publicKey: k => Buffer.concat([Buffer.of(10), Buffer.from(k, 'hex')]),
  list: items => Buffer.concat([Buffer.of(13), varint(items.length), ...items]),
  contractLock: id => { const p = idParts(id); const payload = Buffer.concat([varint(p.version), Buffer.from(p.hash, 'hex')]); return Buffer.concat([Buffer.of(8), varint(4), varint(payload.length), payload]); },
};
export const dict = o => { const ks = Object.keys(o).sort((a, b) => Buffer.byteLength(a) - Buffer.byteLength(b) || Buffer.compare(Buffer.from(a), Buffer.from(b))); return Buffer.concat([Buffer.of(12), varint(ks.length), ...ks.flatMap(k => [str(k), o[k]])]).toString('hex'); };

// the seven market fields of every FixedPayout body
export const marketFields = m => ({ OraclePubKey: D.publicKey(m.oraclePubKey), OracleContractId: D.string(m.oracleId), Ticker: D.string(m.ticker),
  Price: D.u64(m.price), Start: D.u64(m.close), Expiry: D.u64(m.close), Collateral: D.string(m.collateral) });
export const bodies = {
  issue: m => dict(marketFields(m)),
  settle: (m, position, p) => dict({ ...marketFields(m), Position: D.string(position), Root: D.hash(p.root), Timestamp: D.u64(p.timestamp),
    Value: D.u64(p.valueScaled), Index: D.u64(p.index), AuditPath: D.list(p.auditPath.map(D.hash)) }),
  void: m => dict(marketFields(m)),
  redeem: (m, position) => dict({ ...marketFields(m), Position: D.string(position) }),
  // the V1 Oracle's Attest, the token to the FixedPayout contract
  attest: (root, ts, oraclePubKey, recipientId) => dict({ Commit: D.hash(commitHash(root, ts)), OraclePubKey: D.publicKey(oraclePubKey), Recipient: D.contractLock(recipientId) }),
  // a Dex Make: sell `amount` of a token for `total` of another
  make: (under, amount, pair, total, makerKey) => dict({ UnderlyingAsset: D.string(under), UnderlyingAmount: D.u64(amount), PairAsset: D.string(pair), OrderTotal: D.u64(total), MakerPubKey: D.publicKey(makerKey) }),
};
