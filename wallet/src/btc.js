// Bitcoin helpers for ZP <-> BTC (BitZenSwap): waiting times, payment links, receive addresses from an account key
// (BIP84 / BIP49), and the Bitcoin wallets in the browser. The ZP Wallet never holds Bitcoin keys: a Bitcoin wallet
// only tells us an address, or sends "X sats to address Y" after its own confirm screen. No message signing, no PSBTs.
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { bech32, createBase58check } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { btcScript, checkFresh, formatBTC } from './swap.js';
import { hex } from './serialize.js';

const base58check = createBase58check(sha256);
const hash160 = b => ripemd160(sha256(b));

// ---------------------------------------------------------------- waiting times (BitZenSwap, by the offer's price)
export const BLOCK_MIN = 4;                                                         // a ZP block, minutes
export const confsFor = sats => sats <= 1e6 ? 2 : sats <= 1e7 ? 3 : sats <= 1e8 ? 4 : 6;   // Bitcoin confirmations
export const holdOf = sats => sats <= 1e6 ? 20 : sats <= 1e7 ? 30 : 60;            // ZP blocks a reservation is held
export const payOf = sats => sats <= 1e6 ? 8 : sats <= 1e7 ? 11 : 15;              // ... of which the buyer has these to pay
export const PROOF_MIN = 6;                                                         // proof and its ZP block, about
export const afterPayMin = sats => confsFor(sats) * 10 + PROOF_MIN;                 // from paying to holding the ZP

// The buyer may still pay when the reservation leaves time for the confirmations: blocks left > hold - pay.
// Before a Bitcoin wallet is asked to send, the payment must match the reservation exactly.
export function payCheck({ offer, buy, zpTip, cap = null }) {
  if (!offer || !buy || offer.id !== buy.id) return 'This offer is not your reservation';
  if (!buy.pk || String(offer.buyer || '').toLowerCase() !== String(buy.pk).toLowerCase()) return 'The offer is not reserved for this wallet';
  if (offer.state !== 'reserved') return 'Your reservation is not active';
  if (offer.payment) return 'A payment was already seen for this reservation';
  if (!offer.address) return 'The offer has no Bitcoin address';
  const left = Number(offer.until) - Number(zpTip), rest = holdOf(offer.sats) - payOf(offer.sats);
  if (!(left > rest)) return 'Too little time is left on your reservation for the Bitcoin confirmations: do not pay';
  if (cap != null && offer.sats > cap) return `Paying from a connected wallet is limited to ${formatBTC(cap)} BTC for now: use the QR code`;
  return null;
}

// BIP21 payment link
export const bip21 = (address, sats, label) => `bitcoin:${address}?amount=${formatBTC(sats).replace(/\.?0+$/, '')}${label ? '&label=' + encodeURIComponent(label) : ''}`;

