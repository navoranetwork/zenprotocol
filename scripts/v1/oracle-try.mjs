// Tests of the V1 Oracle (contracts/v1/Oracle.fst) against the contract engine service: the node's own verdict
// (check) and calls run as a node runs them, with gas (try). Nothing is signed, sent or activated.
//
// usage: node scripts/v1/oracle-try.mjs [engine url] [contract file]
//        defaults: http://127.0.0.1:11580/engine (the engine container on the testnet server), contracts/v1/Oracle.fst
// Node 18+, no packages. On the testnet server (no Node.js there), from the zenprotocol checkout:
//   docker run --rm --network host -v "$PWD":/b -w /b node:22-alpine node scripts/v1/oracle-try.mjs
// Exit 0 when every test passes. The last lines print the contract id and the costs measured.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const ENGINE = (process.argv[2] || 'http://127.0.0.1:11580/engine').replace(/\/$/, '');
const FILE = process.argv[3] || new URL('../../contracts/v1/Oracle.fst', import.meta.url).pathname;
const source = readFileSync(FILE, 'utf8');
const sha3 = (...parts) => createHash('sha3-256').update(Buffer.concat(parts.map(p => typeof p === 'string' ? Buffer.from(p, 'hex') : p))).digest('hex');
const be32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const contractHash = sha3(be32(1), Buffer.from(source, 'utf8'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- message bodies, serialized as the node does (Zen Data, dictionary keys by length then bytes) ---
function varint(n) { const t = []; let len = 0; for (;;) { t[len] = (n & 0x7f) | (len ? 0x80 : 0); if (n <= 0x7f) break; n = Math.floor(n / 128) - 1; len++; } return Buffer.from(t.reverse()); }
const str = s => Buffer.concat([varint(Buffer.byteLength(s)), Buffer.from(s, 'utf8')]);
const D = {
  hash: h => Buffer.concat([Buffer.of(7), Buffer.from(h, 'hex')]),
  publicKey: k => Buffer.concat([Buffer.of(10), Buffer.from(k, 'hex')]),           // compressed, 33 bytes
  u64: n => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return Buffer.concat([Buffer.of(5), b]); },
  string: s => Buffer.concat([Buffer.of(6), str(s)]),
  pkLock: hash => Buffer.concat([Buffer.of(8), varint(2), varint(32), Buffer.from(hash, 'hex')]),
};
function dict(o) {
  const keys = Object.keys(o).sort((a, b) => Buffer.byteLength(a) - Buffer.byteLength(b) || Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return Buffer.concat([Buffer.of(12), varint(keys.length), ...keys.flatMap(k => [str(k), o[k]])]).toString('hex');
}

// --- keys (the engine families' example keys; public, test only) and the values V0 derives ---
const K = '03774ae7f858a9411e5ef4246b70c65aac5649980be5c17891bbec17895da008cb';   // the oracle
const U = '03421f5fc9a21065445c96fdb91c0c1e2f2431741c72713b4b99ddcb316f31e9fc';   // a user who attests
const R = '021697ffa6fd9de627c077e3d2fe541084ce13300b0bec1146f95ae57f0d0bd6a5';   // another recipient
const pkHash = k => sha3(k);                                     // a PKLock: SHA3 of the compressed key
const H = sha3(Buffer.from('navora oracle v1 test commitment'));  // a commitment (the service sends SHA3(root ‖ timestamp))
const C0 = sha3(H, K);                                           // commitment token subtype, no fee: SHA3(commit ‖ cpk)
const A = sha3(sha3(H, K));                                      // attestation token subtype (FixedPayout computes the same)
const tok = sub => `${contractHash}:${sub}`;

// --- the engine service ---
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
const assetIs = (a, sub) => typeof a === 'string' && a.toLowerCase().endsWith(sub) && a.toLowerCase().includes(contractHash);
const outTo = (res, kind, hash, pred) => (res.outputs || []).find(o => o.who?.kind === kind && (hash === null || o.who.hash === hash) && pred(o));

async function call(name, c, expect) {
  const s = await job('try', { sourceId: contractHash, call: { context: { blockNumber: 3000, timestamp: '1791900000000' }, wallet: [], ...c } });
  if (!s.try) { ok(name, false, 'no try in the answer: ' + JSON.stringify(s).slice(0, 400)); return null; }
  const r = s.try.result;
  const gas = `declared ${r.declaredCost}, used ${r.gasUsed}`;
  costs[name] = gas;
  if (expect.error) {
    ok(`${name}: refused with "${expect.error}"`, r.ok === false && r.error === expect.error, `got ok=${r.ok} error=${JSON.stringify(r.error)}`);
  } else {
    ok(`${name}: succeeds`, r.ok === true, `error: ${JSON.stringify(r.error)}`);
  }
  if (expect.declared !== undefined) ok(`${name}: declared cost ${expect.declared}`, String(r.declaredCost) === String(expect.declared), gas);
  if (r.ok) ok(`${name}: gas used = declared`, String(r.gasUsed) === String(r.declaredCost), gas);
  if (r.ok && expect.check) for (const [what, f] of expect.check) ok(`${name}: ${what}`, !!f(r, s.try), JSON.stringify(r.outputs).slice(0, 600));
  return s.try;
}

// 1. a node's verdict
console.log(`engine ${ENGINE}\ncontract ${FILE}: ${Buffer.byteLength(source)} bytes, id 00000001${contractHash}`);
const chk = await job('check', { source });
const c = chk.check || {};
ok('check: a node would accept it', c.verdict === 'accepted', `verdict ${c.verdict}; refusal ${JSON.stringify(c.refusal)}; node: ${c.nodeMessage}`);
ok('check: same contract id as computed here', (c.contractId || '').endsWith(contractHash), `engine says ${c.contractId}`);
ok('check: the engine runs the testnet toolchain', c.toolchain?.consensusFilesMatch === true, JSON.stringify(c.toolchain));
if (c.verdict !== 'accepted') { console.log(`      elaborated costs: ${JSON.stringify(c.costs)}`); console.log('\nStopped: the node would refuse the contract.'); process.exit(1); }
console.log(`      elaborated costs: ${JSON.stringify(c.costs)}; activation: ${JSON.stringify(c.activation)}`);

// 2. Commit
const commit1 = await call('Commit by the oracle', { command: 'Commit', sender: { publicKey: K }, bodyHex: dict({ Commit: D.hash(H) }) }, {
  declared: 2650,
  check: [['mints one commitment token SHA3(commit ‖ cpk) and keeps it in the contract',
    r => outTo(r, 'contract', contractHash, o => assetIs(o.asset, C0) && String(o.amount) === '1')]] });
await call('Commit, anonymous', { command: 'Commit', bodyHex: dict({ Commit: D.hash(H) }) }, { error: 'Sender must be a public key' });
await call('Commit, no body', { command: 'Commit', sender: { publicKey: K } }, { error: 'Data parsing failed - the message body is empty' });
await call('Commit, Commit not a hash', { command: 'Commit', sender: { publicKey: K }, bodyHex: dict({ Commit: D.string('x') }) }, { error: 'Commit must be an hash' });
const commitFee = await call('Commit with a fee of 1000 kalapas', { command: 'Commit', sender: { publicKey: K }, bodyHex: dict({ Commit: D.hash(H), FeeAmount: D.u64(1000) }) }, {
  declared: 2650,
  check: [['its commitment token differs from the one without a fee',
    r => outTo(r, 'contract', contractHash, o => typeof o.asset === 'string' && o.asset.includes(contractHash) && !assetIs(o.asset, C0))]] });
await call('Commit, FeeAsset "00" (ZP) with a fee', { command: 'Commit', sender: { publicKey: K }, bodyHex: dict({ Commit: D.hash(H), FeeAsset: D.string('00'), FeeAmount: D.u64(1000) }) }, { declared: 2650 });
await call('Commit, FeeAsset a token id (not in V1)', { command: 'Commit', sender: { publicKey: K }, bodyHex: dict({ Commit: D.hash(H), FeeAsset: D.string('00000001' + contractHash), FeeAmount: D.u64(1000) }) }, { error: 'Invalid FeeAsset - failed to parse asset string' });
await call('Unknown command', { command: 'Add', sender: { publicKey: K }, bodyHex: dict({ Commit: D.hash(H) }) }, { error: 'Command not recognized', declared: 8 });

// 3. Attest
const w1 = commit1?.next?.wallet || [];
const wFee = commitFee?.next?.wallet || [];
const att = { Commit: D.hash(H), OraclePubKey: D.publicKey(K) };
await call('Attest to the sender', { command: 'Attest', sender: { publicKey: U }, wallet: w1, bodyHex: dict(att) }, {
  declared: 5081 + 128,
  check: [['mints one attestation token SHA3(SHA3(commit ‖ cpk)) to the sender', r => outTo(r, 'pk', pkHash(U), o => assetIs(o.asset, A) && String(o.amount) === '1')],
          ['the commitment token goes back to the contract', r => outTo(r, 'contract', contractHash, o => assetIs(o.asset, C0) && String(o.amount) === '1')]] });
await call('Attest to a Recipient', { command: 'Attest', sender: { publicKey: U }, wallet: w1, bodyHex: dict({ ...att, Recipient: D.pkLock(pkHash(R)) }) }, {
  check: [['the attestation token goes to the Recipient', r => outTo(r, 'pk', pkHash(R), o => assetIs(o.asset, A))]] });
await call('Attest, nothing committed', { command: 'Attest', sender: { publicKey: U }, bodyHex: dict(att) }, { error: "Data wasn't committed", declared: 5081 });
await call('Attest, another oracle key', { command: 'Attest', sender: { publicKey: U }, wallet: w1, bodyHex: dict({ ...att, OraclePubKey: D.publicKey(U) }) }, { error: "Data wasn't committed" });
await call('Attest, anonymous without Recipient', { command: 'Attest', wallet: w1, bodyHex: dict(att) }, { error: "When the recipient is unspecified the sender can't be anonymous" });
await call('Attest, no OraclePubKey', { command: 'Attest', sender: { publicKey: U }, wallet: w1, bodyHex: dict({ Commit: D.hash(H) }) }, { error: "Couldn't find OraclePubKey in message body" });
const attFee = { ...att, FeeAmount: D.u64(1000) };
await call('Attest with the fee paid (1500 sent, 1000 fee)', { command: 'Attest', sender: { publicKey: U }, wallet: wFee, spend: [{ asset: 'zp', amount: '1500' }], bodyHex: dict(attFee) }, {
  check: [['1000 kalapas to the oracle key', r => outTo(r, 'pk', pkHash(K), o => o.asset === 'zp' && String(o.amount) === '1000')],
          ['500 kalapas change to the sender', r => outTo(r, 'pk', pkHash(U), o => o.asset === 'zp' && String(o.amount) === '500')],
          ['the attestation token to the sender', r => outTo(r, 'pk', pkHash(U), o => assetIs(o.asset, A))]] });
await call('Attest with too small a fee (900 sent)', { command: 'Attest', sender: { publicKey: U }, wallet: wFee, spend: [{ asset: 'zp', amount: '900' }], bodyHex: dict(attFee) }, { error: 'Insufficient oracle fee' });

// 4. cost with a bigger wallet: Attest grows by 128 per coin, Commit does not
const w3 = [...w1, ...wFee.filter(x => !w1.some(y => y.asset === x.asset)), { asset: 'zp', amount: '5' }];
await call(`Attest with ${w3.length} coins in the wallet`, { command: 'Attest', sender: { publicKey: U }, wallet: w3, bodyHex: dict(att) }, { declared: 5081 + 128 * w3.length });
await call(`Commit with ${w3.length} coins in the wallet`, { command: 'Commit', sender: { publicKey: K }, wallet: w3, bodyHex: dict({ Commit: D.hash(sha3(H, H)) }) }, { declared: 2650 });

console.log(`\ncontract id 00000001${contractHash}\ncosts:`);
for (const [n, g] of Object.entries(costs)) console.log(`  ${n}: ${g}`);
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
