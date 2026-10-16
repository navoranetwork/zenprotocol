// Up / Down bets on the oracle's prices (the FixedPayout contract, ported to ZP contracts V1 by the oracle/Dex session).
//
// A market is one event: will TICKER be at or above STRIKE at CLOSE? The contract mints a pair for each unit of
// collateral (zUSDC): one Bull ("Up") token and one Bear ("Down") token. After the close, each token of the winning side
// redeems for one unit of collateral. There is no matching in the contract: a bet is a Dex Take of an order that
// sells Up or Down tokens for zUSDC. The market service sends Settle (with the oracle's proof) once per market; with
// no Settle within 24 hours of the close anyone may send Void, and then every token, Up or Down, pays half a unit.
// Redeem is the market's fields and the Position, signed by the holder (docs/BETS.md). The site lists the markets
// (GET /explorer/api/bets/markets). The bodies are checked byte for byte against the oracle/Dex session's testnet
// vectors once the contract is active.
import { unhex, hex, assetToId } from './serialize.js';
import { payoutFor } from './dex.js';

const HEX = n => new RegExp(`^[0-9a-f]{${n}}$`);
const ASSET = /^(00|[0-9a-f]{72}([0-9a-f]{64})?)$/;
const U64_MAX = (1n << 64n) - 1n;
const u64 = (v, what) => { const n = BigInt(String(v)); if (n < 0n || n > U64_MAX) throw new Error(`market: bad ${what}`); return n; };

// The event fields as the contract hashes and checks them (Issue and Redeem bodies). V1: Start = Expiry = the close.
export function eventOf(e) {
  const ev = {
    oraclePubKey: String(e?.OraclePubKey || '').toLowerCase(), oracleContractId: String(e?.OracleContractId || '').toLowerCase(),
    ticker: String(e?.Ticker || ''), price: u64(e?.Price ?? -1, 'price'), start: u64(e?.Start ?? -1, 'start'), expiry: u64(e?.Expiry ?? -1, 'expiry'),
    collateral: String(e?.Collateral || '').toLowerCase(),
  };
  if (!HEX(66).test(ev.oraclePubKey)) throw new Error('market: bad oracle key');
  if (!HEX(72).test(ev.oracleContractId)) throw new Error('market: bad oracle contract');
  if (!/^[A-Z0-9]{1,4}$/.test(ev.ticker)) throw new Error('market: bad ticker');
  if (!ASSET.test(ev.collateral)) throw new Error('market: bad collateral');
  if (ev.start !== ev.expiry) throw new Error('market: Start and Expiry must both be the close');
  return ev;
}
export const eventFields = ev => [
  ['OraclePubKey', { t: 'PublicKey', v: unhex(ev.oraclePubKey) }], ['OracleContractId', { t: 'String', v: ev.oracleContractId }],
  ['Ticker', { t: 'String', v: ev.ticker }], ['Price', { t: 'U64', v: ev.price }], ['Start', { t: 'U64', v: ev.start }],
  ['Expiry', { t: 'U64', v: ev.expiry }], ['Collateral', { t: 'String', v: ev.collateral }]];