// ---------------------------------------------------------------- receive addresses from an account key
// xpub/zpub (native SegWit, bc1q…), ypub (nested SegWit, 3…); tpub/vpub/upub for Bitcoin testnet. The key is the
// account (m/84'/0'/0' or m/49'/0'/0'); receive addresses are /0/i.
const VERSIONS = {
  '0488b21e': { net: 'main', kind: 'wpkh', name: 'xpub' }, '04b24746': { net: 'main', kind: 'wpkh', name: 'zpub' }, '049d7cb2': { net: 'main', kind: 'sh-wpkh', name: 'ypub' },
  '043587cf': { net: 'test', kind: 'wpkh', name: 'tpub' }, '045f1cf6': { net: 'test', kind: 'wpkh', name: 'vpub' }, '044a5262': { net: 'test', kind: 'sh-wpkh', name: 'upub' },
};
export function parseAccount(text, net = 'main') {
  const s = String(text || '').trim();
  if (!s) throw new Error('Paste your account key (zpub…, xpub… or ypub…)');
  if (/^[xyztuv]prv/.test(s)) throw new Error('This is a private key: never share it. Paste the public account key (…pub)');
  let raw; try { raw = base58check.decode(s); } catch { throw new Error('Not a valid account key: check every character'); }
  if (raw.length !== 78) throw new Error('Not a valid account key');
  const v = VERSIONS[hex(raw.slice(0, 4))];
  if (!v) throw new Error('Unknown key type: give a zpub, xpub or ypub');
  if (v.net !== net) throw new Error(net === 'main' ? 'This key is for Bitcoin testnet: give a mainnet key' : 'This key is for Bitcoin mainnet: give a testnet key');
  if (raw[4] !== 3) throw new Error('Give the account key (depth 3, for example m/84\'/0\'/0\'), as your wallet shows it under "account public key"');
  const ver = parseInt(hex(raw.slice(0, 4)), 16);
  const node = HDKey.fromExtendedKey(s, { private: 0, public: ver });
  return { key: s, ...v, recv: node.deriveChild(0), id: hex(hash160(node.publicKey)).slice(0, 16) };
}
export function accountAddress(acc, i) {
  const pk = acc.recv.deriveChild(i).publicKey, h = hash160(pk);
  if (acc.kind === 'wpkh') return bech32.encode(acc.net === 'main' ? 'bc' : 'tb', [0, ...bech32.toWords(h)]);
  const redeem = Uint8Array.from([0, 20, ...h]);
  return base58check.encode(Uint8Array.from([acc.net === 'main' ? 0x05 : 0xc4, ...hash160(redeem)]));
}
// The next `count` addresses that are new: not used by this browser, by any offer in the market, nor on Bitcoin.
// Bitcoin wallets (Sparrow, Electrum, BlueWallet…) watch only GAP unused addresses after the last one that received
// bitcoin: a payment beyond that does not show in the seller's wallet (not lost, but it looks unpaid). So the search
// starts after the last address seen used (lastUsed) and never hands out one past lastUsed + GAP. Addresses already
// handed out (known, market) are asked about too: one that was paid since moves the window on.
// checked: false when Bitcoin could not be asked (the caller then says so).
export const GAP = 20;
export async function freshAddresses(acc, { count, lastUsed = -1, known = [], market = [], api, fetchFn, gap = GAP } = {}) {
  const out = [], taken = new Set([...known, ...market]); let checked = true, handed = 0;
  const funded = async (addr, script) => { const r = await checkFresh([script], [addr], { api, fetchFn }); if (!r.checked) checked = false; return r.bad.length > 0; };
  for (let i = lastUsed + 1; out.length < count; i++) {
    if (i > lastUsed + gap) throw Object.assign(new Error(`Your Bitcoin wallet would not see payments beyond this: ${handed} addresses of your account are already in offers after the last one that received bitcoin, and Bitcoin wallets look only ${gap} ahead. Take back offers nobody reserved (their addresses come back), or raise the gap limit in your Bitcoin wallet (Sparrow, Electrum: Wallet → Settings) and paste addresses instead`), { gap: true });
    const addr = accountAddress(acc, i), script = btcScript(addr, acc.net);
    if (await funded(addr, script)) { lastUsed = i; handed = 0; continue; }
    if (taken.has(script)) { handed++; continue; }
    out.push({ addr, script, index: i });
  }
  return { list: out, lastUsed, checked };
}

// The network fee for paying a reservation: Bitcoin's next-block rate (sat/vB, rounded up) from the Esplora service,
// so the payment confirms while the reservation holds. null when it could not be asked.
export async function fetchFeeRate(api, fetchFn = (...a) => globalThis.fetch(...a)) {
  try {
    const r = await fetchFn(`${api}/fee-estimates`, { cache: 'no-store' }); if (!r.ok) return null;
    const j = await r.json(), v = Number(j?.['1'] ?? j?.['2'] ?? j?.['3']);
    return v > 0 && v < 10000 ? Math.ceil(v) : null;
  } catch { return null; }
}

