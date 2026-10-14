// Tests of the V1 zUSDC token (contracts/v1/AuthenticatedSupply.fst) against the contract engine service: the node's own
// verdict (check) and calls run as a node runs them, with gas (try). Nothing is signed, sent or activated.
// The source tested is the one testnet-v1-zusdc.mjs activates: the bridge key (node wallet, m/44'/258'/0'/3/0)
// written into authenticatedPubKey, so the contract id printed here is the id that will be activated.
//
// usage: node scripts/v1/zusdc-try.mjs [engine url] [node api] [wallet password]
//        defaults: http://127.0.0.1:11580/engine, http://127.0.0.1:31567, testnet (the public test wallet)
//        env KEY=<66 hex>: use this key instead of asking the node wallet
// On the testnet server, from a zenprotocol checkout on node-upgrade-script:
//   docker run --rm --network host -v "$PWD":/b -w /b node:22-alpine node scripts/v1/zusdc-try.mjs
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const ENGINE = (process.argv[2] || 'http://127.0.0.1:11580/engine').replace(/\/$/, '');
const API = process.argv[3] || 'http://127.0.0.1:31567', PW = process.argv[4] || 'testnet';
const SIGN = "m/44'/258'/0'/3/0";
const sha3 = (...parts) => createHash('sha3-256').update(Buffer.concat(parts.map(p => typeof p === 'string' ? Buffer.from(p, 'hex') : p))).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const B = process.env.KEY || (await (await fetch(API + '/wallet/publickey', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: SIGN, password: PW }) })).text()).trim().replace(/"/g, '');
if (!/^0[23][0-9a-f]{64}$/.test(B)) { console.error('bridge key: ' + B.slice(0, 200)); process.exit(2); }
const template = readFileSync(new URL('../../contracts/v1/AuthenticatedSupply.fst', import.meta.url), 'utf8');
if (!template.includes('let authenticatedPubKey = ""')) { console.error('the template has no empty authenticatedPubKey'); process.exit(2); }
const source = template.replace('let authenticatedPubKey = ""', `let authenticatedPubKey = "${B}"`);
const be32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const contractHash = sha3(be32(1), Buffer.from(source, 'utf8'));

function varint(n) { const t = []; let len = 0; for (;;) { t[len] = (n & 0x7f) | (len ? 0x80 : 0); if (n <= 0x7f) break; n = Math.floor(n / 128) - 1; len++; } return Buffer.from(t.reverse()); }
const str = s => Buffer.concat([varint(Buffer.byteLength(s)), Buffer.from(s, 'utf8')]);
const D = {
  u64: n => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return Buffer.concat([Buffer.of(5), b]); },
  string: s => Buffer.concat([Buffer.of(6), str(s)]),
  pkLock: hash => Buffer.concat([Buffer.of(8), varint(2), varint(32), Buffer.from(hash, 'hex')]),
};
const dict = o => { const ks = Object.keys(o).sort((a, b) => Buffer.byteLength(a) - Buffer.byteLength(b) || Buffer.compare(Buffer.from(a), Buffer.from(b))); return Buffer.concat([Buffer.of(12), varint(ks.length), ...ks.flatMap(k => [str(k), o[k]])]).toString('hex'); };

const U = '03421f5fc9a21065445c96fdb91c0c1e2f2431741c72713b4b99ddcb316f31e9fc';   // a user (the engine families' example key)
const pkHash = k => sha3(k);
const isToken = a => typeof a === 'string' && a.toLowerCase().includes(contractHash) && !/[1-9a-f]/.test(a.toLowerCase().split(contractHash)[1] || '');

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
async function call(name, c, expect) {
  const s = await job('try', { sourceId: contractHash, call: { context: { blockNumber: 3000, timestamp: '1791900000000' }, wallet: [], ...c } });
  if (!s.try) { ok(name, false, 'no try in the answer: ' + JSON.stringify(s).slice(0, 400)); return null; }
  const r = s.try.result;
  costs[name] = `declared ${r.declaredCost}, used ${r.gasUsed}`;
  if (expect.info) { console.log(`INFO  ${name}: ok=${r.ok} ${r.ok ? '' : r.error}\n      inputs ${JSON.stringify(r.inputs)}\n      outputs ${JSON.stringify(r.outputs)}`); return s.try; }
  if (expect.error) ok(`${name}: refused with "${expect.error}"`, r.ok === false && r.error === expect.error, `got ok=${r.ok} error=${JSON.stringify(r.error)}`);
  else ok(`${name}: succeeds`, r.ok === true, `error: ${JSON.stringify(r.error)}`);
  if (expect.declared !== undefined) ok(`${name}: declared cost ${expect.declared}`, String(r.declaredCost) === String(expect.declared), costs[name]);
  if (r.ok) ok(`${name}: gas used = declared`, String(r.gasUsed) === String(r.declaredCost), costs[name]);
  if (r.ok && expect.check) for (const [what, f] of expect.check) ok(`${name}: ${what}`, !!f(r), JSON.stringify(r.outputs).slice(0, 600));
  return s.try;
}