// one row of GET /explorer/api/bets/markets, checked; rows that do not parse are left out by the caller
// Status (the explorer's GET /bets/markets): open; closing (after the close, waiting for Settle); settled; voidable
// (no Settle within 24 h, waiting for the Void); void. `ctx` is the answer's top level: contractId and collateral.
const STATUS = ['open', 'closing', 'settled', 'voidable', 'void'];
export function marketOf(row, ctx = {}) {
  const ev = eventOf(row?.event), cid = String(row?.contractId || ctx.contractId || row?.contract || ctx.contract || '').toLowerCase();
  const m = { ticker: ev.ticker, strike: Number(ev.price) / 1000, close: Number(ev.start), collateral: ev.collateral, event: ev,
    bull: String(row?.bull || '').toLowerCase(), bear: String(row?.bear || '').toLowerCase(),
    status: STATUS.includes(row?.status) ? row.status : row?.status === 'closed' ? 'closing' : 'open',
    result: row?.result === 'bull' || row?.result === 'bear' ? row.result : null,
    settlePrice: row?.settlePrice == null ? null : Number(row.settlePrice), contract: HEX(72).test(cid) ? cid : null,
    book: { up: sideBook(row?.book?.up), down: sideBook(row?.book?.down) } };
  if (!ASSET.test(m.bull) || !ASSET.test(m.bear) || m.bull === m.bear) throw new Error('market: bad position tokens');
  if (ctx.collateral && String(ctx.collateral).toLowerCase() !== m.collateral) throw new Error('market: other collateral');
  return m;
}
const price01 = v => v == null || !Number.isFinite(Number(v)) || Number(v) < 0 || Number(v) > 1 ? null : Number(v);
const sideBook = b => ({ ask: price01(b?.ask), bid: price01(b?.bid) });
// the markets answer, checked: rows that do not parse are left out
export const marketsOf = j => { const rows = Array.isArray(j) ? j : Array.isArray(j?.markets) ? j.markets : null; return rows && rows.map(r => { try { return marketOf(r, Array.isArray(j) ? {} : j); } catch { return null; } }).filter(Boolean); };
export const sideAsset = (m, side) => side === 'up' ? m.bull : m.bear;

// The cheapest open Dex order that sells this side's token for the market's collateral (a bet takes it).
// Price per token in collateral units: pairTotal / underAmount (a token pays 1 unit if right).
export function bestOffer(orders, asset, collateral) {
  let best = null;
  for (const o of orders) {
    if (o.pending || o.busy || o.underAsset !== asset || o.pairAsset !== collateral) continue;
    if (!best || o.pairTotal * best.underAmount < best.pairTotal * o.underAmount) best = o;
  }
  return best;
}
export const offerPrice = o => o ? Number(o.pairTotal) / Number(o.underAmount) : null;

// A bet of `stake` collateral units against one order: the tokens bought (= the payout if right), at most the order.
export function betQuote(o, stake) {
  const s = BigInt(stake);
  if (s <= 0n) throw new Error('Enter an amount');
  if (s > o.pairTotal) throw new Error('More than this offer holds');
  const tokens = payoutFor(o, s);
  if (tokens <= 0n) throw new Error('Too little for one token');
  return { stake: s, tokens, payout: tokens, profit: tokens - s };
}

// Redeem: N tokens of one side back for collateral, after Settle (N if that side won) or Void (N / 2, rounded down)
export const redeemBody = (ev, side) => ({ t: 'Dict', v: [...eventFields(ev), ['Position', { t: 'String', v: side === 'up' ? 'Bull' : 'Bear' }]] });
// what N tokens of a side pay now: null while the market is open or waiting for its Settle
export function redeemValue(m, side, n) {
  const k = BigInt(n);
  if (m.status === 'void') return k / 2n;
  if (m.status === 'settled' && m.result) return (m.result === 'bull') === (side === 'up') ? k : 0n;
  return null;
}

// What the node may add to a Redeem, checked before signing: the contract pays this wallet `amount` of the collateral
// (one unit per winning token, half a unit after a void) and sends nothing to anyone else.
export function expectRedeem(collateral, amount, myHash) {
  return (added, cid) => {
    const isC = l => l.type === 'Contract' && l.contractId.version === cid.version && hex(l.contractId.hash) === hex(cid.hash);
    const toMe = l => l.type === 'PK' && hex(l.hash) === myHash;
    for (const x of added.outputs) if (!isC(x.lock) && !toMe(x.lock) && x.lock.type !== 'Destroy') throw new Error('The contract would pay someone else');
    const got = added.outputs.filter(x => toMe(x.lock) && assetToId(x.spend.asset) === collateral).reduce((a, x) => a + x.spend.amount, 0n);
    if (got !== BigInt(amount)) throw new Error('The contract would not pay what this market owes');
  };
}
