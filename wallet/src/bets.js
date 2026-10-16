// Up / Down bets on the oracle's prices (the FixedPayout contract, ported to ZP contracts V1 by the oracle/Dex session).
//
// A market is one event: will TICKER be at or above STRIKE at CLOSE? The contract mints a pair for each unit of
// collateral (zUSDC): one Bull ("Up") token and one Bear ("Down") token. After the close, each token of the winning side
// redeems for one unit of collateral. There is no matching in the contract: a bet is a Dex Take of an order that
// sells Up or Down tokens for zUSDC. The site lists the markets and positions (GET /explorer/api/bets/markets and
// /bets/positions?address=). The Redeem body follows the oracle/Dex session's description; it is checked byte for
// byte against their testnet vectors once the contract is active.
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
  return ev;
}
export const eventFields = ev => [
  ['OraclePubKey', { t: 'PublicKey', v: unhex(ev.oraclePubKey) }], ['OracleContractId', { t: 'String', v: ev.oracleContractId }],
  ['Ticker', { t: 'String', v: ev.ticker }], ['Price', { t: 'U64', v: ev.price }], ['Start', { t: 'U64', v: ev.start }],
  ['Expiry', { t: 'U64', v: ev.expiry }], ['Collateral', { t: 'String', v: ev.collateral }]];

// one row of GET /explorer/api/bets/markets, checked; rows that do not parse are left out by the caller
export function marketOf(row) {
  const ev = eventOf(row?.event);
  const m = { ticker: ev.ticker, strike: Number(ev.price) / 1000, close: Number(ev.start), collateral: ev.collateral, event: ev,
    bull: String(row?.bull || '').toLowerCase(), bear: String(row?.bear || '').toLowerCase(),
    status: ['open', 'closed', 'settled', 'void'].includes(row?.status) ? row.status : 'open',
    result: row?.result === 'bull' || row?.result === 'bear' ? row.result : null,
    settlePrice: row?.settlePrice == null ? null : Number(row.settlePrice), contract: HEX(72).test(String(row?.contract || '')) ? row.contract : null };
  if (!ASSET.test(m.bull) || !ASSET.test(m.bear) || m.bull === m.bear) throw new Error('market: bad position tokens');
  return m;
}
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

// Redeem: the winning tokens back for collateral, with the oracle's proof of the close price
// (GET /oracle/auditpath?ticker=&timestamp= -> {valueScaled, timestamp, root, index, auditPath}).
export function redeemBody(ev, side, proof) {
  const path = Array.isArray(proof?.auditPath) ? proof.auditPath.map(h => String(h).toLowerCase()) : null;
  if (!path || path.length > 30 || !path.every(h => HEX(64).test(h))) throw new Error('Bad oracle proof');
  const root = String(proof.root || '').toLowerCase(); if (!HEX(64).test(root)) throw new Error('Bad oracle proof');
  if (BigInt(proof.timestamp) !== ev.start) throw new Error('The oracle proof is not for the close of this market');
  return { t: 'Dict', v: [...eventFields(ev), ['Position', { t: 'String', v: side === 'up' ? 'Bull' : 'Bear' }],
    ['Timestamp', { t: 'U64', v: u64(proof.timestamp, 'timestamp') }], ['Root', { t: 'Hash', v: unhex(root) }],
    ['Value', { t: 'U64', v: u64(proof.valueScaled, 'value') }], ['Index', { t: 'U64', v: u64(proof.index, 'index') }],
    ['AuditPath', { t: 'List', v: path.map(h => ({ t: 'Hash', v: unhex(h) })) }]] };
}
// who won, from the proof (the contract's rule): Up if the value is at or above the strike
export const winner = (ev, valueScaled) => BigInt(valueScaled) >= ev.price ? 'up' : 'down';

// What the node may add to a Redeem, checked before signing: the contract pays this wallet `amount` of the collateral
// (one unit per winning token) and sends nothing to anyone else.
export function expectRedeem(collateral, amount, myHash) {
  return (added, cid) => {
    const isC = l => l.type === 'Contract' && l.contractId.version === cid.version && hex(l.contractId.hash) === hex(cid.hash);
    const toMe = l => l.type === 'PK' && hex(l.hash) === myHash;
    for (const x of added.outputs) if (!isC(x.lock) && !toMe(x.lock) && x.lock.type !== 'Destroy') throw new Error('The contract would pay someone else');
    const got = added.outputs.filter(x => toMe(x.lock) && assetToId(x.spend.asset) === collateral).reduce((a, x) => a + x.spend.amount, 0n);
    if (got !== BigInt(amount)) throw new Error('The contract would not pay one unit per winning token');
  };
}
