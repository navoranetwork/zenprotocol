// ZenDex (contracts/v1/Dex.fst, the same message formats as V0): orders of "UnderlyingAmount of UnderlyingAsset for
// OrderTotal of PairAsset", made and cancelled by the maker's key (a signed call), taken by anyone (an anonymous call)
// in full or in part: the taker sends ProvidedAmount of the pair asset and gets
// RequestedPayout = floor(UnderlyingAmount * ProvidedAmount / OrderTotal) of the underlying; a part fill leaves a new
// order for the rest. Costs (testnet V1): Make 3693, Cancel 4486 and Take 8020, + 256 per coin the Dex holds.
import { sha3_256 } from '@noble/hashes/sha3.js';
import { unhex, hex, assetToId } from './serialize.js';

const ASSET_ID = /^(00|[0-9a-f]{72}([0-9a-f]{64})?)$/;
const U64_MAX = (1n << 64n) - 1n;

// an order as the explorer's index lists it (site/explorer-api.mjs /dex/orders), checked
export function orderOf(row) {
  const o = { underAsset: String(row?.under_asset || ''), underAmount: BigInt(String(row?.under_amount || '0')), pairAsset: String(row?.pair_asset || ''),
    pairTotal: BigInt(String(row?.pair_total || '0')), maker: String(row?.maker || '').toLowerCase(), tx: String(row?.tx || ''), block: Number(row?.block) || 0 };
  if (!ASSET_ID.test(o.underAsset) || !ASSET_ID.test(o.pairAsset) || o.underAsset === o.pairAsset) throw new Error('order: bad assets');
  if (o.underAmount <= 0n || o.pairTotal <= 0n || o.underAmount > U64_MAX || o.pairTotal > U64_MAX) throw new Error('order: bad amounts');
  if (!/^0[23][0-9a-f]{64}$/.test(o.maker)) throw new Error('order: bad maker key');
  return o;
}

const orderFields = o => [
  ['UnderlyingAsset', { t: 'String', v: o.underAsset }], ['UnderlyingAmount', { t: 'U64', v: o.underAmount }],
  ['PairAsset', { t: 'String', v: o.pairAsset }], ['OrderTotal', { t: 'U64', v: o.pairTotal }],
  ['MakerPubKey', { t: 'PublicKey', v: unhex(o.maker) }]];
export const makeBody = o => ({ t: 'Dict', v: orderFields(o) });
export const cancelBody = o => ({ t: 'Dict', v: orderFields(o) });
export const payoutFor = (o, provided) => o.underAmount * BigInt(provided) / o.pairTotal;   // floor, as the Dex checks it
export function takeBody(o, provided, returnHash) {
  provided = BigInt(provided);
  if (provided <= 0n || provided > o.pairTotal) throw new Error(`Give between a little and the whole order (${o.pairTotal} units)`);
  const payout = payoutFor(o, provided);
  if (payout <= 0n) throw new Error('That is too little: it would pay out nothing');
  return { body: { t: 'Dict', v: [...orderFields(o), ['RequestedPayout', { t: 'U64', v: payout }], ['ProvidedAmount', { t: 'U64', v: provided }],
    ['returnAddress', { t: 'Lock', v: { type: 'PK', hash: returnHash } }]] }, payout };
}
export const pkHashOf = pubHex => hex(sha3_256(unhex(pubHex)));
export const mine = (o, myPubHex) => o.maker === String(myPubHex).toLowerCase();

// What the node may add to each call, checked before anything is signed. `added` = {inputs, outputs} after ours;
// `dex` = the Dex contract id {version, hash}.
const isDex = (lock, dex) => lock.type === 'Contract' && lock.contractId.version === dex.version && hex(lock.contractId.hash) === hex(dex.hash);
const pkTo = (lock, h) => lock.type === 'PK' && hex(lock.hash) === h;
const sum = (outs, f) => outs.filter(f).reduce((a, x) => a + x.spend.amount, 0n);
export function expectTake(o, provided, payout, myHash) {
  return (added, dex) => {
    const makerHash = pkHashOf(o.maker);
    for (const x of added.outputs) if (!isDex(x.lock, dex) && !pkTo(x.lock, myHash) && !pkTo(x.lock, makerHash) && x.lock.type !== 'Destroy') throw new Error('The Dex would pay someone else');
    if (sum(added.outputs, x => pkTo(x.lock, myHash) && assetToId(x.spend.asset) === o.underAsset) !== payout) throw new Error('The Dex would not pay you what the order says');
    if (sum(added.outputs, x => pkTo(x.lock, makerHash) && assetToId(x.spend.asset) === o.pairAsset) !== BigInt(provided)) throw new Error('The Dex would not pay the maker what you give');
  };
}
export function expectMake(o) {
  return (added, dex) => {
    for (const x of added.outputs) if (!isDex(x.lock, dex)) throw new Error('The Dex would send your coins elsewhere');
    if (sum(added.outputs, x => assetToId(x.spend.asset) === o.underAsset) < o.underAmount) throw new Error('The Dex would not hold the whole order');
  };
}
export function expectCancel(o, myHash) {
  return (added, dex) => {
    for (const x of added.outputs) if (!isDex(x.lock, dex) && !pkTo(x.lock, myHash) && x.lock.type !== 'Destroy') throw new Error('The Dex would pay someone else');
    if (sum(added.outputs, x => pkTo(x.lock, myHash) && assetToId(x.spend.asset) === o.underAsset) !== o.underAmount) throw new Error('The Dex would not give back the whole order');
  };
}