// ---------------------------------------------------------------- Bitcoin wallets in the browser
// Wallets that register under window.btc_providers (WBIP004: Xverse, Leather, Magic Eden…) give their own name and icon.
// UniSat and OKX inject window.unisat and window.okxwallet.bitcoin with no icon: they get their original logo, bundled.
const okIcon = s => typeof s === 'string' && /^data:image\/(svg\+xml|png|webp|jpeg);base64,[A-Za-z0-9+/=]+$/.test(s) && s.length < 200000 ? s : null;
const at = (root, path) => String(path).split('.').reduce((o, k) => (o == null ? o : o[k]), root);
const rpc = async (p, method, params) => {
  const r = await p.request(method, params);
  if (r?.error) throw Object.assign(new Error(r.error.message || 'The wallet refused'), { code: r.error.code });
  return r?.result ?? r;
};
const pickAddress = list => {
  const xs = (Array.isArray(list) ? list : list?.addresses || []).map(a => typeof a === 'string' ? { address: a } : a).filter(a => a?.address);
  const btc = xs.filter(a => !a.symbol || a.symbol === 'BTC');
  return (btc.find(a => a.purpose === 'payment') || btc.find(a => /p2wpkh/i.test(a.type || a.addressType || '')) || btc[0])?.address || null;
};
// logos: the original logos bundled for wallets that give none ({ unisat, okx }: data URIs, web/icons/README.md)
export function findBtcWallets(win = globalThis, logos = {}) {
  const out = [], names = new Set();
  for (const e of Array.isArray(win.btc_providers) ? win.btc_providers : []) {
    const p = e && typeof e.id === 'string' && at(win, e.id); if (!p || typeof p.request !== 'function' || names.has(e.name)) continue;
    const leather = /leather/i.test(e.id + e.name);
    names.add(e.name);
    out.push({ id: 'wbip:' + e.id, name: String(e.name || 'Bitcoin wallet').slice(0, 40), icon: okIcon(e.icon),
      address: async () => { let r; try { r = await rpc(p, 'getAddresses', { purposes: ['payment'] }); } catch (err) { if (err.code === 4001) throw err; r = await rpc(p, 'getAccounts', { purposes: ['payment'] }); } return pickAddress(r); },
      send: async (to, sats) => (await rpc(p, 'sendTransfer', { recipients: [{ address: to, amount: leather ? String(sats) : Number(sats) }], ...(leather ? { network: 'mainnet' } : {}) }))?.txid || null });
  }
  if (win.unisat?.requestAccounts && !names.has('UniSat')) out.push({ id: 'unisat', name: 'UniSat', icon: okIcon(logos.unisat), bundled: !!okIcon(logos.unisat),
    address: async () => (await win.unisat.requestAccounts())?.[0] || null, send: async (to, sats, feeRate) => win.unisat.sendBitcoin(to, Number(sats), feeRate ? { feeRate } : undefined) });
  const okx = win.okxwallet?.bitcoin;
  if (okx?.connect && !names.has('OKX Wallet')) out.push({ id: 'okx', name: 'OKX Wallet', icon: okIcon(logos.okx), bundled: !!okIcon(logos.okx),
    address: async () => (await okx.connect())?.address || null, send: async (to, sats, feeRate) => okx.sendBitcoin(to, Number(sats), feeRate ? { feeRate } : undefined) });
  return out;
}
// Asks the wallet for its address and checks it is on the right Bitcoin network.
export async function connectBtcWallet(wallet, net = 'main') {
  const a = await wallet.address();
  if (!a) throw new Error(`${wallet.name} gave no Bitcoin address`);
  try { btcScript(a, net); } catch (e) {
    if (/testnet|mainnet/.test(e.message)) throw new Error(`${wallet.name} is on ${net === 'main' ? 'Bitcoin testnet' : 'Bitcoin mainnet'}: switch it to ${net === 'main' ? 'mainnet' : 'testnet'}, then connect again`);
    throw new Error(`${wallet.name} gave an address this swap cannot use: ${e.message}`);
  }
  return a;
}
// "Send X sats to Y" in the wallet's own confirm screen. Returns the Bitcoin transaction id when the wallet gives it.
// feeRate (sat/vB) is passed to wallets that take one (UniSat, OKX); others pick their own, and the page shows the rate.
export async function payWithWallet(wallet, { to, sats, net = 'main', feeRate = null }) {
  btcScript(to, net);
  if (!Number.isSafeInteger(Number(sats)) || Number(sats) <= 0) throw new Error('Invalid amount');
  try { return await wallet.send(to, Number(sats), feeRate); }
  catch (e) { if (e?.code === 4001 || /reject|cancel|denied/i.test(e?.message || '')) throw new Error('You cancelled in your Bitcoin wallet. Nothing was sent.'); throw new Error(`${wallet.name}: ${e?.message || 'the payment failed'}`); }
}
