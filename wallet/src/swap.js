// ZP <-> BTC swap (BitZen, a V1 contract): what a seller signs to offer ZP for bitcoin or to cancel an offer.
// The contract (bitzen contracts/v1/BitZenSwap.fst) takes:
//   offer  { id: String, sats: U64, s0..s3: String (hex Bitcoin output scripts, one per reservation), returnAddress: Lock }
//          signed by the seller's key; the ZP that the transaction leaves unspent is locked in the contract for the offer
//   cancel { id }  signed by the same key, while the offer is not reserved: the ZP goes back to returnAddress
// Sending them (contract/execute, signing, publishing) is in wallet.js.
import { sha256 } from '@noble/hashes/sha2.js';
import { bech32, bech32m, createBase58check } from '@scure/base';
import { hex } from './serialize.js';

export const MAX_SCRIPTS = 4;                    // the contract holds s0..s3: at most 4 reservations per offer
export const MIN_SATS = 546;                      // below Bitcoin's dust limit no wallet would send it
export const MAX_SATS = 21_000_000n * 100_000_000n;
const base58check = createBase58check(sha256);

// A Bitcoin address -> its output script (hex). net: 'main' (bc1, 1, 3) or 'test' (tb1, m/n, 2).
// The BitZen chain contract on the ZP testnet follows Bitcoin mainnet, so offers there take mainnet addresses.
export function btcScript(address, net = 'main') {
  const a = String(address || '').trim();
  if (!a) throw new Error('Enter a Bitcoin address');
  const hrp = net === 'main' ? 'bc' : 'tb';
  if (/^(bc|tb|bcrt)1/i.test(a)) {
    if (a !== a.toLowerCase() && a !== a.toUpperCase()) throw new Error('Mixed upper and lower case: not a valid Bitcoin address');
    const s = a.toLowerCase();
    let d, m = false;
    try { d = bech32.decode(s, 90); } catch { try { d = bech32m.decode(s, 90); m = true; } catch { throw new Error('Not a valid Bitcoin address: check every character'); } }
    if (d.prefix !== hrp) throw new Error(net === 'main' ? 'This is a Bitcoin testnet address: give a mainnet address (bc1…, 1…, 3…)' : 'This is a Bitcoin mainnet address: give a testnet address (tb1…)');
    const ver = d.words[0], prog = Uint8Array.from(bech32.fromWords(d.words.slice(1)));
    if (ver > 16 || prog.length < 2 || prog.length > 40) throw new Error('Not a valid Bitcoin address');
    if ((ver === 0) === m) throw new Error('Not a valid Bitcoin address (wrong checksum type)');
    if (ver === 0 && prog.length !== 20 && prog.length !== 32) throw new Error('Not a valid Bitcoin address');
    if (ver === 1 && prog.length !== 32) throw new Error('Not a valid Bitcoin address');
    return hex(Uint8Array.from([ver === 0 ? 0 : 0x50 + ver, prog.length, ...prog]));
  }
  let b;
  try { b = base58check.decode(a); } catch { throw new Error('Not a valid Bitcoin address: check every character'); }
  if (b.length !== 21) throw new Error('Not a valid Bitcoin address');
  const v = b[0], h = b.slice(1);
  const p2pkh = net === 'main' ? [0x00] : [0x6f], p2sh = net === 'main' ? [0x05] : [0xc4];
  if (p2pkh.includes(v)) return hex(Uint8Array.from([0x76, 0xa9, 20, ...h, 0x88, 0xac]));
  if (p2sh.includes(v)) return hex(Uint8Array.from([0xa9, 20, ...h, 0x87]));
  if ([0x00, 0x05, 0x6f, 0xc4].includes(v)) throw new Error(net === 'main' ? 'This is a Bitcoin testnet address: give a mainnet address' : 'This is a Bitcoin mainnet address: give a testnet address');
  throw new Error('Not a Bitcoin address');
}

