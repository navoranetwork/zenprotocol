// A node's verdict on a V1 contract source, from the contract engine service (zp-contracts-v1 docs/SERVICE.md):
// accepted or refused (rule, line, F*'s message), the contract id, and the elaborated costs per definition.
// Nothing is sent or activated.
//
// usage: node scripts/v1/check.mjs <contract.fst> [engine url]     (default http://127.0.0.1:11580/engine)
// On the testnet server: docker run --rm --network host -v "$PWD":/b -w /b node:22-alpine node scripts/v1/check.mjs contracts/v1/Dex.fst
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const FILE = process.argv[2], ENGINE = (process.argv[3] || 'http://127.0.0.1:11580/engine').replace(/\/$/, '');
if (!FILE) { console.error('usage: node scripts/v1/check.mjs <contract.fst> [engine url]'); process.exit(2); }
const source = readFileSync(FILE, 'utf8');
const be32 = Buffer.alloc(4); be32.writeUInt32BE(1);
const id = '00000001' + createHash('sha3-256').update(Buffer.concat([be32, Buffer.from(source, 'utf8')])).digest('hex');
const r = await fetch(`${ENGINE}/check`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source }) });
const j = await r.json().catch(() => ({}));
if (r.status !== 202) { console.error(`check: HTTP ${r.status} ${JSON.stringify(j).slice(0, 300)}`); process.exit(2); }
let s;
for (let i = 0; i < 300; i++) {
  await new Promise(res => setTimeout(res, i < 5 ? 1000 : 2000));
  s = await (await fetch(`${ENGINE}/job/${j.job}`)).json();
  if (s.status === 'done' || s.status === 'failed' || s.status === 'timeout') break;
}
const c = s.check || {};
console.log(`${FILE}: ${Buffer.byteLength(source)} bytes, id ${id}${c.contractId && c.contractId !== id ? ` (engine says ${c.contractId})` : ''}`);
console.log(`verdict: ${c.verdict ?? s.status}${s.error ? ' ' + s.error : ''}`);
if (c.refusal) console.log(`refusal: ${c.refusal.section} ${c.refusal.title}, line ${c.refusal.line}: ${c.refusal.code}\nnode: ${c.nodeMessage}`);
console.log(`elaborated costs: ${JSON.stringify(c.costs ?? {})}`);
process.exit(c.verdict === 'accepted' ? 0 : 1);
