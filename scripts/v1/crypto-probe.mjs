// Checks through the node itself that V1 contracts' Zen.Crypto works (parsePublicKey and Crypto.verify, libsecp256k1 as
// the node loads it for V1 contracts): activates contracts/v1/probes/CryptoProbe.fst for a few blocks from the node
// wallet and calls it twice: with a right vector (must be accepted) and with msg and other swapped (must be refused,
// "crypto check failed"). Vectors: zp-contracts-v1 contracts/crypto-test (made with libsecp256k1); the signature in
// the compact form a message body carries (r || s, big endian).
//
// usage: node scripts/v1/crypto-probe.mjs [node api] [wallet password]      env: FORK (2050), NUMBLOCKS (60)
// On the testnet server, from a zenprotocol checkout on node-upgrade-script:
//   docker run --rm --network host -v "$PWD":/b -w /b node:22-alpine node scripts/v1/crypto-probe.mjs
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const API = process.argv[2] || 'http://127.0.0.1:31567', PW = process.argv[3] || 'testnet';
const FORK = Number(process.env.FORK || 2050), BLOCKS = Number(process.env.NUMBLOCKS || 60);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const get = async p => (await fetch(API + p)).json();
const post = async (p, b) => (await (await fetch(API + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b), signal: AbortSignal.timeout(900000) })).text()).trim();

const KEY = '026f4b37dd5a125b678c67b8c89e519037a3be63214ccb34764ce03f03a8ac6793';
const SIG = 'c71cf3ba6ef9cdb67d994d1efc483525d869d4aee85d6805091d4e6e0c6fe061266842a9fee7db9ad8db895ae226c2446d24a3c7d460c87d7bb656b64a001746';
const MSG = '2a6d67ea9cb92d4f175163b4a056d7188807af7d818e14838a847f4141c81315';
const OTHER = '5f5047de06ed67ad654eff644f62541465ac8b3e2cbeb916f0e79a5d8521e24f';

function varint(n) { const t = []; let len = 0; for (;;) { t[len] = (n & 0x7f) | (len ? 0x80 : 0); if (n <= 0x7f) break; n = Math.floor(n / 128) - 1; len++; } return Buffer.from(t.reverse()); }
const str = s => Buffer.concat([varint(Buffer.byteLength(s)), Buffer.from(s, 'utf8')]);
const dict = o => { const ks = Object.keys(o).sort((a, b) => a.length - b.length || (a < b ? -1 : 1)); return Buffer.concat([Buffer.of(12), varint(ks.length), ...ks.flatMap(k => [str(k), o[k]])]).toString('hex'); };
const body = (msg, other) => dict({
  key: Buffer.concat([Buffer.of(6), str(KEY)]), pk: Buffer.concat([Buffer.of(10), Buffer.from(KEY, 'hex')]),
  sig: Buffer.concat([Buffer.of(9), Buffer.from(SIG, 'hex')]),
  msg: Buffer.concat([Buffer.of(7), Buffer.from(msg, 'hex')]), other: Buffer.concat([Buffer.of(7), Buffer.from(other, 'hex')]) });

const tip = (await get('/blockchain/info')).blocks;
if (tip < FORK) { console.error(`the testnet is at block ${tip}; V1 contracts can be activated from block ${FORK}`); process.exit(1); }
const code = readFileSync(new URL('../../contracts/v1/probes/CryptoProbe.fst', import.meta.url), 'utf8');
const be32 = Buffer.alloc(4); be32.writeUInt32BE(1);
const contractId = '00000001' + createHash('sha3-256').update(Buffer.concat([be32, Buffer.from(code, 'utf8')])).digest('hex');
const active = async () => (await get('/contract/active')).find(c => c.contractId === contractId);

if (!(await active())) {
  const a = JSON.parse(await post('/wallet/contract/activate', { code, numberOfBlocks: BLOCKS, password: PW, version: 1 }));
  if (!a.contractId) throw new Error('activation: ' + JSON.stringify(a).slice(0, 400));
  log(`CryptoProbe: activation sent (${contractId}, ${BLOCKS} blocks), waiting for its block`);
  for (let i = 0; !(await active()); i++) { if (i > 900) throw new Error('not active after an hour'); await sleep(4000); }
}
const c = await active();
log(`CryptoProbe active: ${c.address}`);
const call = b => post('/wallet/contract/execute', { address: c.address, command: 'probe', messageBody: b, options: { returnAddress: false }, spends: [], password: PW });
let failures = 0;
const right = await call(body(MSG, OTHER));
const okRight = /^"?[0-9a-f]{64}"?$/.test(right);
console.log(`${okRight ? 'PASS' : 'FAIL'}  right vector: parse, verify yes, verify other no, bad key refused -> ${okRight ? 'accepted, tx ' + right.replace(/"/g, '') : right.slice(0, 600)}`);
if (!okRight) failures++;
const swapped = await call(body(OTHER, MSG));
const okSwapped = /crypto check failed/.test(swapped);
console.log(`${okSwapped ? 'PASS' : 'FAIL'}  swapped vector refused -> ${swapped.slice(0, 300)}`);
if (!okSwapped) failures++;
console.log(failures ? `\n${failures} FAILED: do not activate zUSDC` : '\nboth passed: the node runs V1 Zen.Crypto (parsePublicKey, verify)');
process.exit(failures ? 1 : 0);