// "0.0005" or "0.0005 BTC" -> satoshis (BigInt)
export function parseBTC(text) {
  const m = String(text).trim().replace(/\s*btc$/i, '').match(/^(\d+)(?:\.(\d{1,8}))?$/);
  if (!m) throw new Error('Enter the price in BTC, for example 0.0005');
  const v = BigInt(m[1]) * 100_000_000n + BigInt((m[2] || '').padEnd(8, '0'));
  if (v < BigInt(MIN_SATS)) throw new Error(`The price must be at least ${MIN_SATS} satoshis (0.00000546 BTC)`);
  if (v > MAX_SATS) throw new Error('That is more bitcoin than exists');
  return v;
}
export const formatBTC = sats => (Number(sats) / 1e8).toFixed(8);

// offer ids: short, readable, and never the contract's own keys
export function checkOfferId(id) {
  if (!/^[a-z0-9-]{3,24}$/.test(id)) throw new Error('Offer id: 3 to 24 characters, a-z, 0-9 and -');
  if (['chain', 'un'].includes(id) || /^u[0-7]$/.test(id)) throw new Error('That id is reserved: choose another');
  return id;
}
export const newOfferId = () => 'o-' + Array.from(crypto.getRandomValues(new Uint8Array(5)), b => b.toString(36).padStart(2, '0')).join('').slice(0, 8);

// message bodies (Data). returnHash: the seller's PK hash (32 bytes) that gets the ZP back on cancel
export function offerBody({ id, sats, scripts, returnHash }) {
  checkOfferId(id);
  if (!Array.isArray(scripts) || scripts.length < 1 || scripts.length > MAX_SCRIPTS) throw new Error(`Give 1 to ${MAX_SCRIPTS} Bitcoin addresses`);
  if (new Set(scripts).size !== scripts.length) throw new Error('Each Bitcoin address must be different (one per reservation)');
  for (const s of scripts) if (!/^([0-9a-f]{2}){4,42}$/.test(s)) throw new Error('Invalid Bitcoin output script');
  if (!(returnHash instanceof Uint8Array) || returnHash.length !== 32) throw new Error('Invalid return address');
  return { t: 'Dict', v: [
    ['id', { t: 'String', v: id }],
    ['sats', { t: 'U64', v: BigInt(sats) }],
    ...scripts.map((s, i) => ['s' + i, { t: 'String', v: s }]),
    ['returnAddress', { t: 'Lock', v: { type: 'PK', hash: returnHash } }],
  ] };
}
export const cancelBody = id => ({ t: 'Dict', v: [['id', { t: 'String', v: checkOfferId(id) }]] });

// The total price (satoshis) of an offer from a price per ZP. kalapas: the ZP sold (BigInt).
//   unit 'sat': "1250" or "0.5" sat per ZP (exact)
//   unit 'usd': "1.25" dollars per ZP at btcUsd dollars per bitcoin (the contract keeps the satoshis, not the dollars)
export function totalFromPerZp(text, kalapas, unit, btcUsd) {
  const m = String(text).trim().replace(/^\$/, '').match(/^(\d+)(?:\.(\d{1,8}))?$/);
  if (!m) throw new Error(unit === 'usd' ? 'Enter the price per ZP in dollars, for example 1.25' : 'Enter the price per ZP in satoshis, for example 1250');
  const scaled = BigInt(m[1]) * 100_000_000n + BigInt((m[2] || '').padEnd(8, '0'));   // per ZP x 1e8
  if (scaled === 0n) throw new Error('The price must be above zero');
  let sats;
  if (unit === 'sat') sats = (scaled * BigInt(kalapas) + 5n * 10n ** 15n) / 10n ** 16n;
  else if (unit === 'usd') {
    if (!(btcUsd > 0)) throw new Error('No Bitcoin price from the oracle right now: give the price in BTC or satoshis');
    sats = BigInt(Math.round(Number(scaled) / 1e8 * Number(kalapas) / 1e8 / btcUsd * 1e8));
  } else throw new Error('Unknown price unit');
  if (sats < BigInt(MIN_SATS)) throw new Error(`The total comes to ${sats} satoshis: at least ${MIN_SATS} are needed`);
  if (sats > MAX_SATS) throw new Error('That is more bitcoin than exists');
  return sats;
}