console.log(`engine ${ENGINE}\nbridge key ${B}\ncontract: ${Buffer.byteLength(source)} bytes, id 00000001${contractHash}`);
const chk = await job('check', { source });
const c = chk.check || {};
ok('check: a node would accept it', c.verdict === 'accepted', `verdict ${c.verdict}; refusal ${JSON.stringify(c.refusal)}; node: ${c.nodeMessage}`);
ok('check: same contract id as computed here', (c.contractId || '').endsWith(contractHash), `engine says ${c.contractId}`);
ok('check: the engine runs the testnet toolchain', c.toolchain?.consensusFilesMatch === true, JSON.stringify(c.toolchain));
console.log(`      elaborated costs: ${JSON.stringify(c.costs)}; activation: ${JSON.stringify(c.activation)}`);
if (c.verdict !== 'accepted') { console.log('\nStopped: the node would refuse the contract.'); process.exit(1); }

const issueBody = dict({ Amount: D.u64(25000000), returnAddress: D.pkLock(pkHash(U)) });
await call('Issue by the bridge key', { command: 'Issue', sender: { publicKey: B }, bodyHex: issueBody }, {
  declared: 529,
  check: [['mints 25,000,000 of the token to returnAddress', r => (r.outputs || []).some(o => o.who?.kind === 'pk' && o.who.hash === pkHash(U) && isToken(o.asset) && String(o.amount) === '25000000')],
          ['nothing else is paid out', r => (r.outputs || []).length === 1]] });
await call('Issue by another key', { command: 'Issue', sender: { publicKey: U }, bodyHex: issueBody }, { error: 'Authentication failed', declared: 529 });
await call('Issue, anonymous', { command: 'Issue', bodyHex: issueBody }, { error: 'Sender must sign with Public Key' });
await call('Issue, Amount 0', { command: 'Issue', sender: { publicKey: B }, bodyHex: dict({ Amount: D.u64(0), returnAddress: D.pkLock(pkHash(U)) }) }, { error: 'Amount cannot be 0' });
await call('Issue, no Amount', { command: 'Issue', sender: { publicKey: B }, bodyHex: dict({ returnAddress: D.pkLock(pkHash(U)) }) }, { error: 'Message Body must include valid Amount' });
await call('Issue, no returnAddress', { command: 'Issue', sender: { publicKey: B }, bodyHex: dict({ Amount: D.u64(5) }) }, { error: 'Message Body must include valid returnAddress' });
await call('Issue, with coins in the wallet', { command: 'Issue', sender: { publicKey: B }, wallet: [{ asset: 'zp', amount: '5' }, { asset: 'zp', amount: '7' }], bodyHex: issueBody }, { declared: 529 });

await call('Destroy by the bridge key (1000 sent, 1000 destroyed)', { command: 'Destroy', sender: { publicKey: B }, spend: [{ asset: contractHash, amount: '1000' }], bodyHex: dict({ Amount: D.u64(1000) }) }, {
  declared: 381,
  check: [['1000 of the token to the destroy lock', r => (r.outputs || []).some(o => o.who?.kind === 'destroy' && isToken(o.asset) && String(o.amount) === '1000')]] });
await call('Destroy by another key', { command: 'Destroy', sender: { publicKey: U }, spend: [{ asset: contractHash, amount: '1000' }], bodyHex: dict({ Amount: D.u64(1000) }) }, { error: 'Authentication failed', declared: 381 });
await call('Destroy, Amount 0', { command: 'Destroy', sender: { publicKey: B }, bodyHex: dict({ Amount: D.u64(0) }) }, { error: 'Amount cannot be 0' });
await call('Unknown command', { command: 'Mint', sender: { publicKey: B }, bodyHex: issueBody }, { error: 'Invalid Command', declared: 7 });
// the contract does not compare Amount with what was sent: the node refuses the transaction (outputs above inputs)
await call('Destroy more than sent (500 sent, 1000 asked)', { command: 'Destroy', sender: { publicKey: B }, spend: [{ asset: contractHash, amount: '500' }], bodyHex: dict({ Amount: D.u64(1000) }) }, { info: true });

console.log(`\ncontract id 00000001${contractHash}\ncosts:`);
for (const [n, g] of Object.entries(costs)) console.log(`  ${n}: ${g}`);
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
