// Checks with the contract engine, before FixedPayout is ported to V1, that a V1 contract proves an oracle price as
// FixedPayout does (contracts/v1/probes/MerkleProbe.fst): a node's verdict on the probe, then two tries with a real
// round of the oracle service: the real proof (must pass) and the same proof against another root (must be refused,
// "merkle check failed"). Needs a node image whose Zulib V1 realizes Zen.MerkleTree (not 87b24e2: the check refuses
// the probe under rule 4.9 until then, and says so).
//
// usage: node scripts/v1/merkle-probe.mjs [engine url]      env: ORACLE (http://127.0.0.1:8085), TICKER (BTC),
//        ORACLE_ID (the V1 Oracle contract id on the testnet)
// On the testnet server, from a zenprotocol checkout on node-upgrade-script:
//   docker run --rm --network host -v "$PWD":/b -w /b node:22-alpine node scripts/v1/merkle-probe.mjs
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const ENGINE = (process.argv[2] || 'http://127.0.0.1:11580/engine').replace(/\/$/, '');
const ORACLE = (process.env.ORACLE || 'http://127.0.0.1:8085').replace(/\/$/, ''), TICKER = process.env.TICKER || 'BTC';
const ORACLE_ID = process.env.ORACLE_ID || '00000001cbcf4ef46cab8303e10d994d06b1820c348e276a7be9edfc7653fefbb9acd741';
const source = readFileSync(new URL('../../contracts/v1/probes/MerkleProbe.fst', import.meta.url), 'utf8');
const be32 = Buffer.alloc(4); be32.writeUInt32BE(1);
const contractHash = createHash('sha3-256').update(Buffer.concat([be32, Buffer.from(source, 'utf8')])).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// message body, serialized as the node does (Zen Data; dictionary keys by length, then bytes)
function varint(n) { const t = []; let len = 0; for (;;) { t[len] = (n & 0x7f) | (len ? 0x80 : 0); if (n <= 0x7f) break; n = Math.floor(n / 128) - 1; len++; } return Buffer.from(t.reverse()); }
const str = s => Buffer.concat([varint(Buffer.byteLength(s)), Buffer.from(s, 'utf8')]);
const D = {
  hash: h => Buffer.concat([Buffer.of(7), Buffer.from(h, 'hex')]),
  u64: n => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return Buffer.concat([Buffer.of(5), b]); },
  string: s => Buffer.concat([Buffer.of(6), str(s)]),
  list: items => Buffer.concat([Buffer.of(13), varint(items.length), ...items]),
};
function dict(o) {
  const keys = Object.keys(o).sort((a, b) => Buffer.byteLength(a) - Buffer.byteLength(b) || Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return Buffer.concat([Buffer.of(12), varint(keys.length), ...keys.flatMap(k => [str(k), o[k]])]).toString('hex');
}

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
const ok = (name, cond, detail) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : '\n      ' + detail}`); if (!cond) failures++; };

// a real round of the oracle service
const p = await (await fetch(`${ORACLE}/auditpath?ticker=${encodeURIComponent(TICKER)}`)).json();
if (!p || !p.root || !Array.isArray(p.auditPath)) { console.error('oracle /auditpath: ' + JSON.stringify(p).slice(0, 300)); process.exit(2); }
console.log(`oracle round ${p.timestamp}: ${TICKER} = ${p.valueScaled} / 1000, index ${p.index}, path of ${p.auditPath.length}, root ${p.root}`);
const body = root => dict({ ticker: D.string(TICKER), value: D.u64(p.valueScaled), root: D.hash(root), path: D.list(p.auditPath.map(D.hash)),
  index: D.u64(p.index), oracle: D.string(ORACLE_ID) });

console.log(`engine ${ENGINE}\nMerkleProbe.fst: ${Buffer.byteLength(source)} bytes, id 00000001${contractHash}`);
const chk = (await job('check', { source })).check || {};
ok('check: a node would accept the probe', chk.verdict === 'accepted', `verdict ${chk.verdict}; refusal ${JSON.stringify(chk.refusal)}; node: ${chk.nodeMessage}`);
if (chk.verdict !== 'accepted') { console.log('\nStopped: Zen.MerkleTree is not realized in this toolchain yet, or the probe has an error (above).'); process.exit(1); }

async function tryIt(name, root, expectOk) {
  const s = await job('try', { sourceId: contractHash, call: { command: 'probe', context: { blockNumber: 3000, timestamp: '1791900000000' }, wallet: [], bodyHex: body(root) } });
  const r = s.try?.result || {};
  ok(name, expectOk ? r.ok === true : r.ok === false && r.error === 'merkle check failed', `ok=${r.ok} error=${JSON.stringify(r.error)}; declared ${r.declaredCost}, used ${r.gasUsed}`);
  if (r.ok) console.log(`      gas used ${r.gasUsed} (declared ${r.declaredCost})`);
}
await tryIt(`the real ${TICKER} proof verifies (and value + 1 does not, and the oracle id parses)`, p.root, true);
const otherRoot = p.root.slice(0, -2) + (p.root.endsWith('00') ? '01' : '00');
await tryIt('the same proof against another root is refused', otherRoot, false);
console.log(failures ? `\n${failures} FAILED` : '\nall passed: V1 contracts can prove oracle prices as FixedPayout does');
process.exit(failures ? 1 : 0);
