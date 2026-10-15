// One test Take on the testnet's V1 Dex from the node wallet (until the Dex page and the wallet can take orders):
// takes part of the market maker's bid (it buys ZP with zUSDC) by selling it ZP, paid out to a new address of the node
// wallet (a taker of its own: not the bridge's ZP address, not the market maker's). A part fill also tests the remainder
// order the Dex makes.
//
// usage: node scripts/v1/dex-take.mjs [node api] [wallet password]
//        env: DEX (the Dex address, ctzn1…), ASSET (the zUSDC asset id), ZP (ZP to sell, default 10),
//             EXPLORER (http://127.0.0.1:11581/explorer/api)
// On the testnet server: docker run --rm --network host --env-file ~/zenprotocol-testnet/testnet-stack.env \
//   -e DEX=… -e ASSET=… -v "$PWD":/b -w /b node:22-alpine node scripts/v1/dex-take.mjs
import { createHash } from 'node:crypto';

const API = process.argv[2] || 'http://127.0.0.1:31567', PW = process.argv[3] || process.env.MM_PASSWORD || 'testnet';
const DEX = process.env.DEX || process.env.MM_DEX, ASSET = process.env.ASSET || process.env.MM_ASSET;
const EXPLORER = process.env.EXPLORER || 'http://127.0.0.1:11581/explorer/api';
const SELL = BigInt(Math.round(Number(process.env.ZP || '10') * 1e8));
if (!DEX || !ASSET) { console.error('DEX and ASSET (or MM_DEX and MM_ASSET) are required'); process.exit(2); }
const post = async (p, b) => (await (await fetch(API + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).text()).trim();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function varint(n) { const t = []; let len = 0; for (;;) { t[len] = (n & 0x7f) | (len ? 0x80 : 0); if (n <= 0x7f) break; n = Math.floor(n / 128) - 1; len++; } return Buffer.from(t.reverse()); }
const str = s => Buffer.concat([varint(Buffer.byteLength(s)), Buffer.from(s, 'utf8')]);
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return Buffer.concat([Buffer.of(5), b]); };
const string = s => Buffer.concat([Buffer.of(6), str(s)]);
const publicKey = k => Buffer.concat([Buffer.of(10), Buffer.from(k, 'hex')]);
const pkLock = h => Buffer.concat([Buffer.of(8), varint(2), varint(32), Buffer.from(h, 'hex')]);
const dict = o => { const ks = Object.keys(o).sort((a, b) => a.length - b.length || (a < b ? -1 : 1)); return Buffer.concat([Buffer.of(12), varint(ks.length), ...ks.flatMap(k => [str(k), o[k]])]).toString('hex'); };

// the market maker's bid: it gives zUSDC (under) and wants ZP (pair)
const { orders } = await (await fetch(EXPLORER + '/dex/orders')).json();
const bid = (orders || []).find(o => o.under_asset === ASSET && o.pair_asset === '00');
if (!bid) { console.error('no open bid (zUSDC for ZP) in the index yet: the index trails the node by about 10 blocks'); process.exit(1); }
const ua = BigInt(bid.under_amount), ot = BigInt(bid.pair_total);
const provided = SELL < ot ? SELL : ot, payout = ua * provided / ot;     // floor, as the Dex checks it
if (payout === 0n) { console.error('the payout would be 0: sell more ZP'); process.exit(1); }
log(`bid: ${Number(ua) / 1e6} zUSDC for ${Number(ot) / 1e8} ZP (maker ${bid.maker.slice(0, 12)}…); selling ${Number(provided) / 1e8} ZP for ${Number(payout) / 1e6} zUSDC`);

// the taker: a new address of the node wallet (m/44'/258'/0'/2/N)
const fresh = JSON.parse(await post('/wallet/getnewaddress', {}));
const takerKey = (await post('/wallet/publickey', { path: `m/44'/258'/0'/2/${fresh.index}`, password: PW })).replace(/"/g, '');
const takerHash = createHash('sha3-256').update(Buffer.from(takerKey, 'hex')).digest('hex');
log(`taker: ${fresh.address} (m/44'/258'/0'/2/${fresh.index})`);

const body = dict({
  UnderlyingAsset: string(bid.under_asset), UnderlyingAmount: u64(ua), PairAsset: string(bid.pair_asset), OrderTotal: u64(ot),
  MakerPubKey: publicKey(bid.maker), RequestedPayout: u64(payout), ProvidedAmount: u64(provided), returnAddress: pkLock(takerHash) });
const r = await post('/wallet/contract/execute', { address: DEX, command: 'Take', messageBody: body, options: { returnAddress: false }, spends: [{ asset: '00', amount: Number(provided) }], password: PW });
if (!/^"?[0-9a-f]{64}"?$/.test(r)) { console.error('Take refused: ' + r.slice(0, 600)); process.exit(1); }
log(`Take sent: ${r.replace(/"/g, '')}`);
console.log(`\nAfter its block: ${fresh.address} holds ${Number(payout) / 1e6} zUSDC; the market maker's key got ${Number(provided) / 1e8} ZP;\nthe Dex holds a new order for the rest (${Number(ua - payout) / 1e6} zUSDC for ${Number(ot - provided) / 1e8} ZP).`);
