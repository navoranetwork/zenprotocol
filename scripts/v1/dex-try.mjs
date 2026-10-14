// Tests of the V1 Dex (contracts/v1/Dex.fst) against the contract engine service: the node's own verdict (check) and
// calls run as a node runs them, with gas (try). Nothing is signed, sent or activated.
// Needs a node image whose Zulib V1 realizes Zen.Asset.parse (order assets are strings); before it, check refuses at
// extraction.
//
// usage: node scripts/v1/dex-try.mjs [engine url]     (default http://127.0.0.1:11580/engine)
// On the testnet server, from a zenprotocol checkout on node-upgrade-script:
//   docker run --rm --network host -v "$PWD":/b -w /b node:22-alpine node scripts/v1/dex-try.mjs
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const ENGINE = (process.argv[2] || 'http://127.0.0.1:11580/engine').replace(/\/$/, '');
const source = readFileSync(new URL('../../contracts/v1/Dex.fst', import.meta.url), 'utf8');
const sha3 = (...parts) => createHash('sha3-256').update(Buffer.concat(parts.map(p => typeof p === 'string' ? Buffer.from(p, 'hex') : p))).digest('hex');
const be32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const contractHash = sha3(be32(1), Buffer.from(source, 'utf8'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

function varint(n) { const t = []; let len = 0; for (;;) { t[len] = (n & 0x7f) | (len ? 0x80 : 0); if (n <= 0x7f) break; n = Math.floor(n / 128) - 1; len++; } return Buffer.from(t.reverse()); }
const str = s => Buffer.concat([varint(Buffer.byteLength(s)), Buffer.from(s, 'utf8')]);
const D = {
  u64: n => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return Buffer.concat([Buffer.of(5), b]); },
  string: s => Buffer.concat([Buffer.of(6), str(s)]),
  publicKey: k => Buffer.concat([Buffer.of(10), Buffer.from(k, 'hex')]),
  pkLock: hash => Buffer.concat([Buffer.of(8), varint(2), varint(32), Buffer.from(hash, 'hex')]),
};
const dict = o => { const ks = Object.keys(o).sort((a, b) => Buffer.byteLength(a) - Buffer.byteLength(b) || Buffer.compare(Buffer.from(a), Buffer.from(b))); return Buffer.concat([Buffer.of(12), varint(ks.length), ...ks.flatMap(k => [str(k), o[k]])]).toString('hex'); };

// keys: the engine families' example keys (public, test only)
const M = '03774ae7f858a9411e5ef4246b70c65aac5649980be5c17891bbec17895da008cb';   // the maker
const T = '03421f5fc9a21065445c96fdb91c0c1e2f2431741c72713b4b99ddcb316f31e9fc';   // a taker
const pkHash = k => sha3(k);
const TOKEN = sha3(Buffer.from('a test token for the Dex'));        // stands for zUSDC: a version 1 contract's default token
const TOKEN_ID = '00000001' + TOKEN;                                 // as the Dex body writes it (Zen.Asset.parse, 72 hex)
const ZP = 10_000_000_000, USD = 10_000_000;                          // the order: 100 ZP for 10 zUSDC (6 decimals)
const order = (o = {}) => ({ UnderlyingAsset: D.string('00'), UnderlyingAmount: D.u64(ZP), PairAsset: D.string(TOKEN_ID), OrderTotal: D.u64(USD), MakerPubKey: D.publicKey(M), ...o });
const isZp = a => a === 'zp' || a === '00';
const isToken = a => typeof a === 'string' && a.toLowerCase().includes(TOKEN);
const isOrderToken = a => typeof a === 'string' && a.toLowerCase().includes(contractHash) && !isToken(a);

async function job(path, body) {
  const r = await fetch(`${ENGINE}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (r.status !== 202) throw new Error(`${path}: HTTP ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  for (let i = 0; i < 300; i++) {
    await sleep(i < 5 ? 1000 : 2000);
    const s = await (await fetch(`${ENGINE}/job/${j.job}`)).json();
    if (s.status === 'done') return s;
    if (s.status === 'failed' || s.status === 'timeout') throw new Error(`${path}: ${s.status} ${s.error || ''}`);
  }
  throw new Error(`${path}: no answer in 10 minutes`);
}

let failures = 0;
const costs = {};
const ok = (name, cond, detail) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : '\n      ' + detail}`); if (!cond) failures++; };
const out = (r, kind, hash, pred) => (r.outputs || []).find(o => o.who?.kind === kind && (hash === null || o.who.hash === hash) && pred(o));
async function call(name, c, expect) {
  const s = await job('try', { sourceId: contractHash, call: { context: { blockNumber: 3000, timestamp: '1791900000000' }, wallet: [], ...c } });
  if (!s.try) { ok(name, false, 'no try in the answer: ' + JSON.stringify(s).slice(0, 400)); return null; }
  const r = s.try.result;
  costs[name] = `declared ${r.declaredCost}, used ${r.gasUsed}`;
  if (expect.error) ok(`${name}: refused with "${expect.error}"`, r.ok === false && r.error === expect.error, `got ok=${r.ok} error=${JSON.stringify(r.error)}`);
  else ok(`${name}: succeeds`, r.ok === true, `error: ${JSON.stringify(r.error)}`);
  if (expect.declared !== undefined) ok(`${name}: declared cost ${expect.declared}`, String(r.declaredCost) === String(expect.declared), costs[name]);
  if (r.ok) ok(`${name}: gas used = declared`, String(r.gasUsed) === String(r.declaredCost), costs[name]);
  if (r.ok && expect.check) for (const [what, f] of expect.check) ok(`${name}: ${what}`, !!f(r), JSON.stringify(r.outputs).slice(0, 700));
  return s.try;
}

console.log(`engine ${ENGINE}\ncontract: ${Buffer.byteLength(source)} bytes, id 00000001${contractHash}`);
const chk = await job('check', { source });
const c = chk.check || {};
ok('check: a node would accept it', c.verdict === 'accepted', `verdict ${c.verdict}; refusal ${JSON.stringify(c.refusal)}; node: ${c.nodeMessage}`);
ok('check: same contract id as computed here', (c.contractId || '').endsWith(contractHash), `engine says ${c.contractId}`);
ok('check: the engine runs the testnet toolchain', c.toolchain?.consensusFilesMatch === true, JSON.stringify(c.toolchain));
console.log(`      elaborated costs: ${JSON.stringify(c.costs)}; activation: ${JSON.stringify(c.activation)}`);
if (c.verdict !== 'accepted') { console.log('\nStopped: the node would refuse the contract.'); process.exit(1); }

// Make: the maker sells 100 ZP for 10 of the token
const made = await call('Make: 100 ZP for 10 tokens', { command: 'Make', sender: { publicKey: M }, spend: [{ asset: 'zp', amount: String(ZP) }], bodyHex: dict(order()) }, {
  declared: 3693,
  check: [['the order token (1) is kept by the contract', r => out(r, 'contract', contractHash, o => isOrderToken(o.asset) && String(o.amount) === '1')],
          ['the 100 ZP are kept by the contract', r => out(r, 'contract', contractHash, o => isZp(o.asset) && String(o.amount) === String(ZP))]] });
await call('Make: less ZP sent than the order says', { command: 'Make', sender: { publicKey: M }, spend: [{ asset: 'zp', amount: String(ZP - 1) }], bodyHex: dict(order()) }, { error: 'Incorrect amount of UnderlyingAsset Received' });
await call('Make: MakerPubKey is not the signer', { command: 'Make', sender: { publicKey: T }, spend: [{ asset: 'zp', amount: String(ZP) }], bodyHex: dict(order()) }, { error: 'SenderPubKey must match MakerPubKey' });
await call('Make: anonymous', { command: 'Make', spend: [{ asset: 'zp', amount: String(ZP) }], bodyHex: dict(order()) }, { error: 'Must authenticate with PubKey' });
await call('Make: PairAsset not an asset', { command: 'Make', sender: { publicKey: M }, spend: [{ asset: 'zp', amount: String(ZP) }], bodyHex: dict(order({ PairAsset: D.string('zz') })) }, { error: 'Could not parse PairAsset' });
await call('Make: OrderTotal 0', { command: 'Make', sender: { publicKey: M }, spend: [{ asset: 'zp', amount: String(ZP) }], bodyHex: dict(order({ OrderTotal: D.u64(0) })) }, { error: 'Could not parse OrderTotal, or OrderTotal was 0' });
await call('Make: a token with a subtype (136 hex) as PairAsset', { command: 'Make', sender: { publicKey: M }, spend: [{ asset: 'zp', amount: String(ZP) }], bodyHex: dict(order({ PairAsset: D.string(TOKEN_ID + sha3(Buffer.from('sub'))) })) }, { declared: 3693 });

const w = made?.next?.wallet || [];
// Cancel
await call('Cancel by the maker', { command: 'Cancel', sender: { publicKey: M }, wallet: w, bodyHex: dict(order()) }, {
  declared: 4486 + 256 * w.length,
  check: [['the 100 ZP go back to the maker', r => out(r, 'pk', pkHash(M), o => isZp(o.asset) && String(o.amount) === String(ZP))],
          ['the order token is destroyed', r => out(r, 'destroy', null, o => isOrderToken(o.asset) && String(o.amount) === '1')]] });
await call('Cancel by someone else', { command: 'Cancel', sender: { publicKey: T }, wallet: w, bodyHex: dict(order()) }, { error: 'SenderPubKey must match MakerPubKey' });
await call('Cancel an order that is not there', { command: 'Cancel', sender: { publicKey: M }, bodyHex: dict(order()) }, { error: 'Could not find order in wallet. Ensure that both the order and the correct amount of the underlying are present.' });

// Take
const take = (paid, payout, extra = {}) => dict({ ...order(), RequestedPayout: D.u64(payout), ProvidedAmount: D.u64(paid), returnAddress: D.pkLock(pkHash(T)), ...extra });
await call('Take all: 10 tokens for 100 ZP', { command: 'Take', sender: { publicKey: T }, wallet: w, spend: [{ asset: TOKEN, amount: String(USD) }], bodyHex: take(USD, ZP) }, {
  declared: 8020 + 256 * w.length,
  check: [['100 ZP to the taker', r => out(r, 'pk', pkHash(T), o => isZp(o.asset) && String(o.amount) === String(ZP))],
          ['10 tokens to the maker', r => out(r, 'pk', pkHash(M), o => isToken(o.asset) && String(o.amount) === String(USD))],
          ['the order token is destroyed', r => out(r, 'destroy', null, o => isOrderToken(o.asset))]] });
await call('Take half: 5 tokens for 50 ZP', { command: 'Take', sender: { publicKey: T }, wallet: w, spend: [{ asset: TOKEN, amount: String(USD / 2) }], bodyHex: take(USD / 2, ZP / 2) }, {
  check: [['50 ZP to the taker', r => out(r, 'pk', pkHash(T), o => isZp(o.asset) && String(o.amount) === String(ZP / 2))],
          ['5 tokens to the maker', r => out(r, 'pk', pkHash(M), o => isToken(o.asset) && String(o.amount) === String(USD / 2))],
          ['a new order for the rest: 50 ZP kept by the contract', r => out(r, 'contract', contractHash, o => isZp(o.asset) && String(o.amount) === String(ZP / 2))]] });
await call('Take: a payout above the price', { command: 'Take', sender: { publicKey: T }, wallet: w, spend: [{ asset: TOKEN, amount: String(USD / 2) }], bodyHex: take(USD / 2, ZP / 2 + 1) }, { error: 'Incorrect requestedPayout' });
await call('Take: no returnAddress', { command: 'Take', sender: { publicKey: T }, wallet: w, bodyHex: dict({ ...order(), RequestedPayout: D.u64(ZP), ProvidedAmount: D.u64(USD) }) }, { error: 'Could not parse returnAddress' });
await call('Unknown command', { command: 'Swap', sender: { publicKey: M }, bodyHex: dict(order()) }, { error: 'Unrecognised command', declared: 9 });

console.log(`\ncontract id 00000001${contractHash}\ncosts:`);
for (const [n, g] of Object.entries(costs)) console.log(`  ${n}: ${g}`);
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
