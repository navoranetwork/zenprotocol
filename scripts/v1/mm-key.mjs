// Gives the market maker its own key in the node wallet, away from the bridge's ZP address.
// Why: the node wallet's address (/wallet/address, key m/44'/258'/0'/0/0) is the bridge's ZP address, and since
// 2026-10-15 the bridge pays out USDC by itself for zUSDC sent there from a linked address. A Dex Take pays the maker's
// key; with the market maker on that key, a taker would get the ZP and their zUSDC back as USDC.
//
// It asks the node wallet for a new address (/wallet/getnewaddress: key m/44'/258'/0'/2/N, which the wallet tracks and
// spends from), finds N by deriving the wallet's public keys, checks that it is neither the bridge's address nor the
// bridge's key (m/44'/258'/0'/3/0), and prints MM_SIGN for testnet-stack.env.
// usage: node scripts/v1/mm-key.mjs [node api] [wallet password] [testnet|mainnet]     env ADDRESS: check that address, make none;
//        env KEY_PATH: print that key's address, make none
import { createHash } from 'node:crypto';

const API = process.argv[2] || 'http://127.0.0.1:31567', PW = process.argv[3] || 'testnet', HRP = (process.argv[4] || 'testnet') === 'mainnet' ? 'zen' : 'tzn';
const post = async (p, b) => (await (await fetch(API + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).text()).trim().replace(/^"|"$/g, '');
const get = async p => (await (await fetch(API + p)).text()).trim().replace(/^"|"$/g, '');

// bech32 (BIP173), as the node encodes a PK address: hrp, witness version 0, the 32-byte SHA3-256 of the compressed key
const CH = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l', GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const polymod = v => { let c = 1; for (const x of v) { const b = c >>> 25; c = ((c & 0x1ffffff) << 5) ^ x; for (let i = 0; i < 5; i++) if ((b >>> i) & 1) c ^= GEN[i]; } return c >>> 0; };
const hrpExpand = h => [...[...h].map(c => c.charCodeAt(0) >> 5), 0, ...[...h].map(c => c.charCodeAt(0) & 31)];
function bits(data) { let acc = 0, n = 0; const out = []; for (const b of data) { acc = (acc << 8) | b; n += 8; while (n >= 5) { n -= 5; out.push((acc >> n) & 31); } } if (n) out.push((acc << (5 - n)) & 31); return out; }
function address(compressedHex) {
  const d = [0, ...bits(createHash('sha3-256').update(Buffer.from(compressedHex, 'hex')).digest())];
  const p = polymod([...hrpExpand(HRP), ...d, 0, 0, 0, 0, 0, 0]) ^ 1;
  return HRP + '1' + [...d, ...[0, 1, 2, 3, 4, 5].map(i => (p >>> (5 * (5 - i))) & 31)].map(x => CH[x]).join('');
}
const key = path => post('/wallet/publickey', { path, password: PW });

const bridgeZp = await get('/wallet/address');
const k00 = await key("m/44'/258'/0'/0/0");
if (address(k00) !== bridgeZp) { console.error(`address encoding check failed: ${address(k00)} vs the wallet's ${bridgeZp}`); process.exit(2); }
const bridgeKeyAddr = address(await key("m/44'/258'/0'/3/0"));
// KEY_PATH=m/44'/258'/0'/2/N: print the address of a key made earlier (e.g. BETS_SIGN) and stop
if (process.env.KEY_PATH) { console.log(address(await key(process.env.KEY_PATH))); process.exit(0); }
// ADDRESS=<tzn1…>: check an address made earlier instead of making a new one
let fresh = process.env.ADDRESS || await post('/wallet/getnewaddress', {});
try { const j = JSON.parse(fresh); if (j && j.address) fresh = j.address; } catch { /* a plain address */ }   // the node answers {address, index}
if (!fresh.startsWith(HRP + '1')) { console.error('getnewaddress: ' + fresh.slice(0, 200)); process.exit(2); }
let found = -1;
for (let i = 0; i < 1000 && found < 0; i++) if (address(await key(`m/44'/258'/0'/2/${i}`)) === fresh) found = i;
if (found < 0) { console.error(`the new address ${fresh} is not m/44'/258'/0'/2/0..999`); process.exit(2); }
if (fresh === bridgeZp || fresh === bridgeKeyAddr) { console.error('the new address is the bridge address or the bridge key: refused'); process.exit(2); }
console.log(`the bridge's ZP address (keep the market maker off it): ${bridgeZp}\nthe market maker's own address: ${fresh}\n\nIn ~/zenprotocol-testnet/testnet-stack.env:\nMM_SIGN=m/44'/258'/0'/2/${found}`);
